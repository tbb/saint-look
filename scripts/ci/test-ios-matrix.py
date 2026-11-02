import importlib.util
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location('matrix', Path(__file__).with_name('ios-matrix.py'))
matrix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matrix)


class MatrixTests(unittest.TestCase):
    def test_events_choose_quick_feedback_or_complete_acceptance(self):
        for event in ['push', 'pull_request']:
            self.assertEqual(matrix.selected_suite(event, 'all'), 'smoke')
        self.assertEqual(matrix.selected_suite('schedule', 'smoke'), 'all')
        self.assertEqual(matrix.selected_suite('workflow_dispatch', ''), 'all')
        self.assertEqual(matrix.selected_suite('workflow_dispatch', 'outfits'), 'outfits')
        with self.assertRaises(ValueError):
            matrix.selected_suite('unknown', '')

    def test_smoke_is_one_build_with_real_scenarios_from_both_screens(self):
        rows = matrix.matrix('smoke')['include']
        self.assertEqual(len(rows), 1)
        selected = rows[0]['selectors'].splitlines()
        self.assertEqual(len(selected), len(set(selected)))
        self.assertEqual(len(selected), 6)
        for cls in matrix.CLASSES.values():
            self.assertTrue(any(f'/{cls}/' in test for test in selected))
        complete = {test for suite in matrix.CLASSES for group in matrix.partitions(suite) for test in group}
        self.assertLess(set(selected), complete)

    def test_visual_journeys_run_once_and_each_profile_checks_prepared_screens(self):
        source = (matrix.ROOT / 'client-ios/SaintLookUITests/VisualAcceptanceTests.swift').read_text()
        expected = set(re.findall(r'\bfunc (test\w+)\(', source))
        selections = [matrix.visual_tests(profile) for profile in matrix.PROFILES]
        selected = [test.rsplit('/', 1)[1] for group in selections for test in group]
        self.assertEqual(set(selected), expected)
        for journey in ['testPublicPhotoJourney', 'testPreparedFittingLayersAndFallbackStayLocal', 'testSecondaryStates']:
            self.assertEqual(selected.count(journey), 1)
        for profile, group in zip(matrix.PROFILES, selections):
            self.assertTrue(any(test.endswith('/testRealGeneratedGarmentsInCatalogAndFitting') for test in group))
            if profile != 'iphone-light':
                self.assertTrue(any(test.endswith('/testPreparedScreensAcrossProfiles') for test in group))
        with self.assertRaises(ValueError):
            matrix.visual_tests('unknown')

    def test_every_ordinary_scenario_runs_once(self):
        for suite, cls in matrix.CLASSES.items():
            source = (matrix.ROOT / f'client-ios/SaintLookUITests/{cls}.swift').read_text()
            expected = {f'SaintLookUITests/{cls}/{name}' for name in re.findall(r'\bfunc (test\w+)\(', source)
                        if name != 'testCachedRealBenchmarkFirstObservedResult'}
            groups = matrix.partitions(suite)
            actual = [test for group in groups for test in group]
            self.assertEqual(set(actual), expected)
            self.assertEqual(len(actual), len(expected))
            self.assertTrue(all(groups))

    def test_all_profiles_and_large_text_are_retained(self):
        rows = matrix.matrix()['include']
        self.assertEqual({row['profile'] for row in rows if row['suite'] == 'visual'}, set(matrix.PROFILES))
        self.assertEqual(sum(row['suite'] == 'outfits-max-text' for row in rows), 1)
        self.assertEqual(len({row['label'] for row in rows}), len(rows))

    def test_manual_diagnostics_remain_focused(self):
        for suite in ['outfits-launch-pair', 'wardrobe-expired-retry', 'benchmark']:
            self.assertEqual([row['suite'] for row in matrix.matrix(suite)['include']], [suite])


if __name__ == '__main__':
    unittest.main()
