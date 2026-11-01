#!/usr/bin/env python3
"""Bound a local XCTest process and retain per-case timings, without retries."""
import argparse
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

CASE = re.compile(r"Test Case '([^']+)' (started|passed|failed|skipped)(?: \(([0-9.]+) seconds\))?")


def run(command, summary, idle_seconds=180, case_seconds=600, startup_seconds=300):
    started = last_output = time.monotonic()
    active, case_started, completed, reason = None, None, [], None
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    poller = selectors.DefaultSelector()
    poller.register(process.stdout, selectors.EVENT_READ)
    buffer = b''
    interrupted = None

    def interrupt(number, _frame):
        nonlocal interrupted
        interrupted = number

    previous = {number: signal.signal(number, interrupt) for number in (signal.SIGTERM, signal.SIGINT)}
    try:
        while True:
            now = time.monotonic()
            if interrupted:
                reason = 'cancelled'
                break
            if now - last_output > idle_seconds:
                reason = 'no-output'
                break
            if case_started is not None and now - case_started > case_seconds:
                reason = 'test-deadline'
                break
            if not completed and case_started is None and now - started > startup_seconds:
                reason = 'startup-deadline'
                break
            events = poller.select(timeout=0.1)
            for key, _ in events:
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    poller.unregister(key.fileobj)
                    continue
                last_output = time.monotonic()
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                buffer += chunk
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    match = CASE.search(line.decode('utf-8', errors='replace'))
                    if match:
                        name, state, duration = match.groups()
                        if state == 'started':
                            active, case_started = name, time.monotonic()
                        else:
                            completed.append(dict(test=name, result=state, seconds=float(duration or 0)))
                            active, case_started = None, None
                # A child emitting an unbroken line must not grow memory without bound.
                buffer = buffer[-65536:]
            if process.poll() is not None and not poller.get_map():
                break
        if reason:
            print(f'\nUI watchdog: {reason}; active test: {active or "none"}. No retry.', flush=True)
            # XCTest and its helper must not survive cancellation or a stalled pipe.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        code = (128 + interrupted) if interrupted else (124 if reason else process.returncode)
        if code < 0:
            code = 128 - code
        if code == 0 and not completed:
            code, reason = 1, 'no-test-results'
        summary.parent.mkdir(parents=True, exist_ok=True)
        summary.write_text(json.dumps(dict(exitCode=code, reason=reason, activeTest=active,
                                          elapsedSeconds=round(time.monotonic() - started, 2), tests=completed), indent=2) + '\n')
        return code
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        poller.close()
        process.stdout.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--summary', type=Path, required=True)
    parser.add_argument('--idle-seconds', type=float, default=180)
    parser.add_argument('--case-seconds', type=float, default=600)
    parser.add_argument('--startup-seconds', type=float, default=300)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or min(args.idle_seconds, args.case_seconds, args.startup_seconds) <= 0:
        parser.error('Provide a command and positive deadlines')
    sys.exit(run(command, args.summary, args.idle_seconds, args.case_seconds, args.startup_seconds))
