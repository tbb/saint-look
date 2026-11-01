#!/usr/bin/env python3
"""Build a device archive; signed delivery is manual, main-only and internal-only.

Apple and owner credentials stay in a private temporary directory. Neither the
archive nor the signed IPA is uploaded as a GitHub artifact.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def configuration(env, upload=False):
    if upload:
        require(env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
                and env.get('GITHUB_REF') == 'refs/heads/main'
                and env.get('IOS_TESTFLIGHT_ENABLED') == 'true',
                'TestFlight delivery requires an enabled manual main run')
    bundle = env.get('IOS_TESTFLIGHT_BUNDLE_ID') or 'com.saintlook.dev'
    require(re.fullmatch(r'[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+){2,}', bundle)
            and len(bundle) <= 200, 'Invalid bundle identifier')
    run, attempt = env.get('GITHUB_RUN_NUMBER', '1'), env.get('GITHUB_RUN_ATTEMPT', '1')
    require(run.isdecimal() and attempt.isdecimal() and 1 <= int(run) <= 9999
            and 1 <= int(attempt) <= 99, 'Unsupported build number')
    config = {'bundle': bundle, 'build': f'{int(run)}.{int(attempt)}'}
    if not upload:
        return {**config, 'url': 'https://testflight-check.invalid', 'token': 'test-only-' * 4}
    for name in ['IOS_TEAM_ID', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY',
                 'IOS_DISTRIBUTION_P12_BASE64', 'IOS_DISTRIBUTION_P12_PASSWORD',
                 'IOS_APP_STORE_PROFILE_BASE64', 'SAINT_LOOK_DEV_URL', 'SAINT_LOOK_DEV_OWNER_TOKEN']:
        require(bool(env.get(name)), f'Missing configuration: {name}')
    require(re.fullmatch(r'[A-Z0-9]{10}', env['IOS_TEAM_ID']), 'Invalid Apple team ID')
    require(re.fullmatch(r'[A-Z0-9]{10}', env['ASC_KEY_ID']), 'Invalid API key ID')
    require(re.fullmatch(r'[a-fA-F0-9-]{36}', env['ASC_ISSUER_ID']), 'Invalid API issuer')
    require(env['ASC_PRIVATE_KEY'].strip().startswith('-----BEGIN PRIVATE KEY-----'), 'Invalid API key format')
    url, token = env['SAINT_LOOK_DEV_URL'], env['SAINT_LOOK_DEV_OWNER_TOKEN']
    parsed = urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname and not parsed.username
            and not parsed.password and not parsed.query and not parsed.fragment
            and parsed.path in ('', '/') and not any(c.isspace() for c in url), 'Invalid backend origin')
    require(len(token) >= 32 and not any(c.isspace() for c in token), 'Invalid owner configuration')
    return {**config, 'url': url, 'token': token, 'team': env['IOS_TEAM_ID']}


def profile_identity(profile, config, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    expiration = profile.get('ExpirationDate')
    require(isinstance(expiration, dt.datetime), 'Profile has no expiry')
    if expiration.tzinfo is None:
        expiration = expiration.replace(tzinfo=dt.timezone.utc)
    entitlements = profile.get('Entitlements', {})
    prefixes = profile.get('ApplicationIdentifierPrefix', [])
    require(profile.get('TeamIdentifier') == [config['team']]
            and entitlements.get('com.apple.developer.team-identifier') == config['team'], 'Profile team mismatch')
    require(len(prefixes) == 1 and re.fullmatch(r'[A-Z0-9]{10}', prefixes[0])
            and entitlements.get('application-identifier') == prefixes[0] + '.' + config['bundle'],
            'Profile bundle mismatch')
    require(entitlements.get('get-task-allow') is False
            and entitlements.get('beta-reports-active') is True
            and 'ProvisionedDevices' not in profile and not profile.get('ProvisionsAllDevices')
            and 'iOS' in profile.get('Platform', []), 'An iOS App Store distribution profile is required')
    require(expiration > now + dt.timedelta(days=1), 'Profile expires too soon')
    uuid = profile.get('UUID', '')
    require(re.fullmatch(r'[a-fA-F0-9-]{36}', uuid), 'Invalid profile UUID')
    certificates = profile.get('DeveloperCertificates', [])
    require(len(certificates) == 1 and isinstance(certificates[0], bytes), 'Expected one distribution certificate')
    return uuid, hashlib.sha1(certificates[0]).hexdigest().upper()


def export_options(config, uuid, fingerprint):
    return {'method': 'app-store-connect', 'destination': 'export', 'teamID': config['team'],
            'signingStyle': 'manual', 'signingCertificate': fingerprint,
            'provisioningProfiles': {config['bundle']: uuid},
            'testFlightInternalTestingOnly': True, 'manageAppVersionAndBuildNumber': False,
            'uploadSymbols': True}


def app_info(source, config, revision, clean):
    info = dict(source)
    require(re.fullmatch(r'[a-f0-9]{40}', revision), 'Build revision unavailable')
    info.update(CFBundleVersion=config['build'], SaintLookBuildRevision=revision,
                SaintLookBuildSourceClean=clean, SaintLookDefaultBackendURL=config['url'],
                SaintLookDefaultOwnerToken=config['token'])
    # The app uses the system HTTPS implementation and no proprietary encryption.
    info['ITSAppUsesNonExemptEncryption'] = False
    return info


def verify_app(app, config, revision):
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    require(info.get('CFBundleSupportedPlatforms') == ['iPhoneOS'], 'Not an iPhone device archive')
    for key, expected in {'CFBundleIdentifier': config['bundle'], 'CFBundleVersion': config['build'],
                          'SaintLookBuildRevision': revision, 'SaintLookBuildSourceClean': True,
                          'SaintLookDefaultBackendURL': config['url'],
                          'SaintLookDefaultOwnerToken': config['token']}.items():
        require(info.get(key) == expected, f'Archive metadata mismatch: {key}')
    require((app / 'SaintLook').is_file(), 'Missing device executable')
    require(not any((app / name).exists() for name in ('TrialPhotos', 'VisualFixtures')),
            'Debug fixtures present in archive')
    if 2 in info.get('UIDeviceFamily', []):
        require(set(info.get('UISupportedInterfaceOrientations~ipad', [])) == {
            'UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown',
            'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'},
            'iPad archive must declare all supported orientations')
    privacy = plistlib.loads((app / 'PrivacyInfo.xcprivacy').read_bytes())
    reasons = {entry['NSPrivacyAccessedAPIType']: entry['NSPrivacyAccessedAPITypeReasons']
               for entry in privacy.get('NSPrivacyAccessedAPITypes', [])}
    require('CA92.1' in reasons.get('NSPrivacyAccessedAPICategoryUserDefaults', [])
            and 'C617.1' in reasons.get('NSPrivacyAccessedAPICategoryFileTimestamp', []),
            'Missing required reasons for app-local defaults and image cache timestamps')


def run(args, stage, env=None, timeout=1200):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=env, timeout=timeout)
    # Tool output can contain plist defaults or credentials. Never echo it.
    require(result.returncode == 0, f'{stage} failed; no private tool output was published')
    return result.stdout


def write_private(path, content):
    path.write_bytes(content)
    path.chmod(0o600)


def binary_secret(env, name):
    try:
        value = base64.b64decode(env[name], validate=True)
    except Exception:
        raise ValueError(f'Invalid base64: {name}') from None
    require(0 < len(value) <= 1024 * 1024, f'Invalid signing asset size: {name}')
    return value


def verify_upload_response(output):
    # Some altool versions have returned zero for failed uploads. Require a
    # positive receipt as well, without publishing the potentially private body.
    response = output.decode(errors='replace')
    require(not re.search(r'\bERROR\s*:|"(?:errors|product-errors)"\s*:\s*\[\s*\{', response, re.I)
            and re.search(r'No errors uploading|UPLOAD SUCCEEDED', response, re.I),
            'Apple upload was not confirmed; inspect App Store Connect before retrying')


def deliver(upload=False):
    env = dict(os.environ)
    config = configuration(env, upload)
    require(sys.platform == 'darwin', 'Device archives require a macOS runner')
    revision = run(['git', '-C', str(ROOT.parent), 'rev-parse', 'HEAD'], 'Read revision').decode().strip()
    clean = not run(['git', '-C', str(ROOT.parent), 'status', '--porcelain', '--untracked-files=no'],
                    'Read source status').strip()
    require(clean, 'Archive requires clean tracked source')
    if upload:
        require(revision == env.get('GITHUB_SHA'), 'Source does not match the dispatched revision')
    with tempfile.TemporaryDirectory(prefix='saint-look-testflight-', dir=env.get('RUNNER_TEMP')) as directory:
        work = Path(directory)
        keychain, previous_keychains, installed_profiles = None, None, []
        try:
            info_path = work / 'Info.plist'
            write_private(info_path, plistlib.dumps(app_info(
                plistlib.loads((ROOT / 'SaintLook/Info.plist').read_bytes()), config, revision, clean)))
            signing = ['CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=']
            if upload:
                p12, profile_file = work / 'distribution.p12', work / 'app.mobileprovision'
                write_private(p12, binary_secret(env, 'IOS_DISTRIBUTION_P12_BASE64'))
                write_private(profile_file, binary_secret(env, 'IOS_APP_STORE_PROFILE_BASE64'))
                profile = plistlib.loads(run(['security', 'cms', '-D', '-i', str(profile_file)], 'Decode profile'))
                uuid, fingerprint = profile_identity(profile, config)
                previous_keychains = shlex.split(run(['security', 'list-keychains', '-d', 'user'], 'Read keychains').decode())
                keychain = work / 'signing.keychain-db'
                password = secrets.token_urlsafe(32)
                run(['security', 'create-keychain', '-p', password, str(keychain)], 'Create keychain')
                run(['security', 'set-keychain-settings', '-lut', '3600', str(keychain)], 'Configure keychain')
                run(['security', 'unlock-keychain', '-p', password, str(keychain)], 'Unlock keychain')
                run(['security', 'import', str(p12), '-k', str(keychain), '-P', env['IOS_DISTRIBUTION_P12_PASSWORD'],
                     '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'], 'Import signing identity')
                run(['security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s',
                     '-k', password, str(keychain)], 'Allow signing tools')
                run(['security', 'list-keychains', '-d', 'user', '-s', str(keychain), *previous_keychains], 'Select keychain')
                identities = run(['security', 'find-identity', '-v', '-p', 'codesigning', str(keychain)], 'Verify identity').decode()
                require(fingerprint in identities, 'Profile does not match an available signing identity')
                for relative in ['Library/MobileDevice/Provisioning Profiles',
                                 'Library/Developer/Xcode/UserData/Provisioning Profiles']:
                    path = Path.home() / relative / f'{uuid}.mobileprovision'
                    path.parent.mkdir(parents=True, exist_ok=True)
                    require(not path.exists(), 'Refusing to replace an existing provisioning profile')
                    write_private(path, profile_file.read_bytes())
                    installed_profiles.append(path)
                signing = ['CODE_SIGN_STYLE=Manual', f'DEVELOPMENT_TEAM={config["team"]}',
                           f'PROVISIONING_PROFILE_SPECIFIER={uuid}', f'CODE_SIGN_IDENTITY={fingerprint}']
                write_private(work / 'ExportOptions.plist', plistlib.dumps(export_options(config, uuid, fingerprint)))
            archive = work / 'SaintLook.xcarchive'
            run(['xcodebuild', '-quiet', '-project', str(ROOT / 'SaintLook.xcodeproj'), '-scheme', 'SaintLook',
                 '-configuration', 'Release', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS',
                 '-derivedDataPath', str(work / 'build'), '-archivePath', str(archive),
                 f'INFOPLIST_FILE={info_path}', f'PRODUCT_BUNDLE_IDENTIFIER={config["bundle"]}',
                 *signing, 'archive'], 'Device archive')
            app = archive / 'Products/Applications/SaintLook.app'
            verify_app(app, config, revision)
            run(['xcrun', 'lipo', str(app / 'SaintLook'), '-verify_arch', 'arm64'], 'Verify architecture')
            help_text = run(['xcodebuild', '-help'], 'Inspect export support').decode()
            require('testFlightInternalTestingOnly' in help_text, 'Xcode lacks internal-only export support')
            if not upload:
                print(json.dumps({'revision': revision, 'build': config['build'], 'unsignedArchiveChecked': True}))
                return
            run(['codesign', '--verify', '--deep', '--strict', str(app)], 'Verify archived signature')
            destination = work / 'export'
            run(['xcodebuild', '-exportArchive', '-archivePath', str(archive), '-exportPath', str(destination),
                 '-exportOptionsPlist', str(work / 'ExportOptions.plist')], 'Internal TestFlight export')
            ipas = list(destination.glob('*.ipa'))
            require(len(ipas) == 1, 'Expected exactly one exported IPA')
            private_keys = work / 'private_keys'
            private_keys.mkdir(mode=0o700)
            write_private(private_keys / f'AuthKey_{env["ASC_KEY_ID"]}.p8', env['ASC_PRIVATE_KEY'].encode())
            # One submission. An uncertain upload is inspected in App Store Connect
            # before another run; no hidden retry or automatic tester invitations.
            response = run(['xcrun', 'altool', '--upload-app', '--file', str(ipas[0]), '--type', 'ios',
                 '--apiKey', env['ASC_KEY_ID'], '--apiIssuer', env['ASC_ISSUER_ID'], '--output-format', 'json'],
                'Apple upload (check App Store Connect before retrying)',
                env={**env, 'API_PRIVATE_KEYS_DIR': str(private_keys)})
            verify_upload_response(response)
            print(json.dumps({'revision': revision, 'build': config['build'], 'uploaded': True,
                              'internalOnly': True, 'appleProcessingStillRequired': True}))
        finally:
            for path in installed_profiles:
                path.unlink(missing_ok=True)
            if previous_keychains is not None:
                subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', *previous_keychains],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            if keychain is not None:
                subprocess.run(['security', 'delete-keychain', str(keychain)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['check', 'upload'])
    args = parser.parse_args()
    try:
        deliver(args.operation == 'upload')
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        sys.exit('TestFlight operation failed; private output was withheld')
