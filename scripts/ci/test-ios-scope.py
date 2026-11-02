import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('scope', Path(__file__).with_name('ios-scope.py'))
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class ScopeTests(unittest.TestCase):
    def test_documentation_and_server_changes_do_not_allocate_mac(self):
        self.assertEqual(scope.checks_for_paths(['README.md', 'client-ios/README.md', 'backend/src/server.mjs']), set())

    def test_contract_app_and_unknown_ios_inputs_check_all_deliverables(self):
        for path in ['docs/api/items.md', 'shared/schema.json', 'client-ios/SaintLook/Outfit.swift',
                     'client-ios/SaintLook.xcodeproj/project.pbxproj', 'client-ios/scripts/new-tool.sh']:
            with self.subTest(path=path):
                self.assertEqual(scope.checks_for_paths([path]), scope.CHECKS)

    def test_test_infrastructure_does_not_rebuild_release_archives(self):
        for path in ['client-ios/SaintLookUITests/OutfitFlowTests.swift', 'client-ios/scripts/ui-test-proxy.mjs',
                     'client-ios/scripts/simulator-products.py', 'backend/test/providers/ui-server.mjs',
                     'scripts/ci/ios-matrix.py']:
            with self.subTest(path=path):
                self.assertEqual(scope.checks_for_paths([path]), {'ui'})

    def test_packaging_checks_follow_their_inputs(self):
        self.assertEqual(scope.checks_for_paths(['client-ios/scripts/package-ipa.py']), {'ipa'})
        self.assertEqual(scope.checks_for_paths(['client-ios/scripts/testflight-ci.py']), {'archive'})
        self.assertEqual(scope.checks_for_paths(['client-ios/scripts/tests/testflight-keychain.test.mjs']), {'archive'})
        self.assertEqual(scope.checks_for_paths(['client-ios/scripts/tests/connection-settings.swift']), {'ipa'})
        self.assertEqual(scope.checks_for_paths(['.github/workflows/ios-ipa.yml']), {'ipa'})

    def test_mixed_changes_accumulate_and_unknown_comparison_checks_everything(self):
        self.assertEqual(scope.checks_for_paths(['client-ios/scripts/test-simulator.sh', 'client-ios/scripts/package-ipa.py']), {'ui', 'ipa'})
        self.assertEqual(scope.checks_for_paths(None), scope.CHECKS)
        self.assertEqual(scope.checks_for_paths([]), set())
        self.assertEqual(scope.checks_for_paths(['scripts/ci/ios-scope.py']), scope.CHECKS)

    def test_full_git_diff_includes_deleted_renamed_and_more_than_300_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.DEVNULL).decode().strip()
            git('init')
            git('config', 'user.email', 'test@example.invalid')
            git('config', 'user.name', 'Scope test')
            source = root / 'client-ios/SaintLook/Old.swift'
            source.parent.mkdir(parents=True)
            source.write_text('struct Old {}')
            git('add', '.')
            git('commit', '-m', 'base')
            base = git('rev-parse', 'HEAD')
            source.rename(root / 'moved.swift')
            for i in range(305):
                (root / f'doc-{i}.md').write_text('documentation')
            git('add', '.')
            git('commit', '-m', 'change')
            event = root / 'event.json'
            event.write_text(json.dumps({'before': base}))
            output = root / 'output'
            result = subprocess.run(['python3', str(Path(scope.__file__).resolve())], cwd=root,
                                    env={**os.environ, 'GITHUB_EVENT_NAME': 'push', 'GITHUB_EVENT_PATH': str(event),
                                         'GITHUB_OUTPUT': str(output)}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(set(output.read_text().splitlines()), {'ui=true', 'ipa=true', 'archive=true'})

    def test_scheduled_and_manual_runs_are_never_path_filtered(self):
        for event in ['schedule', 'workflow_dispatch']:
            self.assertIsNone(scope.changed_paths(event, {}))
        self.assertIsNone(scope.changed_paths('push', {'before': '0' * 40}))
        with self.assertRaises(ValueError):
            scope.changed_paths('push', {'before': '--bad-ref'})


if __name__ == '__main__':
    unittest.main()
