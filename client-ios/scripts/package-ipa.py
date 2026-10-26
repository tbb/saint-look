#!/usr/bin/env python3
"""Package an unsigned device app; publish only age-authenticated ciphertext.

Credentials are supplied via environment AFTER compilation. Never log them, put
these values into xcodebuild arguments, or upload the staging directory.
"""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit
import zipfile


def package(app: Path, output: Path):
    url = os.environ.get('SAINT_LOOK_IPA_URL', '')
    token = os.environ.get('SAINT_LOOK_IPA_TOKEN', '')
    recipient = os.environ.get('SAINT_LOOK_IPA_RECIPIENT', '')
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or parsed.path not in ('', '/') or any(c.isspace() for c in url)
            or len(token) < 32 or any(c.isspace() for c in token)):
        raise ValueError('Valid HTTPS origin and owner token required')
    if not recipient.startswith('age1') or any(c.isspace() for c in recipient):
        raise ValueError('One native age public recipient required')
    if output.suffix != '.age' or output.exists():
        raise ValueError('Output must be a new .age file')
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    if info.get('CFBundleSupportedPlatforms') != ['iPhoneOS']:
        raise ValueError('An iPhoneOS device build is required, not Simulator')
    if info.get('CFBundleIdentifier') != 'com.saintlook.dev':
        raise ValueError('Unexpected application bundle')
    executable = info.get('CFBundleExecutable', '')
    if executable != 'SaintLook' or not (app / executable).is_file():
        raise ValueError('Missing app executable')
    output.parent.mkdir(parents=True, exist_ok=True)
    # Same filesystem for atomic publication. Cleanup runs on failures too.
    with tempfile.TemporaryDirectory(prefix='.ipa-staging-', dir=output.parent) as temp:
        staging = Path(temp)
        copied = staging / 'Payload' / 'SaintLook.app'
        shutil.copytree(app, copied)
        # Sideloadly supplies the actual free-account profile and signature.
        shutil.rmtree(copied / '_CodeSignature', ignore_errors=True)
        (copied / 'embedded.mobileprovision').unlink(missing_ok=True)
        info['SaintLookDefaultBackendURL'] = url
        info['SaintLookDefaultOwnerToken'] = token
        (copied / 'Info.plist').write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
        ipa = staging / 'SaintLook.ipa'
        with zipfile.ZipFile(ipa, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted((staging / 'Payload').rglob('*')):
                if path.is_file():
                    archive.write(path, path.relative_to(staging))
        encrypted = staging / 'SaintLook.ipa.age'
        subprocess.run(['age', '--encrypt', '--recipient', recipient,
                        '--output', str(encrypted), str(ipa)], check=True)
        os.replace(encrypted, output)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    try:
        package(args.app, args.output)
    except Exception:
        # Do not echo exception details: malformed URLs/arguments can contain secrets.
        raise SystemExit('IPA packaging failed; no plaintext artifact was published.')
