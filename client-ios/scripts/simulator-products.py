#!/usr/bin/env python3
"""Stamp/verify local Simulator products before per-job XCTest configuration."""
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys

PRODUCTS = Path('build/DerivedData/Build/Products')
STAMP = PRODUCTS / 'saint-look-build.json'


def identity():
    manifests = list(PRODUCTS.glob('*.xctestrun'))
    if len(manifests) != 1 or manifests[0].name == 'RemoteSmoke.xctestrun':
        raise ValueError('Expected one unconfigured XCTest manifest')
    for app in ['SaintLook.app', 'SaintLookUITests-Runner.app']:
        if not (PRODUCTS / 'Debug-iphonesimulator' / app).is_dir():
            raise ValueError('Missing Simulator app products')
    return dict(schemaVersion=1,
                revision=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                xcode=subprocess.check_output(['xcodebuild', '-version'], text=True).strip(),
                architecture=platform.machine(), manifest=manifests[0].name,
                manifestSHA256=hashlib.sha256(manifests[0].read_bytes()).hexdigest())


def main():
    if sys.argv[1:] == ['stamp']:
        STAMP.write_text(json.dumps(identity(), indent=2) + '\n')
        print('Recorded unconfigured Simulator products for this revision and Xcode')
    elif sys.argv[1:] == ['verify']:
        if json.loads(STAMP.read_text()) != identity():
            raise ValueError('Simulator products do not match this revision, Xcode, architecture or manifest')
        print('Verified shared Simulator products; skipping compilation')
    else:
        raise ValueError('Use stamp or verify')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
