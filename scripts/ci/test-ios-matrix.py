import importlib.util
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location('matrix', Path(__file__).with_name('ios-matrix.py'))
matrix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matrix)


class MatrixTests(unittest.TestCase):
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
