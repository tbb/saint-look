#!/usr/bin/env python3
"""Observe local visual XCTest stalls without retrying or changing the test verdict."""
import argparse
import ctypes
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import uuid

WARNING = 'App event loop idle notification not received, will attempt to continue.'
PROFILES = ('iphone-light', 'iphone-dark', 'iphone-max-text', 'ipad-light')


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def app_pid(udid):
    """Validate the executable itself, not an argv string or a similarly named runner."""
    if sys.platform != 'darwin':
        raise RuntimeError('macOS process sampling is unavailable')
    library = ctypes.CDLL('/usr/lib/libproc.dylib')
    library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    library.proc_pidpath.restype = ctypes.c_int
    lookup = subprocess.run(['/usr/bin/pgrep', '-x', 'SaintLook'], capture_output=True,
                            text=True, timeout=2, check=False)
    matches = []
    for token in lookup.stdout.split():
        pid = int(token)
        path = ctypes.create_string_buffer(4096)
        if library.proc_pidpath(pid, path, len(path)) > 0:
            executable = os.fsdecode(path.value)
            if (f'/CoreSimulator/Devices/{udid}/' in executable
                    and executable.endswith('/SaintLook.app/SaintLook')):
                matches.append(pid)
    if len(matches) != 1:
        raise RuntimeError(f'Expected one app executable in selected Simulator; found {len(matches)}')
    return matches[0]


def collect(folder, udid, context, stop):
    metadata = dict(utc=utc(), simulatorUDID=udid, context=context)
    samples = []
    try:
        if stop.is_set():
            raise RuntimeError('Test already completed; sampling skipped')
        if not Path('/usr/bin/sample').is_file():
            raise RuntimeError('macOS sample CLI is unavailable')
        pid = app_pid(udid)
        metadata['pid'] = pid
        if stop.is_set():
            raise RuntimeError('Test completed during process lookup; sampling skipped')
        metadata['startedUTC'] = utc()
        primary = subprocess.Popen(['/usr/bin/sample', str(pid), '1', '10', '-file', str(folder / 'threads.txt')],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        samples.append((primary, metadata))
        started = time.monotonic()
        deadline = started + 8
        while True:
            now = time.monotonic()
            if stop.is_set() or now >= deadline:
                metadata['stopped'] = 'test-completed' if stop.is_set() else '8-second-limit'
                metadata['stoppedUTC'] = utc()
                for process, _ in samples:
                    if process.poll() is None:
                        process.kill()
            elif len(samples) == 1 and now - started >= 4 and primary.poll() is None:
                # One observation of our own blocked sampler, sharing the original deadline.
                metadata['primaryStderrAtSecondary'] = metadata.get('stderr', '')
                secondary_metadata = dict(startedUTC=utc(), targetPID=primary.pid)
                metadata['sampler'] = secondary_metadata
                secondary = subprocess.Popen(['/usr/bin/sample', str(primary.pid), '1', '10', '-file',
                                               str(folder / 'sampler-threads.txt')],
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                samples.append((secondary, secondary_metadata))
            for process, details in samples:
                if 'exitStatus' in details:
                    continue
                try:
                    stdout, stderr = process.communicate(timeout=0.05)
                    details.update(exitStatus=process.returncode, stdout=stdout, stderr=stderr, finishedUTC=utc())
                except subprocess.TimeoutExpired as error:
                    partial = error.stderr or b''
                    details['stderr'] = partial.decode(errors='replace') if isinstance(partial, bytes) else partial
            if all('exitStatus' in details for _, details in samples):
                break
    except Exception as error:
        metadata['diagnosticMiss'] = str(error)
    finally:
        for process, details in samples:
            if process.poll() is None:
                process.kill()
                stdout, stderr = process.communicate()
                details.update(exitStatus=process.returncode, stdout=stdout, stderr=stderr, finishedUTC=utc())
        metadata['finishedUTC'] = utc()
        (folder / 'sample.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')


def observe(command, udid, folder):
    stop = threading.Event()
    workers = []
    context = []
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, bufsize=1, start_new_session=True)
    previous_handlers = {}

    def forward(signum, _frame):
        stop.set()
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.signal(signum, forward)
    try:
        with (folder / 'xcodebuild.log').open('w') as log:
            for line in process.stdout:
                sys.stdout.write(line)
                sys.stdout.flush()
                log.write(line)
                log.flush()
                context = (context + [line.rstrip()])[-20:]
                if WARNING in line and len(workers) < 2 and not stop.is_set():
                    capture = folder / f'sample-{len(workers) + 1}'
                    capture.mkdir()
                    worker = threading.Thread(target=collect, args=(capture, udid, context[:], stop))
                    worker.start()
                    workers.append(worker)
        status = process.wait()
    finally:
        stop.set()
        try:
            # I/O/decoding/output errors must not leave the detached test command running.
            # Normal completion has already reaped it and does not enter this branch.
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=2)
        finally:
            process.stdout.close()
            for worker in workers:
                worker.join()  # Discovery <=2s, sample <=8s; stop also kills an active sample.
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)
    return status if status >= 0 else 128 - status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--udid', required=True)
    parser.add_argument('--profile', required=True, choices=PROFILES)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    uuid.UUID(args.udid)
    if os.environ.get('SAINT_LOOK_REMOTE_SMOKE') == '1' or os.environ.get('SAINT_LOOK_LIVE_TRIAL') == '1':
        parser.error('Sampling is limited to local visual fixtures')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('A test command is required')
    folder = args.output / (args.profile + '-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    folder.mkdir(parents=True)
    return observe(command, args.udid, folder)


if __name__ == '__main__':
    sys.exit(main())
