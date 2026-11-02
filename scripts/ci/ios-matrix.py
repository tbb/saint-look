#!/usr/bin/env python3
"""Partition every ordinary UI scenario once, using measured durations."""
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
CLASSES = {'wardrobe': 'WardrobeFlowTests', 'outfits': 'OutfitFlowTests'}
PROFILES = ['iphone-light', 'iphone-dark', 'iphone-max-text', 'ipad-light']


# A single build checks ingestion, persistence, native menus, cancellation and scrolling.
SMOKE = {
    'WardrobeFlowTests': [
        'testPhotoBecomesReadyThroughBackendAndSurvivesOfflineRelaunch',
        'testCancelDeletionKeepsPhotoAndDoesNotSendDelete',
        'testSourceCancellationAndUnavailableCameraDoNotCreateAnItem',
    ],
    'OutfitFlowTests': [
        'testCancelDraftDoesNotCreateOutfit',
        'testCreateUnnamedOutfitSurvivesBackgroundResultOfflineRestartAndItemDeletion',
        'testSwipeDoesNotOpenPickerAndVerticalDragScrollsThroughRow',
    ],
}


def selected_suite(event, requested=''):
    if event in ('push', 'pull_request'):
        return 'smoke'
    if event == 'schedule':
        return 'all'
    if event == 'workflow_dispatch':
        return requested or 'all'
    raise ValueError(f'Unsupported iOS CI event: {event}')


def visual_tests(profile):
    if profile not in PROFILES:
        raise ValueError(f'Unknown visual profile: {profile}')
    names = ['testRealGeneratedGarmentsInCatalogAndFitting', 'testReplaceSavedNameThroughNativeMenu']
    if profile == 'iphone-light':
        names += ['testPublicPhotoJourney', 'testPreparedFittingLayersAndFallbackStayLocal', 'testSecondaryStates']
    else:
        names += ['testPreparedScreensAcrossProfiles']
    return [f'SaintLookUITests/VisualAcceptanceTests/{name}' for name in names]


def partitions(suite):
    cls = CLASSES[suite]
    source = (ROOT / f'client-ios/SaintLookUITests/{cls}.swift').read_text()
    tests = re.findall(r'\bfunc (test\w+)\(', source)
    # This case consumes a real checkpoint and already skips in ordinary CI.
    tests = [name for name in tests if name != 'testCachedRealBenchmarkFirstObservedResult']
    weights = json.loads((ROOT / 'scripts/ci/ui-durations.json').read_text())['seconds'][cls]
    groups, totals = [[], []], [0, 0]
    for name in sorted(tests, key=lambda name: (-weights.get(name, 90), name)):
        index = min(range(2), key=totals.__getitem__)
        groups[index].append(f'SaintLookUITests/{cls}/{name}')
        totals[index] += weights.get(name, 90)
    return groups


def matrix(selected='all', profile='all'):
    if selected == 'smoke':
        selectors = [f'SaintLookUITests/{cls}/{name}' for cls, names in SMOKE.items() for name in names]
        return {'include': [dict(suite='smoke', label='smoke', profile='', selectors='\n'.join(selectors))]}
    suites = ['wardrobe', 'outfits', 'outfits-max-text', 'visual'] if selected == 'all' else (
        ['native-menu-delete', 'native-menu-text'] if selected == 'native-menus' else [selected])
    rows = []
    for suite in suites:
        if suite in CLASSES:
            for index, selectors in enumerate(partitions(suite), 1):
                rows.append(dict(suite=suite, label=f'{suite}-{index}', profile='', selectors='\n'.join(sorted(selectors))))
        else:
            for value in (PROFILES if profile == 'all' else [profile]) if suite == 'visual' else ['']:
                rows.append(dict(suite=suite, label=f'{suite}-{value}' if value else suite, profile=value, selectors=''))
    return {'include': rows}


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--visual-selectors':
        print('\n'.join(visual_tests(sys.argv[2])))
        sys.exit(0)
    value = matrix(selected_suite(os.environ['GITHUB_EVENT_NAME'], os.environ.get('IOS_SUITE', '')),
                   os.environ.get('VISUAL_PROFILES', 'all'))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'ios_matrix={json.dumps(value)}\n')
