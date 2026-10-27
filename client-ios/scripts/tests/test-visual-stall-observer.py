#!/usr/bin/env python3
"""Exercise the observer's subprocess boundary without Xcode or production services."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import selectors
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'observe-visual-stalls.py'
spec = importlib.util.spec_from_file_location('observer', SCRIPT)
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)
UDID = '00000000-0000-0000-0000-000000000001'


class ObserverTests(unittest.TestCase):
    def command(self, folder, code):
        return [sys.executable, str(SCRIPT), '--udid', UDID, '--profile', 'iphone-light',
                '--output', folder, '--', sys.executable, '-u', '-c', code]

    def test_preserves_output_nonzero_status_and_two_capture_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            code = f'import time; print({observer.WARNING!r}); print({observer.WARNING!r}); print({observer.WARNING!r}); time.sleep(.3); raise SystemExit(7)'
            result = subprocess.run(self.command(folder, code), capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 7)
            self.assertEqual(result.stdout.count(observer.WARNING), 3)
            root, = Path(folder).iterdir()
            self.assertEqual((root / 'xcodebuild.log').read_text(), result.stdout)
            self.assertEqual(len(list(root.glob('sample-*/sample.json'))), 2)

    def test_forwards_termination_and_preserves_child_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            code = 'import signal,time,sys; signal.signal(signal.SIGTERM, lambda *_: sys.exit(23)); print("ready", flush=True); time.sleep(30)'
            process = subprocess.Popen(self.command(folder, code), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(process.stdout.readline(), 'ready\n')
                process.send_signal(signal.SIGTERM)
                process.communicate(timeout=5)
                self.assertEqual(process.returncode, 23)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_streams_partial_utf8_output_and_can_terminate_without_another_line(self):
        with tempfile.TemporaryDirectory() as folder:
            child_pid = Path(folder) / 'child.pid'
            output = Path(folder) / 'output'
            expected = 'неполная строка'.encode()
            code = (f'import os,signal,time,sys; from pathlib import Path; '
                    f'Path({str(child_pid)!r}).write_text(str(os.getpid())); '
                    'signal.signal(signal.SIGTERM, lambda *_: sys.exit(23)); '
                    f'os.write(1, {expected[:1]!r}); time.sleep(.05); '
                    f'os.write(1, {expected[1:]!r}); time.sleep(30)')
            process = subprocess.Popen(self.command(str(output), code),
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                received = b''
                deadline = time.monotonic() + 2
                with selectors.DefaultSelector() as readable:
                    readable.register(process.stdout, selectors.EVENT_READ)
                    while len(received) < len(expected) and time.monotonic() < deadline:
                        if readable.select(timeout=.1):
                            chunk = os.read(process.stdout.fileno(), 4096)
                            if not chunk:
                                break
                            received += chunk
                self.assertEqual(received, expected, 'Partial output must not wait for a newline or child exit')
                process.send_signal(signal.SIGTERM)
                remainder, errors = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 23, errors.decode())
                self.assertEqual(received + remainder, expected)
                root, = output.iterdir()
                self.assertEqual((root / 'xcodebuild.log').read_bytes(), expected)
            finally:
                # The fixture owns this exact process group, even if the observer is still blocked.
                if child_pid.exists():
                    try:
                        os.killpg(int(child_pid.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=3)

    def test_log_failure_terminates_and_reaps_detached_child(self):
        real_popen = subprocess.Popen
        children = []

        def start_ready_child(command, **kwargs):
            process = real_popen(command, **kwargs)
            children.append(process)
            self.assertEqual(process.stdout.readline(), 'ready\n')
            return process

        with tempfile.TemporaryDirectory() as folder:
            # A deterministic I/O exception after Popen, with a child that ignores TERM.
            (Path(folder) / 'xcodebuild.log').mkdir()
            command = [sys.executable, '-u', '-c',
                       'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("ready"); time.sleep(30)']
            try:
                with patch.object(observer.subprocess, 'Popen', side_effect=start_ready_child):
                    with self.assertRaises(IsADirectoryError):
                        observer.observe(command, UDID, Path(folder))
                self.assertEqual(len(children), 1)
                self.assertEqual(children[0].returncode, -signal.SIGKILL)
                with self.assertRaises(ChildProcessError):
                    os.waitpid(children[0].pid, os.WNOHANG)
            finally:
                for child in children:
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=3)
                    child.stdout.close()

    def test_completion_stops_and_reaps_sample_worker(self):
        real_popen = subprocess.Popen
        processes = []

        def fake_sample(command, **kwargs):
            self.assertEqual(command[:4], ['/usr/bin/sample', '123', '1', '10'])
            process = real_popen([sys.executable, '-c', 'import time; time.sleep(30)'], **kwargs)
            processes.append(process)
            return process

        with tempfile.TemporaryDirectory() as folder, patch.object(observer, 'app_pid', return_value=123), \
                patch.object(observer.Path, 'is_file', return_value=True), \
                patch.object(observer.subprocess, 'Popen', side_effect=fake_sample):
            stop = threading.Event()
            worker = threading.Thread(target=observer.collect, args=(Path(folder), UDID, ['action'], stop))
            worker.start()
            deadline = time.monotonic() + 2
            while not processes and time.monotonic() < deadline:
                time.sleep(.01)
            stop.set()
            worker.join(timeout=3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(len(processes), 1)
            self.assertIsNotNone(processes[0].returncode)
            self.assertEqual(json.loads((Path(folder) / 'sample.json').read_text())['stopped'], 'test-completed')

    def test_blocked_sampler_observes_owned_pid_and_reaps_both_with_common_bound(self):
        real_popen = subprocess.Popen
        for stop_after in (None, 4.5):
            with self.subTest(stop_after=stop_after), tempfile.TemporaryDirectory() as folder:
                processes, commands, started = [], [], []
                stop = threading.Event()

                def fake_sample(command, **kwargs):
                    commands.append(command)
                    started.append(time.monotonic())
                    process = real_popen([sys.executable, '-u', '-c',
                        'import sys,time; print("Sampling process", file=sys.stderr); time.sleep(30)'], **kwargs)
                    processes.append(process)
                    return process

                timer = threading.Timer(stop_after, stop.set) if stop_after else None
                try:
                    if timer:
                        timer.start()
                    before = time.monotonic()
                    with patch.object(observer, 'app_pid', return_value=123), \
                            patch.object(observer.Path, 'is_file', return_value=True), \
                            patch.object(observer.subprocess, 'Popen', side_effect=fake_sample):
                        observer.collect(Path(folder), UDID, ['action'], stop)
                    elapsed = time.monotonic() - before
                    self.assertEqual(len(processes), 2)
                    self.assertEqual(commands[1][:4], ['/usr/bin/sample', str(processes[0].pid), '1', '10'])
                    self.assertEqual(Path(commands[1][-1]).name, 'sampler-threads.txt')
                    self.assertGreaterEqual(started[1] - started[0], 4)
                    self.assertLess(elapsed, (stop_after or 8) + 1.5)
                    for process in processes:
                        self.assertIsNotNone(process.returncode)
                        with self.assertRaises(ChildProcessError):
                            os.waitpid(process.pid, os.WNOHANG)
                    metadata = json.loads((Path(folder) / 'sample.json').read_text())
                    self.assertEqual(metadata['stopped'], 'test-completed' if stop_after else '8-second-limit')
                    self.assertIn('Sampling process', metadata['primaryStderrAtSecondary'])
                finally:
                    if timer:
                        timer.cancel()
                        timer.join()
                    for process in processes:
                        if process.poll() is None:
                            process.kill()
                            process.communicate()


if __name__ == '__main__':
    unittest.main()
