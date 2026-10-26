import importlib.util
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('packager', Path(__file__).parents[1] / 'package-ipa.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackagingChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.key = self.root / 'identity.txt'
        subprocess.run(['age-keygen', '-o', str(self.key)], check=True, capture_output=True)
        recipient = subprocess.check_output(['age-keygen', '-y', str(self.key)], text=True).strip()
        self.env = {'SAINT_LOOK_IPA_URL': 'https://example.com',
                    'SAINT_LOOK_IPA_TOKEN': 'fixture-owner-token-not-a-real-secret-0001',
                    'SAINT_LOOK_IPA_RECIPIENT': recipient}
        self.app = self.root / 'SaintLook.app'
        self.app.mkdir()
        (self.app / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': 'com.saintlook.dev', 'CFBundleExecutable': 'SaintLook',
            'CFBundleSupportedPlatforms': ['iPhoneOS']}))
        (self.app / 'SaintLook').write_bytes(b'fixture-executable')
        (self.app / 'SaintLook').chmod(0o755)
        self.output = self.root / 'output' / 'SaintLook.ipa.age'

    def test_encrypted_roundtrip_and_wrong_identity(self):
        # CI also runs against the actual Release iPhoneOS product.
        app = Path(os.environ.get('SAINT_LOOK_TEST_APP', self.app))
        original_info = (app / 'Info.plist').read_bytes()
        with patch.dict(os.environ, self.env):
            packager.package(app, self.output)
        self.assertEqual((app / 'Info.plist').read_bytes(), original_info)
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])
        self.assertNotIn(self.env['SAINT_LOOK_IPA_TOKEN'].encode(), self.output.read_bytes())
        decrypted = self.root / 'decrypted.ipa'
        subprocess.run(['age', '-d', '-i', str(self.key), '-o', str(decrypted), str(self.output)], check=True)
        with zipfile.ZipFile(decrypted) as ipa:
            info = plistlib.loads(ipa.read('Payload/SaintLook.app/Info.plist'))
            self.assertEqual(info['SaintLookDefaultOwnerToken'], self.env['SAINT_LOOK_IPA_TOKEN'])
            self.assertEqual(info['SaintLookDefaultBackendURL'], self.env['SAINT_LOOK_IPA_URL'])
            self.assertEqual(info['CFBundleSupportedPlatforms'], ['iPhoneOS'])
            self.assertTrue(ipa.getinfo('Payload/SaintLook.app/SaintLook').external_attr >> 16 & 0o111)
            self.assertFalse(any('_CodeSignature/' in name for name in ipa.namelist()))
        other = self.root / 'other.txt'
        subprocess.run(['age-keygen', '-o', str(other)], check=True, capture_output=True)
        wrong = subprocess.run(['age', '-d', '-i', str(other), str(self.output)], capture_output=True)
        self.assertNotEqual(wrong.returncode, 0)
        self.assertEqual(wrong.stdout, b'')

    def test_invalid_configuration_publishes_nothing(self):
        for override in [
            {'SAINT_LOOK_IPA_URL': 'http://example.com'},
            {'SAINT_LOOK_IPA_URL': 'https://user:password@example.com'},
            {'SAINT_LOOK_IPA_URL': 'https://example.com/path'},
            {'SAINT_LOOK_IPA_URL': 'https://example.com?token=secret'},
            {'SAINT_LOOK_IPA_TOKEN': ''}, {'SAINT_LOOK_IPA_RECIPIENT': ''},
            {'SAINT_LOOK_IPA_RECIPIENT': 'age1invalid'},
        ]:
            with self.subTest(override=list(override)), patch.dict(os.environ, self.env | override):
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    packager.package(self.app, self.output)
                self.assertFalse(self.output.exists())
                self.assertFalse(list(self.output.parent.glob('.ipa-staging-*')))

    def test_rejects_simulator_and_plaintext_output(self):
        with patch.dict(os.environ, self.env):
            with self.assertRaises(ValueError):
                packager.package(self.app, self.root / 'SaintLook.ipa')
            info = plistlib.loads((self.app / 'Info.plist').read_bytes())
            info['CFBundleSupportedPlatforms'] = ['iPhoneSimulator']
            (self.app / 'Info.plist').write_bytes(plistlib.dumps(info))
            with self.assertRaises(ValueError):
                packager.package(self.app, self.output)
            self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
