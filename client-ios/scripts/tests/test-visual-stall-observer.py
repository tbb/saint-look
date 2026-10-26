#!/usr/bin/env python3
"""Exercise the observer's subprocess boundary without Xcode or production services."""
import importlib.util
import json
import os
from pathlib import Path
import signal
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
            self.assertEqual(command[:4], ['/usr/bin/sample', '123', '3', '10'])
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


if __name__ == '__main__':
    unittest.main()
