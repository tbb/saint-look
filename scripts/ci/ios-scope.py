#!/usr/bin/env python3
"""Select iOS checks from the complete Git diff; unknown iOS paths run all checks."""
import base64
import json
import os
from pathlib import Path
import re
import subprocess

CHECKS = {'ui', 'ipa', 'archive'}
UI_SCRIPTS = {
    'test-simulator.sh', 'test-visual-acceptance.sh', 'test-outfit-core.sh', 'test-visual-fixtures.sh',
    'ui-test-proxy.mjs', 'ui-watchdog.py', 'observe-visual-stalls.py', 'simulator-products.py',
    'tests/outfit-core.swift', 'tests/visual-fixtures.swift', 'tests/test-ui-watchdog.py',
    'tests/test-visual-stall-observer.py', 'tests/test-simulator-products.py',
}
IPA_SCRIPTS = {'build-device.sh', 'package-ipa.py', 'tests/test-package-ipa.py',
               'test-image-presentation.sh', 'tests/image-presentation.swift', 'tests/connection-settings.swift'}


def checks_for_paths(paths):
    if paths is None:
        return CHECKS.copy()  # New branch or missing comparison: never silently skip.
    selected = set()
    for path in paths:
        if path.startswith(('shared/', 'docs/api/')):
            selected.update(CHECKS)
        elif path.lower().endswith('.md'):
            continue
        elif path.startswith('backend/test/providers/'):
            selected.add('ui')
        elif path.startswith('scripts/ci/'):
            selected.update(CHECKS if 'ios-scope' in path else {'ui'})
        elif path in {'.github/workflows/ci.yml', '.github/workflows/ios-ipa.yml', '.github/workflows/ios-testflight.yml'}:
            selected.add({'.github/workflows/ci.yml': 'ui', '.github/workflows/ios-ipa.yml': 'ipa',
                          '.github/workflows/ios-testflight.yml': 'archive'}[path])
        elif path.startswith('client-ios/SaintLookUITests/'):
            selected.add('ui')
        elif path.startswith('client-ios/scripts/'):
            script = path.removeprefix('client-ios/scripts/')
            if script in UI_SCRIPTS:
                selected.add('ui')
            elif script in IPA_SCRIPTS:
                selected.add('ipa')
            elif Path(script).name.startswith(('testflight', 'test-testflight', 'apple-token-check')):
                selected.add('archive')
            else:
                selected.update(CHECKS)
        elif path.startswith('client-ios/'):
            selected.update(CHECKS)
    return selected


def changed_paths(event_name, event):
    if event_name in ('schedule', 'workflow_dispatch'):
        return None
    if event_name == 'pull_request':
        base = event.get('pull_request', {}).get('base', {}).get('sha', '')
    elif event_name == 'push':
        base = event.get('before', '')
    else:
        raise ValueError('Unsupported CI event')
    if not base or base == '0' * 40:
        return None
    if not re.fullmatch('[a-f0-9]{40}', base):
        raise ValueError('Invalid comparison revision')
    if subprocess.run(['git', 'cat-file', '-e', base + '^{commit}'], capture_output=True).returncode:
        # Checkout keeps credentials out of Git config. Authenticate only this fetch.
        args = ['git']
        if token := os.environ.get('GH_TOKEN'):
            auth = base64.b64encode(('x-access-token:' + token).encode()).decode()
            args += ['-c', 'http.https://github.com/.extraheader=AUTHORIZATION: basic ' + auth]
        subprocess.run(args + ['fetch', '--no-tags', '--depth=1', 'origin', base],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    raw = subprocess.check_output(['git', 'diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], timeout=30)
    return [path.decode() for path in raw.split(b'\0') if path]


def main():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    selected = checks_for_paths(changed_paths(os.environ['GITHUB_EVENT_NAME'], event))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for check in sorted(CHECKS):
            output.write(f'{check}={str(check in selected).lower()}\n')
    print('Selected iOS checks: ' + (', '.join(sorted(selected)) or 'none (no affected iOS inputs)'))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # A failed diff is an error, not an empty change. Never print auth-bearing git arguments.
        raise SystemExit('Unable to determine changed inputs; checks were not skipped')
