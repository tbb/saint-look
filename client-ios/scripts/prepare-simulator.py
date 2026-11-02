#!/usr/bin/env python3
"""Overlap local Simulator boot and compilation, then require both before XCTest."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid


def prepare(udid, command, summary_path, timeout):
    started = time.monotonic()
    processes, phases = {}, {}
    exit_code, reason = 1, 'startup-error'
    interrupted_number = None

    def interrupted(number, _frame):
        nonlocal interrupted_number
        interrupted_number = number

    previous_handlers = {number: signal.signal(number, interrupted) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        # boot may return nonzero for an already booted device. bootstatus remains
        # authoritative, exactly as in the existing serial runner. UDID is argv,
        # never interpolated into shell source.
        boot = ['bash', '-c', 'xcrun simctl boot "$1" 2>/dev/null || true\nexec xcrun simctl bootstatus "$1" -b',
                'simulator-boot', udid]
        for name, args in [('boot', boot), ('build', command)]:
            if interrupted_number is not None:
                break
            phases[name] = {'startedSeconds': round(time.monotonic() - started, 3), 'exitCode': None}
            processes[name] = subprocess.Popen(args, start_new_session=True)
            print(f'SIMULATOR_STARTUP {name} started', flush=True)
        pending = set(processes)
        while True:
            if interrupted_number is not None:
                exit_code, reason = 128 + interrupted_number, 'signal-' + signal.Signals(interrupted_number).name
                return exit_code
            if not pending:
                exit_code, reason = 0, None
                return exit_code
            for name in sorted(pending):
                result = processes[name].poll()
                if result is None:
                    continue
                phases[name].update(exitCode=result, elapsedSeconds=round(
                    time.monotonic() - started - phases[name]['startedSeconds'], 3))
                print(f'SIMULATOR_STARTUP {name} finished: {result}; {phases[name]["elapsedSeconds"]} seconds', flush=True)
                pending.remove(name)
                if result:
                    exit_code, reason = result if result > 0 else 128 - result, name + '-failed'
                    return exit_code
            if pending and time.monotonic() - started >= timeout:
                exit_code, reason = 124, 'startup-timeout'
                return exit_code
            if pending:
                time.sleep(.05)
    except OSError:
        # Paths/command arguments may contain configuration; persist only phase verdicts.
        return exit_code
    finally:
        for number in previous_handlers:
            signal.signal(number, signal.SIG_IGN)
        if exit_code:
            victims = [process for process in processes.values() if process.poll() != 0]
            for process in victims:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + 2
            while any(process.poll() is None for process in victims) and time.monotonic() < deadline:
                time.sleep(.02)
            for process in victims:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
        for name, process in processes.items():
            if phases[name]['exitCode'] is None:
                phases[name].update(exitCode=process.returncode, elapsedSeconds=round(
                    time.monotonic() - started - phases[name]['startedSeconds'], 3))
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps({'schemaVersion': 1, 'exitCode': exit_code, 'reason': reason,
            'elapsedSeconds': round(time.monotonic() - started, 3), 'phases': phases}, indent=2) + '\n')
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--udid', required=True)
    parser.add_argument('--summary', type=Path, required=True)
    parser.add_argument('--timeout-seconds', type=float, default=600)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        uuid.UUID(args.udid)
    except ValueError:
        parser.error('UDID must be a UUID')
    if not 0 < args.timeout_seconds <= 600:
        parser.error('Startup timeout must be between 0 and 600 seconds')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('Build command is required after --')
    return prepare(args.udid, command, args.summary, args.timeout_seconds)


if __name__ == '__main__':
    sys.exit(main())
