import base64
import copy
import datetime as dt
import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


delivery, ci = load('testflight'), load('testflight-ci')
SHA = 'a' * 40


def environment():
    return dict(GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REF='refs/heads/main',
                IOS_TESTFLIGHT_ENABLED='true', GITHUB_RUN_NUMBER='23', GITHUB_RUN_ATTEMPT='1',
                IOS_TEAM_ID='ABCDEFGHIJ', ASC_KEY_ID='1234567890',
                ASC_ISSUER_ID='01234567-89ab-cdef-0123-456789abcdef',
                ASC_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nexample',
                IOS_DISTRIBUTION_P12_BASE64=base64.b64encode(b'example').decode(),
                IOS_APP_STORE_PROFILE_BASE64=base64.b64encode(b'example').decode(),
                IOS_DISTRIBUTION_P12_PASSWORD='example', SAINT_LOOK_DEV_URL='https://example.com',
                SAINT_LOOK_DEV_OWNER_TOKEN='private-example-' * 4)


class DeliveryTests(unittest.TestCase):
    def test_zero_exit_without_positive_apple_receipt_is_not_success(self):
        for response in [b'', b'{"errors":[{"message":"rejected"}]}',
                         b'ERROR: upload failed', b'uploaded 100% bytes',
                         b'No errors uploading\nERROR: rejected']:
            with self.subTest(response=response), self.assertRaises(ValueError):
                delivery.verify_upload_response(response)
        delivery.verify_upload_response(b'{"success-message":"No errors uploading archive"}')
        delivery.verify_upload_response(b'UPLOAD SUCCEEDED with no errors')

    def test_unsigned_check_ignores_owner_secrets(self):
        env = environment()
        env.update(GITHUB_EVENT_NAME='pull_request', IOS_TESTFLIGHT_BUNDLE_ID='')
        config = delivery.configuration(env)
        self.assertEqual(config['bundle'], 'com.saintlook.dev')
        self.assertNotEqual(config['token'], env['SAINT_LOOK_DEV_OWNER_TOKEN'])
        self.assertEqual(config['url'], 'https://testflight-check.invalid')

    def test_upload_refuses_untrusted_or_incomplete_configuration(self):
        for key, value in [('GITHUB_EVENT_NAME', 'pull_request'), ('GITHUB_REF', 'refs/heads/topic'),
                           ('IOS_TESTFLIGHT_ENABLED', ''), ('ASC_PRIVATE_KEY', ''),
                           ('IOS_TEAM_ID', 'bad'), ('SAINT_LOOK_DEV_OWNER_TOKEN', 'short'),
                           ('SAINT_LOOK_DEV_URL', 'http://example.com'),
                           ('SAINT_LOOK_DEV_URL', 'https://user:password@example.com'),
                           ('SAINT_LOOK_DEV_URL', 'https://example.com?token=private')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                delivery.configuration({**environment(), key: value}, upload=True)

    def test_reruns_get_distinct_build_numbers(self):
        self.assertEqual(delivery.configuration(environment())['build'], '23.1')
        self.assertEqual(delivery.configuration({**environment(), 'GITHUB_RUN_ATTEMPT': '2'})['build'], '23.2')
        with self.assertRaises(ValueError):
            delivery.configuration({**environment(), 'GITHUB_RUN_NUMBER': '10000'})

    def profile(self):
        return {'UUID': '01234567-89AB-CDEF-0123-456789ABCDEF', 'TeamIdentifier': ['ABCDEFGHIJ'],
                'ApplicationIdentifierPrefix': ['ABCDEFGHIJ'], 'Platform': ['iOS'],
                'ExpirationDate': dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=30),
                'DeveloperCertificates': [b'fake-certificate'], 'Entitlements': {
                    'com.apple.developer.team-identifier': 'ABCDEFGHIJ',
                    'application-identifier': 'ABCDEFGHIJ.com.saintlook.dev',
                    'get-task-allow': False, 'beta-reports-active': True}}

    def test_internal_export_uses_exact_profile_and_certificate(self):
        config = delivery.configuration(environment(), upload=True)
        uuid, fingerprint = delivery.profile_identity(self.profile(), config)
        options = delivery.export_options(config, uuid, fingerprint)
        self.assertTrue(options['testFlightInternalTestingOnly'])
        self.assertFalse(options['manageAppVersionAndBuildNumber'])
        self.assertEqual(options['provisioningProfiles'], {'com.saintlook.dev': uuid})
        self.assertEqual(options['signingCertificate'], fingerprint)
        self.assertEqual(options['method'], 'app-store-connect')

    def test_refuses_wrong_or_non_store_profiles(self):
        config = delivery.configuration(environment(), upload=True)
        cases = [('TeamIdentifier', ['OTHERTEAM1']), ('ProvisionedDevices', ['phone']),
                 ('ProvisionsAllDevices', True), ('Platform', ['macOS']),
                 ('ExpirationDate', dt.datetime.now(dt.timezone.utc)), ('DeveloperCertificates', [])]
        for key, value in cases:
            with self.subTest(key=key), self.assertRaises(ValueError):
                delivery.profile_identity({**self.profile(), key: value}, config)
        for key, value in [('get-task-allow', True), ('beta-reports-active', False),
                           ('application-identifier', 'ABCDEFGHIJ.*')]:
            profile = self.profile()
            profile['Entitlements'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                delivery.profile_identity(profile, config)

    def test_archive_rejects_wrong_metadata_and_debug_resources(self):
        config = delivery.configuration(environment())
        info = delivery.app_info({'CFBundleIdentifier': config['bundle'],
                                  'CFBundleSupportedPlatforms': ['iPhoneOS']}, config, SHA, True)
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            (app / 'SaintLook').write_bytes(b'fake')
            (app / 'PrivacyInfo.xcprivacy').write_bytes((delivery.ROOT / 'SaintLook/PrivacyInfo.xcprivacy').read_bytes())
            (app / 'Info.plist').write_bytes(plistlib.dumps(info))
            delivery.verify_app(app, config, SHA)
            (app / 'TrialPhotos').mkdir()
            with self.assertRaisesRegex(ValueError, 'Debug fixtures'):
                delivery.verify_app(app, config, SHA)
            (app / 'TrialPhotos').rmdir()
            for key, value in [('CFBundleVersion', 'old'), ('SaintLookBuildRevision', 'b' * 40),
                               ('SaintLookBuildSourceClean', False), ('SaintLookDefaultOwnerToken', 'wrong')]:
                (app / 'Info.plist').write_bytes(plistlib.dumps({**info, key: value}))
                with self.subTest(key=key), self.assertRaises(ValueError):
                    delivery.verify_app(app, config, SHA)
            (app / 'Info.plist').write_bytes(plistlib.dumps({**info, 'UIDeviceFamily': [1, 2]}))
            with self.assertRaisesRegex(ValueError, 'orientations'):
                delivery.verify_app(app, config, SHA)
            (app / 'Info.plist').write_bytes(plistlib.dumps(info))
            (app / 'PrivacyInfo.xcprivacy').write_bytes(plistlib.dumps({'NSPrivacyAccessedAPITypes': []}))
            with self.assertRaisesRegex(ValueError, 'Missing required reasons'):
                delivery.verify_app(app, config, SHA)


class CIAdmissionTests(unittest.TestCase):
    def run_record(self):
        return dict(id=123, head_sha=SHA, head_branch='main', event='push', status='completed',
                    conclusion='success', path='.github/workflows/ci.yml',
                    head_repository={'full_name': 'tbb/saint-look'})

    def test_requires_successful_same_repository_main_revision(self):
        self.assertEqual(ci.checked_run([self.run_record()], SHA, 'tbb/saint-look'), 123)
        self.assertEqual(ci.checked_run([{**self.run_record(), 'event': 'workflow_dispatch'}], SHA, 'tbb/saint-look'), 123)
        for key, value in [('head_sha', 'b' * 40), ('event', 'pull_request'), ('head_branch', 'topic'),
                           ('conclusion', 'failure'), ('status', 'in_progress'),
                           ('path', '.github/workflows/other.yml'), ('head_repository', {'full_name': 'fork/repo'})]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                ci.checked_run([{**self.run_record(), key: value}], SHA, 'tbb/saint-look')

    def test_skipped_and_missing_jobs_do_not_count_as_green(self):
        jobs = [dict(name=name, status='completed', conclusion='success') for name in ci.REQUIRED]
        ci.check_jobs(jobs)
        with self.assertRaises(ValueError):
            ci.check_jobs(jobs[1:])
        skipped = copy.deepcopy(jobs)
        skipped[0]['conclusion'] = 'skipped'
        with self.assertRaises(ValueError):
            ci.check_jobs(skipped)


if __name__ == '__main__':
    unittest.main()
