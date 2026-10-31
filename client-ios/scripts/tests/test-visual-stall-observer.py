#!/usr/bin/env python3
"""Exercise the observer's subprocess boundary without Xcode or production services."""
import importlib.util
import io
import json
import os
import plistlib
from pathlib import Path
import signal
import selectors
import subprocess
import sys
import tempfile
import textwrap
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

    def test_destination_capture_keeps_only_whitelisted_state_and_platform_fields(self):
        with tempfile.TemporaryDirectory() as folder:
            xctestrun = Path(folder) / 'RemoteSmoke.xctestrun'
            xctestrun.write_bytes(plistlib.dumps({'TestConfigurations': [{'TestTargets': [{
                'BlueprintName': 'SaintLookUITests', 'SDKROOT': 'iphonesimulator26.5',
                'SUPPORTED_PLATFORMS': ['iphoneos', 'iphonesimulator'], 'ARCHS': ['arm64'],
                'TestHostPath': '/private/secret/Runner.app',
                'EnvironmentVariables': {'SAINT_LOOK_UI_TEST_TOKEN': 'credential-sentinel',
                                         'SDKROOT': 'environment-sentinel'},
                'CommandLineArguments': ['argument-sentinel'],
            }]}]}))
            udid = '1812E91B-A366-406E-B714-BC3D488891B9'
            device_json = json.dumps({'devices': {'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [{
                'udid': udid, 'state': 'Booted', 'isAvailable': True,
                'availabilityError': '/private/path/credential-sentinel',
            }]}})
            responses = [
                subprocess.CompletedProcess([], 0, device_json, ''),
                subprocess.CompletedProcess([], 0, f'-- iOS Simulator --\n    iPad Pro (id:{udid})\n', ''),
            ]
            destination = Path(folder) / 'diagnostics'
            with patch.object(observer.subprocess, 'run', side_effect=responses):
                observer.capture_destination(udid, 'ipad-light', xctestrun, destination,
                                             'test-failure', test_exit_code=65)
            output = destination / 'ipad-light-destination-test-failure.json'
            encoded = output.read_text()
            record = json.loads(encoded)
            self.assertEqual(record['simulator']['state'], 'Booted')
            self.assertTrue(record['simulator']['isAvailable'])
            self.assertEqual(record['simulator']['availabilityErrorCode'], 'unclassified')
            self.assertEqual(record['xctestrun']['platformMetadata']['targetCount'], 1)
            fields = record['xctestrun']['platformMetadata']['fields']
            self.assertEqual(fields['SDKROOT'], ['iphonesimulator26.5'])
            self.assertEqual(record['xcodeDestinationDiscovery']['status'], 'eligible')
            self.assertEqual(record['testExitCode'], 65)
            for secret in ('credential-sentinel', 'environment-sentinel', 'argument-sentinel', '/private/path', 'Runner.app'):
                self.assertNotIn(secret, encoded)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_destination_error_and_discovery_formatters_use_whitelist_only(self):
        self.assertEqual(observer.error_classification('Unable to find a device matching secret-path'),
                         'destination_no_match')
        self.assertEqual(observer.error_classification('private token value'), 'unclassified')
        self.assertEqual(observer.xcode_destination_state(UDID, 0, f'id:{UDID}', ''), {'status': 'eligible'})
        self.assertEqual(observer.xcode_destination_state(UDID, 0,
                         f'Ineligible destinations:\n id:{UDID}', ''), {'status': 'ineligible'})
        self.assertEqual(observer.xcode_destination_state(UDID, 65, 'secret-output', 'secret-error'),
                         {'status': 'command_failed', 'errorCode': 'unclassified'})

    def test_lifecycle_markers_reject_unknown_fields_labels_and_invalid_scalars(self):
        marker = dict(test='create', phase='before-launch', systemUptime=123.5, appState=1, failureCount=0)
        self.assertEqual(observer.lifecycle_marker('prefix LAUNCH_LIFECYCLE ' + json.dumps(marker)), marker)
        for change in ({'environment': 'credential-sentinel'}, {'test': 'private-test-name'},
                       {'phase': 'arbitrary-path'}, {'systemUptime': float('nan')},
                       {'systemUptime': True}, {'appState': '4'}, {'failureCount': -1}):
            self.assertIsNone(observer.lifecycle_marker('LAUNCH_LIFECYCLE ' + json.dumps({**marker, **change})))
        self.assertIsNone(observer.lifecycle_marker('LAUNCH_LIFECYCLE not-json'))

    def test_lifecycle_capture_keeps_only_selected_verified_pid_and_state(self):
        marker = dict(test='cancel', phase='after-terminate', systemUptime=123.5, appState=1, failureCount=0)
        devices = {'devices': {'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
            {'udid': UDID, 'state': 'Booted', 'isAvailable': True, 'dataPath': '/private/sentinel'},
            {'udid': 'another-device', 'name': 'credential-sentinel', 'state': 'Shutdown'}]}}
        response = subprocess.CompletedProcess([], 0, json.dumps(devices), 'private-stderr')
        with tempfile.TemporaryDirectory() as folder, patch.object(observer, 'verified_app_pids', return_value=[123, 124]) as pid, \
                patch.object(observer.subprocess, 'run', return_value=response) as run:
            observer.capture_lifecycle(Path(folder), UDID, 'cancel-after-terminate', marker, threading.Event())
            pid.assert_called_once_with(UDID)
            self.assertLessEqual(run.call_args.kwargs['timeout'], 2)
            output = Path(folder) / 'lifecycle-cancel-after-terminate.json'
            encoded = output.read_text(); record = json.loads(encoded)
            self.assertEqual(record['verifiedAppPIDs'], [123, 124])
            self.assertEqual(record['verifiedAppPIDCount'], 2)
            self.assertEqual(record['marker'], marker)
            self.assertTrue(record['simulator']['isAvailable'])
            self.assertGreaterEqual(record['captureFinishedMonotonic'], record['captureStartedMonotonic'])
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            for sentinel in ('another-device', 'credential-sentinel', '/private/sentinel', 'private-stderr'):
                self.assertNotIn(sentinel, encoded)
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(observer, 'verified_app_pids', side_effect=RuntimeError('credential-sentinel')), \
                patch.object(observer.subprocess, 'run', side_effect=subprocess.TimeoutExpired('private-argv', 2)):
            observer.capture_lifecycle(Path(folder), UDID, 'first-launch-error', marker, threading.Event())
            encoded = (Path(folder) / 'lifecycle-first-launch-error.json').read_text()
            self.assertEqual(json.loads(encoded)['simulator']['status'], 'timeout')
            self.assertNotIn('credential-sentinel', encoded)
            self.assertNotIn('private-argv', encoded)

    def test_pair_probes_are_async_bounded_and_preserve_failure_without_raw_log(self):
        markers = [dict(test=test, phase=phase, systemUptime=1, appState=1, failureCount=0)
                   for test in observer.LIFECYCLE_TESTS for phase in observer.LIFECYCLE_PHASES]
        lines = ['LAUNCH_LIFECYCLE ' + json.dumps(value) for value in markers]
        error = 'error: Failed to get launch progress for com.saintlook.dev credential-sentinel'
        code = f'lines={lines + lines + [error, error, observer.WARNING]!r}; [print(line, flush=True) for line in lines]; raise SystemExit(7)'
        release, second = threading.Event(), threading.Event()
        calls = []

        def probe(*args):
            calls.append(args[2])
            if len(calls) >= 2:
                second.set()
            release.wait(3)

        def unblock():
            second.wait(2)
            release.set()

        controller = threading.Thread(target=unblock)
        with tempfile.TemporaryDirectory() as folder, patch.object(observer, 'capture_lifecycle', side_effect=probe), \
                patch.object(observer, 'collect', side_effect=AssertionError('Pair mode must not collect raw stacks')), \
                patch.object(observer.sys, 'stdout', io.StringIO()):
            controller.start()
            try:
                status = observer.observe([sys.executable, '-u', '-c', code], UDID, Path(folder), launch_pair=True)
            finally:
                release.set(); controller.join(timeout=3)
            self.assertTrue(second.is_set(), 'A second marker must be observed while the first probe is still blocked')
            self.assertEqual(status, 7)
            self.assertEqual(len(calls), 9, 'Eight fixed lifecycle boundaries and one launch failure, never repeated')
            self.assertFalse((Path(folder) / 'xcodebuild.log').exists())

    def test_pair_cli_retains_remote_and_live_restrictions(self):
        with tempfile.TemporaryDirectory() as folder:
            for key in ('SAINT_LOOK_REMOTE_SMOKE', 'SAINT_LOOK_LIVE_TRIAL'):
                command = self.command(folder, 'raise RuntimeError("must not run")')
                command[command.index('iphone-light')] = observer.LAUNCH_PAIR
                result = subprocess.run(command, env={**os.environ, key: '1'}, capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 2)
                self.assertIn('Sampling is limited to local visual fixtures', result.stderr)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_manual_diagnostic_routing_keeps_default_matrix_and_exact_selectors(self):
        workflow = (SCRIPT.parents[2] / '.github/workflows/ci.yml').read_text()
        matrix = textwrap.dedent(workflow.split("python3 - <<'PY'\n", 1)[1].split('          PY', 1)[0])
        route = workflow[workflow.index('          if [[ "$TEST_SUITE" == "outfits-launch-pair" ]]'):]
        route = textwrap.dedent(route.split('          if [[ "$TEST_SUITE" == "outfits"', 1)[0])
        pair = ('SaintLookUITests/OutfitFlowTests/testCancelDraftDoesNotCreateOutfit\n'
                'SaintLookUITests/OutfitFlowTests/testCreateUnnamedOutfitSurvivesBackgroundResultOfflineRestartAndItemDeletion')
        expired = 'SaintLookUITests/WardrobeFlowTests/testExpiredUndeliveredResultKeepsOriginalAndRequiresExplicitRetryAfterRelaunch'
        timeout = next(line.split('${{', 1)[1].split('}}', 1)[0] for line in workflow.splitlines()
                       if 'timeout-minutes:' in line and 'matrix.suite' in line)
        timeout = timeout.replace('matrix.suite', 'suite').replace('&&', 'and').replace('||', 'or')
        for suite, minutes in [('outfits-launch-pair', 20), ('wardrobe-expired-retry', 20),
                               ('wardrobe', 60), ('outfits', 75), ('outfits-max-text', 60), ('visual', 60), ('camera', 40)]:
            self.assertEqual(eval(timeout, {'__builtins__': {}}, {'suite': suite}), minutes)
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'output'
            for selected, suites in [('all', ['wardrobe', 'outfits', 'visual', 'visual', 'visual', 'visual']),
                                     ('outfits-launch-pair', ['outfits-launch-pair']),
                                     ('wardrobe-expired-retry', ['wardrobe-expired-retry'])]:
                output.write_text('')
                subprocess.run([sys.executable, '-c', matrix], env={**os.environ, 'BASE_SHA': '', 'HEAD_SHA': '',
                    'IOS_SUITE': selected, 'VISUAL_PROFILES': 'all', 'GITHUB_OUTPUT': str(output)}, check=True, timeout=3)
                value = next(line.split('=', 1)[1] for line in output.read_text().splitlines() if line.startswith('ios_matrix='))
                self.assertEqual([entry['suite'] for entry in json.loads(value)['include']], suites)
            calls = Path(folder) / 'calls'
            stub = 'bash() { printf "%s\\n" "$SAINT_LOOK_LAUNCH_PAIR" "$SAINT_LOOK_UI_TEST_ONLY" "$@" >> "$PAIR_CALLS"; return 23; }\n'
            for suite, flag, selectors in [('outfits-launch-pair', '1', pair), ('wardrobe-expired-retry', '', expired)]:
                for event, status in [('workflow_dispatch', 23), ('pull_request', 1)]:
                    result = subprocess.run(['/bin/bash', '-c', stub + route], env={**os.environ,
                        'TEST_SUITE': suite, 'GITHUB_EVENT_NAME': event, 'PAIR_CALLS': str(calls),
                        'SAINT_LOOK_LAUNCH_PAIR': ''}, capture_output=True, text=True, timeout=3)
                    self.assertEqual(result.returncode, status)
                    if event == 'workflow_dispatch':
                        self.assertEqual(calls.read_text(), flag + '\n' + selectors + '\nclient-ios/scripts/test-simulator.sh\n')
                        calls.unlink()
                    else:
                        self.assertFalse(calls.exists())


if __name__ == '__main__':
    unittest.main()
