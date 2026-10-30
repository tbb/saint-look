#!/usr/bin/env python3
"""Observe local visual XCTest stalls without retrying or changing the test verdict."""
import argparse
import codecs
import ctypes
import datetime
import io
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import selectors
import subprocess
import sys
import threading
import time
import uuid

WARNING = 'App event loop idle notification not received, will attempt to continue.'
PROFILES = ('iphone-light', 'iphone-dark', 'iphone-max-text', 'ipad-light')
PLATFORM_FIELDS = frozenset({
    'SDKROOT', 'SDK_NAME', 'PLATFORM_NAME', 'SUPPORTED_PLATFORMS', 'ARCHS',
    'IPHONEOS_DEPLOYMENT_TARGET', 'DTPlatformName', 'DTPlatformVersion',
    'DTPlatformBuildVersion', 'MinimumOSVersion', 'TestDestinationPlatform',
    'TestDestinationPlatformVariant', 'TestDestinationArchitecture',
    'TestDestinationOSVersion', 'TestDestinationIdentifier',
})
ERROR_MARKERS = (
    ('unable to find a device matching', 'destination_no_match'),
    ('no available devices matched', 'destination_no_match'),
    ('runtime profile not found', 'runtime_profile_missing'),
    ('unable to lookup', 'lookup_failed'),
    ('no devices are booted', 'no_booted_devices'),
    ('device is unavailable', 'device_unavailable'),
    ('device not found', 'device_not_found'),
)


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def error_classification(value):
    """Map tool diagnostics to a tiny whitelist; never persist raw error text."""
    lowered = str(value or '').casefold()
    for marker, code in ERROR_MARKERS:
        if marker in lowered:
            return code
    return 'unclassified' if lowered else None


def selected_device_state(udid, payload):
    matches = [(runtime, device) for runtime, devices in payload.get('devices', {}).items()
               for device in devices if device.get('udid') == udid]
    if len(matches) != 1:
        return {'found': False, 'matchCount': len(matches)}
    runtime, device = matches[0]
    state = device.get('state')
    runtime = runtime if isinstance(runtime, str) and re.fullmatch(r'[A-Za-z0-9._-]{1,120}', runtime) else None
    return {'found': True, 'state': state if state in {'Booted', 'Booted (Shutdown)', 'Creating', 'Shutdown', 'Shutting Down'} else 'other',
            'isAvailable': device.get('isAvailable') if isinstance(device.get('isAvailable'), bool) else None,
            'runtimeIdentifier': runtime,
            'availabilityErrorCode': error_classification(device.get('availabilityError'))}


def selected_platform_metadata(manifest):
    """Keep a strict scalar whitelist from the SaintLookUITests xctestrun target."""
    if isinstance(manifest.get('TestConfigurations'), list):
        targets = [target for config in manifest['TestConfigurations'] if isinstance(config, dict)
                   for target in config.get('TestTargets', []) if isinstance(target, dict)]
    else:
        targets = [value for key, value in manifest.items()
                   if not key.startswith('__') and isinstance(value, dict)]
    targets = [target for target in targets if target.get('BlueprintName') == 'SaintLookUITests'
               or 'SaintLookUITests' in Path(str(target.get('TestBundlePath', ''))).name]
    collected = {}
    for target in targets:
        for key in PLATFORM_FIELDS:
            child = target.get(key)
            values = child if isinstance(child, list) else [child]
            safe = [item for item in values if isinstance(item, (str, int, bool))
                    and (not isinstance(item, str) or re.fullmatch(r'[A-Za-z0-9._,+ -]{1,128}', item))]
            if safe:
                collected.setdefault(key, []).extend(safe)
    return {'targetCount': len(targets), 'fields': {key: list(dict.fromkeys(values))
            for key, values in sorted(collected.items())}}


def xcode_destination_state(udid, returncode, stdout, stderr):
    if returncode != 0:
        return {'status': 'command_failed', 'errorCode': error_classification(stderr + stdout)}
    eligible, marker, ineligible = stdout.partition('Ineligible destinations')
    if udid in eligible:
        return {'status': 'eligible'}
    if marker and udid in ineligible:
        return {'status': 'ineligible'}
    return {'status': 'not_listed'}


