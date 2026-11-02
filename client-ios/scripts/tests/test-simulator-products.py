"""Run the real shell runner against fake Apple commands; no Simulator is needed."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
TOOL = r'''
import os, plistlib, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(os.environ['PRODUCTS_TEST_ROOT'])
name = Path(sys.argv[0]).name
with (root/'calls').open('a') as output:
    output.write(name + ' ' + ' '.join(args) + '\n')
if name == 'git':
    print(os.environ.get('TEST_REVISION', 'a'*40))
elif name == 'xcrun':
    pass
elif '-version' in args:
    print(os.environ.get('TEST_XCODE', 'Test Xcode'))
elif 'build-for-testing' in args:
    products = Path('build/DerivedData/Build/Products')
    app = products/'Debug-iphonesimulator/SaintLookUITests-Runner.app'
    app.mkdir(parents=True, exist_ok=True)
    (app/'Info.plist').write_bytes(plistlib.dumps({}))
    (products/'Debug-iphonesimulator/SaintLook.app').mkdir(exist_ok=True)
    (products/'Tests.xctestrun').write_bytes(plistlib.dumps({
        'SaintLookUITests': {'BlueprintName': 'SaintLookUITests', 'TestBundlePath': '__TESTROOT__/SaintLookUITests.xctest'}}))
elif 'test-without-building' in args:
    manifest = Path(args[args.index('-xctestrun')+1])
    assert manifest.exists()
    print("Test Case '-[Tests testProducts]' started.")
    print("Test Case '-[Tests testProducts]' passed (0.1 seconds).")
else:
    sys.exit('Unexpected command')
'''


class ProductTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.client = self.root/'client-ios'
        scripts = self.client/'scripts'
        scripts.mkdir(parents=True)
        for name in ['test-simulator.sh', 'simulator-products.py', 'ui-watchdog.py']:
            if (ROOT/'scripts'/name).exists():
                shutil.copy(ROOT/'scripts'/name, scripts/name)
        binary = self.root/'bin'
        binary.mkdir()
        for name in ['git', 'xcrun', 'xcodebuild']:
            path = binary/name
            path.write_text('#!' + sys.executable + '\n' + TOOL)
            path.chmod(0o755)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('SAINT_LOOK_')}
        self.env.update(PATH=str(binary)+os.pathsep+os.environ['PATH'], PRODUCTS_TEST_ROOT=str(self.root),
                        SAINT_LOOK_SIMULATOR_UDID='00000000-0000-0000-0000-000000000001')

    def run_runner(self, **env):
        return subprocess.run(['bash', str(self.client/'scripts/test-simulator.sh')],
                              env={**self.env, **env}, capture_output=True, text=True, timeout=10)

    def successful(self, **env):
        result = self.run_runner(**env)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)

    def calls(self):
        return (self.root/'calls').read_text()

    def test_one_build_serves_multiple_test_jobs_without_booting_builder(self):
        self.successful(SAINT_LOOK_BUILD_ONLY='1')
        self.assertNotIn('simctl boot', self.calls())
        self.assertNotIn('test-without-building', self.calls())
        for _ in range(2):
            self.successful(SAINT_LOOK_REUSE_BUILD='1')
        self.assertEqual(self.calls().count('build-for-testing'), 1)
        self.assertEqual(self.calls().count('test-without-building'), 2)

    def test_default_local_run_still_builds_and_tests(self):
        self.successful()
        self.assertIn('simctl bootstatus', self.calls())
        self.assertEqual(self.calls().count('build-for-testing'), 1)
        self.assertEqual(self.calls().count('test-without-building'), 1)

    def test_reuse_rejects_missing_products_before_boot_or_compilation(self):
        result = self.run_runner(SAINT_LOOK_REUSE_BUILD='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('simctl boot', self.calls())
        self.assertNotIn('build-for-testing', self.calls())

    def test_reuse_rejects_other_revision_or_xcode(self):
        self.successful(SAINT_LOOK_BUILD_ONLY='1')
        for env in [{'TEST_REVISION': 'b'*40}, {'TEST_XCODE': 'Different Xcode'}]:
            with self.subTest(env=env):
                result = self.run_runner(SAINT_LOOK_REUSE_BUILD='1', **env)
                self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('simctl boot', self.calls())
        self.assertEqual(self.calls().count('build-for-testing'), 1)

    def test_reuse_rejects_changed_manifest_or_architecture(self):
        self.successful(SAINT_LOOK_BUILD_ONLY='1')
        products = self.client/'build/DerivedData/Build/Products'
        stamp = products/'saint-look-build.json'
        original = stamp.read_text()
        data = json.loads(original)
        data['architecture'] = 'wrong'
        stamp.write_text(json.dumps(data))
        self.assertNotEqual(self.run_runner(SAINT_LOOK_REUSE_BUILD='1').returncode, 0)
        stamp.write_text(original)
        (products/'Tests.xctestrun').write_bytes(b'different')
        self.assertNotEqual(self.run_runner(SAINT_LOOK_REUSE_BUILD='1').returncode, 0)
        self.assertNotIn('simctl boot', self.calls())

    def test_reuse_cannot_enter_live_remote_benchmark_or_launch_diagnostics(self):
        for mode in ['SAINT_LOOK_LIVE_TRIAL', 'SAINT_LOOK_REMOTE_SMOKE', 'SAINT_LOOK_BENCHMARK', 'SAINT_LOOK_LAUNCH_PAIR']:
            for flag in ['SAINT_LOOK_BUILD_ONLY', 'SAINT_LOOK_REUSE_BUILD']:
                with self.subTest(mode=mode, flag=flag):
                    result = self.run_runner(**{mode: '1', flag: '1'})
                    self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root/'calls').exists())


if __name__ == '__main__':
    unittest.main()
