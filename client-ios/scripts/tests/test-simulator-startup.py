"""Exercise the actual shell runner with synchronized external-tool processes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
UDID = '00000000-0000-0000-0000-000000000001'

# These stand in for Apple's tools, not the scheduler under test. Each phase can
# wait for its peer, making serial execution fail deterministically in seconds.
TOOL = r'''
import json, os, plistlib, signal, subprocess, sys, time
from pathlib import Path
root = Path(os.environ['STARTUP_TEST_ROOT'])
args = sys.argv[1:]
name = Path(sys.argv[0]).name

def mark(event):
    (root / event).touch()
    with (root / 'events').open('a') as output:
        output.write(event + '\n')

def await_event(event):
    deadline = time.monotonic() + 2
    while not (root / event).exists():
        if time.monotonic() > deadline:
            sys.exit('Missing overlapping phase: ' + event)
        time.sleep(.01)

def hold(phase):
    child = None
    if os.environ.get('HOLD_CHILD'):
        child = subprocess.Popen([sys.executable, '-c',
            "import os, signal, sys, time; from pathlib import Path; "
            "root=Path(os.environ['STARTUP_TEST_ROOT']); phase=sys.argv[1]; "
            "signal.signal(signal.SIGTERM, lambda *_: ((root/(phase+'-child-stopped')).touch(), sys.exit(0))); "
            "(root/(phase+'-child-started')).touch(); time.sleep(10)", phase])
        await_event(phase + '-child-started')
    def stopped(number, frame):
        if child is not None:
            child.wait(timeout=1)  # The supervisor must signal the child, too.
        mark(phase + '-stopped')
        sys.exit(128 + number)
    signal.signal(signal.SIGTERM, stopped)
    mark(phase + '-holding')
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        time.sleep(.02)
    sys.exit(78)

if name == 'git':
    print('a' * 40)
elif name == 'xcrun':
    action = args[1]
    if action == 'boot':
        mark('boot-started')
        sys.exit(149 if os.environ.get('ALREADY_BOOTED') else 0)
    elif action == 'bootstatus':
        if os.environ.get('EXPECT_OVERLAP'):
            await_event('build-started')
        if os.environ.get('FAIL_BOOT'):
            await_event('build-holding')
            time.sleep(float(os.environ.get('BOOT_FAIL_DELAY', '0')))
            sys.exit(43)
        if os.environ.get('HOLD_BOOT'):
            hold('boot')
        time.sleep(float(os.environ.get('BOOT_FINISH_DELAY', '0')))
        mark('boot-completed')
    elif action == 'ui':
        assert (root / 'boot-completed').exists(), 'Profile configured before boot finished'
        setting = args[3]
        path = root / setting
        if len(args) > 4:
            path.write_text(args[4])
            mark('setting-' + setting + '-' + args[4])
        else:
            print(path.read_text() if path.exists() else ('light' if setting == 'appearance' else 'large'))
    elif action == 'list':
        print(json.dumps({'devices': {'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
            {'udid': os.environ['SAINT_LOOK_SIMULATOR_UDID'], 'name': 'iPhone 17 Pro', 'isAvailable': True, 'state': 'Booted'}]}}))
    else:
        sys.exit('Unexpected simctl action: ' + action)
elif '-version' in args:
    print('Test Xcode')
elif 'build-for-testing' in args:
    mark('build-started')
    if os.environ.get('EXPECT_OVERLAP'):
        await_event('boot-started')
    if os.environ.get('FAIL_BUILD'):
        # Ensure the sibling is actually running before testing its cancellation.
        await_event('boot-holding')
        sys.exit(42)
    if os.environ.get('HOLD_BUILD'):
        hold('build')
    products = Path('build/DerivedData/Build/Products')
    app = products / 'Debug-iphonesimulator/SaintLookUITests-Runner.app'
    app.mkdir(parents=True)
    (app / 'Info.plist').write_bytes(plistlib.dumps({}))
    (products / 'Tests.xctestrun').write_bytes(plistlib.dumps({
        'SaintLookUITests': {'BlueprintName': 'SaintLookUITests', 'TestBundlePath': 'SaintLookUITests.xctest'}}))
    mark('build-completed')
elif 'test-without-building' in args:
    assert (root / 'boot-completed').exists() and (root / 'build-completed').exists(), 'Premature XCTest'
    mark('test-started')
    print("Test Case '-[Tests testStartup]' started.")
    print("Test Case '-[Tests testStartup]' passed (0.1 seconds).")
else:
    sys.exit('Unexpected build command')
'''


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.client = self.root / 'client-ios'
        scripts = self.client / 'scripts'
        scripts.mkdir(parents=True)
        for name in ['test-simulator.sh', 'prepare-simulator.py', 'ui-watchdog.py']:
            source = ROOT / 'scripts' / name
            if source.exists():
                shutil.copy(source, scripts / name)
        resources = self.client / 'SaintLook'
        resources.mkdir()
        for name in ['TrialPhotos', 'VisualFixtures']:
            (resources / name).symlink_to(ROOT / 'SaintLook' / name, target_is_directory=True)
        binary = self.root / 'bin'
        binary.mkdir()
        for name in ['xcrun', 'xcodebuild', 'git']:
            path = binary / name
            path.write_text('#!' + sys.executable + '\n' + TOOL)
            path.chmod(0o755)
        # Do not inherit a developer's live/benchmark/UI flags into the fixture.
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('SAINT_LOOK_')}
        self.env.update(PATH=str(binary) + os.pathsep + os.environ['PATH'],
                        STARTUP_TEST_ROOT=str(self.root), SAINT_LOOK_SIMULATOR_UDID=UDID)

    def run_runner(self, **env):
        return subprocess.run(['bash', str(self.client / 'scripts/test-simulator.sh')],
                              env={**self.env, **env}, capture_output=True, text=True, timeout=10)

    def test_boot_and_build_overlap_but_ui_waits_for_both(self):
        result = self.run_runner(EXPECT_OVERLAP='1', BOOT_FINISH_DELAY='.15')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = (self.root / 'events').read_text().splitlines()
        self.assertLess(events.index('build-started'), events.index('boot-completed'))
        self.assertLess(events.index('boot-completed'), events.index('test-started'))
        self.assertLess(events.index('build-completed'), events.index('test-started'))
        summary = json.loads(next((self.client / 'build').glob('*-startup.json')).read_text())
        self.assertEqual(summary['exitCode'], 0)
        self.assertEqual(set(summary['phases']), {'boot', 'build'})
        self.assertTrue(all(p['exitCode'] == 0 for p in summary['phases'].values()))

    def test_failed_build_stops_boot_and_never_starts_ui(self):
        result = self.run_runner(EXPECT_OVERLAP='1', FAIL_BUILD='1', HOLD_BOOT='1')
        self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
        self.assertTrue((self.root / 'boot-stopped').exists())
        self.assertFalse((self.root / 'test-started').exists())

    def test_failed_boot_stops_build_and_never_starts_ui(self):
        result = self.run_runner(EXPECT_OVERLAP='1', FAIL_BOOT='1', HOLD_BUILD='1')
        self.assertEqual(result.returncode, 43, result.stdout + result.stderr)
        self.assertTrue((self.root / 'build-stopped').exists())
        self.assertFalse((self.root / 'test-started').exists())

    def test_profile_is_applied_after_boot_and_restored(self):
        result = self.run_runner(EXPECT_OVERLAP='1', BOOT_FINISH_DELAY='.15',
                                 SAINT_LOOK_VISUAL_PROFILE='iphone-max-text', SAINT_LOOK_UI_APPEARANCE='dark',
                                 SAINT_LOOK_UI_CONTENT_SIZE='accessibility-extra-extra-extra-large')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = (self.root / 'events').read_text().splitlines()
        self.assertLess(events.index('boot-completed'), events.index('setting-appearance-dark'))
        self.assertLess(events.index('setting-content_size-accessibility-extra-extra-extra-large'), events.index('test-started'))
        self.assertEqual((self.root / 'appearance').read_text(), 'light')
        self.assertEqual((self.root / 'content_size').read_text(), 'large')

    def test_already_booted_device_still_requires_successful_bootstatus(self):
        result = self.run_runner(EXPECT_OVERLAP='1', ALREADY_BOOTED='1')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / 'boot-completed').exists())

    def helper_command(self, timeout='5'):
        return [sys.executable, str(self.client / 'scripts/prepare-simulator.py'), '--udid', UDID,
                '--summary', str(self.root / 'startup.json'), '--timeout-seconds', timeout,
                '--', 'xcodebuild', 'build-for-testing']

    def test_timeout_stops_both_phases(self):
        result = subprocess.run(self.helper_command('2'), cwd=self.client,
                                env={**self.env, 'HOLD_BOOT': '1', 'HOLD_BUILD': '1'},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 124, result.stdout + result.stderr)
        self.assertTrue((self.root / 'boot-stopped').exists())
        self.assertTrue((self.root / 'build-stopped').exists())
        summary = json.loads((self.root / 'startup.json').read_text())
        self.assertEqual(summary['reason'], 'startup-timeout')

    def test_cancel_stops_both_phases_and_preserves_signal_verdict(self):
        process = subprocess.Popen(self.helper_command(), cwd=self.client,
                                   env={**self.env, 'HOLD_BOOT': '1', 'HOLD_BUILD': '1', 'HOLD_CHILD': '1'},
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        deadline = time.monotonic() + 3
        while not all((self.root / (name + '-holding')).exists() for name in ['boot', 'build']):
            self.assertLess(time.monotonic(), deadline, 'Both phases must start before cancellation')
            time.sleep(.01)
        process.terminate()
        output, error = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 143, output + error)
        self.assertTrue((self.root / 'boot-stopped').exists())
        self.assertTrue((self.root / 'build-stopped').exists())
        summary = json.loads((self.root / 'startup.json').read_text())
        self.assertEqual(summary['reason'], 'signal-SIGTERM')
        self.assertTrue((self.root / 'boot-child-stopped').exists())
        self.assertTrue((self.root / 'build-child-stopped').exists())

    def test_failed_boot_stops_child_of_completed_build(self):
        child_code = (
            "import os, signal, sys, time; from pathlib import Path; "
            "root=Path(os.environ['STARTUP_TEST_ROOT']); "
            "signal.signal(signal.SIGTERM, lambda *_: ((root/'orphan-stopped').touch(), sys.exit(0))); "
            "(root/'orphan-started').touch(); time.sleep(10)"
        )
        build_code = (
            "import os, subprocess, sys, time; from pathlib import Path; "
            "root=Path(os.environ['STARTUP_TEST_ROOT']); "
            "subprocess.Popen([sys.executable, '-c', sys.argv[1]])\n"
            "while not (root/'orphan-started').exists(): time.sleep(.01)\n"
            "(root/'build-holding').touch()"
        )
        command = self.helper_command()[:-2] + [sys.executable, '-c', build_code, child_code]
        result = subprocess.run(command, cwd=self.client,
                                env={**self.env, 'FAIL_BOOT': '1', 'BOOT_FAIL_DELAY': '.2'},
                                capture_output=True, text=True, timeout=12)
        self.assertEqual(result.returncode, 43, result.stdout + result.stderr)
        self.assertTrue((self.root / 'orphan-stopped').exists())
        summary = json.loads((self.root / 'startup.json').read_text())
        self.assertEqual(summary['phases']['build']['exitCode'], 0)

    def test_remote_smoke_preserves_serial_startup(self):
        result = self.run_runner(SAINT_LOOK_REMOTE_SMOKE='1', SAINT_LOOK_REMOTE_URL='https://fixture.invalid',
                                 SAINT_LOOK_REMOTE_TOKEN='fixture-only', SAINT_LOOK_REMOTE_REVISION='a' * 40,
                                 SAINT_LOOK_REMOTE_DEPLOYMENT_ID='fixture')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = (self.root / 'events').read_text().splitlines()
        self.assertLess(events.index('boot-completed'), events.index('build-started'))
        self.assertFalse(list((self.client / 'build').glob('*-startup.json')))


if __name__ == '__main__':
    unittest.main()
