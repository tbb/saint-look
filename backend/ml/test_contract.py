"""The adapter contract is also exercised by the paid-call-free HTTP suite."""
import unittest
from contract import canonical_text, representation, validate_representation, SPACE_ID


class RepresentationContract(unittest.TestCase):
    def test_text_is_reproducible_from_current_type_and_colors(self):
        self.assertEqual(canonical_text('t_shirt', ['white', 'black', 'white']),
                         't shirt. Colors: black, white.')

    def test_absent_color_omits_color_sentence(self):
        self.assertEqual(canonical_text('shirt', []), 'shirt.')

    def test_prepared_version_keeps_raw_projected_vector(self):
        item = representation([2.0] * 128, 'photo-1', 'a' * 64, 'shirt. Colors: blue.')
        self.assertEqual(validate_representation(item), [2.0] * 128)
        self.assertEqual(item['photoVersionID'], 'photo-1')

    def test_different_space_is_not_made_compatible_by_dimension(self):
        item = representation([2.0] * 128, 'photo-1', 'a' * 64, 'shirt. Colors: blue.')
        item['spaceID'] = 'different-space'
        with self.assertRaisesRegex(ValueError, 'incompatible_representation'):
            validate_representation(item)

    def test_non_finite_and_zero_vectors_are_not_prepared(self):
        for v in [[float('nan')] * 128, [0.] * 128]:
            with self.assertRaises(ValueError):
                representation(v, 'photo-1', 'a' * 64, 'shirt. Colors: blue.')


if __name__ == '__main__':
    unittest.main()