def capture_destination(udid, profile, xctestrun, output, phase, test_exit_code=None):
    """Bounded, read-only selected-destination evidence; failure never affects XCTest status."""
    record = {'schemaVersion': 1, 'phase': phase, 'profile': profile, 'selectedUDID': udid, 'capturedUTC': utc()}
    try:
        result = subprocess.run(['/usr/bin/xcrun', 'simctl', 'list', 'devices', '--json'],
                                capture_output=True, text=True, timeout=8, check=False)
        if result.returncode == 0:
            try:
                record['simulator'] = selected_device_state(udid, json.loads(result.stdout))
            except Exception:
                record['simulator'] = {'status': 'invalid_response'}
        else:
            record['simulator'] = {'status': 'command_failed',
                                   'errorCode': error_classification(result.stderr + result.stdout)}
    except subprocess.TimeoutExpired:
        record['simulator'] = {'status': 'timeout'}
    except Exception:
        record['simulator'] = {'status': 'capture_failed'}

    xctestrun_path = Path(xctestrun)
    record['xctestrun'] = {'file': xctestrun_path.name, 'status': 'unavailable', 'platformMetadata': {}}
    try:
        with xctestrun_path.open('rb') as source:
            manifest = plistlib.load(source)
        record['xctestrun'] = {'file': xctestrun_path.name, 'status': 'read',
                               'platformMetadata': selected_platform_metadata(manifest)}
    except Exception:
        pass

    if test_exit_code is not None:
        record['testExitCode'] = test_exit_code
        try:
            result = subprocess.run(['/usr/bin/xcodebuild', '-project', 'SaintLook.xcodeproj',
                                     '-scheme', 'SaintLook', '-showdestinations'],
                                    capture_output=True, text=True, timeout=12, check=False)
            record['xcodeDestinationDiscovery'] = xcode_destination_state(
                udid, result.returncode, result.stdout, result.stderr)
        except subprocess.TimeoutExpired:
            record['xcodeDestinationDiscovery'] = {'status': 'timeout'}
        except Exception:
            record['xcodeDestinationDiscovery'] = {'status': 'capture_failed'}

    try:
        output = Path(output)
        output.mkdir(parents=True, exist_ok=True)
        path = output / f'{profile}-destination-{phase}.json'
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as destination:
            json.dump(record, destination, ensure_ascii=False, indent=2)
            destination.write('\n')
    except Exception:
        # Diagnostics are best-effort and must never change the test command's verdict.
        pass


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

    def inspect_line(line):
        nonlocal context
        context = (context + [line.rstrip()])[-20:]
        if WARNING in line and len(workers) < 2 and not stop.is_set():
            capture = folder / f'sample-{len(workers) + 1}'
            capture.mkdir()
            worker = threading.Thread(target=collect, args=(capture, udid, context[:], stop))
            worker.start()
            workers.append(worker)

    try:
        # A pending Python signal can arrive just before a blocking readline starts.
        # Return to Python regularly, including when a child is silent or emits no newline.
        decoder = io.IncrementalNewlineDecoder(
            codecs.getincrementaldecoder(process.stdout.encoding)(errors=process.stdout.errors),
            translate=True)
        os.set_blocking(process.stdout.fileno(), False)
        pending = ''
        with (folder / 'xcodebuild.log').open('w') as log, selectors.DefaultSelector() as readable:
            readable.register(process.stdout, selectors.EVENT_READ)
            while True:
                if not readable.select(timeout=.1):
                    continue
                try:
                    chunk = os.read(process.stdout.fileno(), 65536)
                except BlockingIOError:
                    continue
                text = decoder.decode(chunk, final=not chunk)
                sys.stdout.write(text)
                sys.stdout.flush()
                log.write(text)
                log.flush()
                lines = (pending + text).split('\n')
                pending = lines.pop()
                for line in lines:
                    inspect_line(line)
                if not chunk:
                    if pending:
                        inspect_line(pending)
                    break
        while True:
            try:
                status = process.wait(timeout=.1)
                break
            except subprocess.TimeoutExpired:
                pass
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
    parser.add_argument('--capture-destination', action='store_true')
    parser.add_argument('--udid', required=True)
    parser.add_argument('--profile', required=True, choices=PROFILES)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--xctestrun', type=Path)
    parser.add_argument('--phase', choices=('after-build', 'test-failure'))
    parser.add_argument('--test-exit-code', type=int)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    uuid.UUID(args.udid)
    if args.capture_destination:
        if not args.xctestrun or not args.phase or args.command:
            parser.error('Destination capture requires xctestrun and phase, with no test command.')
        capture_destination(args.udid, args.profile, args.xctestrun, args.output, args.phase, args.test_exit_code)
        return 0
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
