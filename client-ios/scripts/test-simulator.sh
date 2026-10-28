#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Backend must already run on the Mac host; the Simulator shares its loopback.
# Defaults and fixture-only credentials are in WardrobeFlowTests.swift.
if ! command -v xcodebuild >/dev/null || ! command -v xcrun >/dev/null; then
  echo "Simulator tests require macOS with Xcode and an installed iOS Simulator runtime." >&2
  exit 1
fi
if [[ -n "${SAINT_LOOK_VISUAL_PROFILE:-}" ]]; then
  case "$SAINT_LOOK_VISUAL_PROFILE" in
    iphone-light|iphone-dark|iphone-max-text|ipad-light) ;;
    *) echo 'Unknown visual profile' >&2; exit 1 ;;
  esac
  if [[ "${SAINT_LOOK_REMOTE_SMOKE:-0}" == 1 || "${SAINT_LOOK_LIVE_TRIAL:-0}" == 1 ]]; then
    echo 'Visual fixtures cannot run with remote or live trials' >&2
    exit 1
  fi
fi
xcodebuild -version
work_directory="$(mktemp -d)"
recording_pid=''
name_diagnostic_pid=''
remote_manifest=''
previous_content_size=''
previous_appearance=''
simulator_family="${SAINT_LOOK_SIMULATOR_FAMILY:-iPhone}"
[[ "$simulator_family" == iPhone || "$simulator_family" == iPad ]] || { echo 'Unsupported simulator family' >&2; exit 1; }
cleanup() {
  local test_status=$?
  trap - EXIT
  if [[ -n "$name_diagnostic_pid" ]]; then
    kill "$name_diagnostic_pid" 2>/dev/null || true
    wait "$name_diagnostic_pid" 2>/dev/null || true
  fi
  if [[ -n "$recording_pid" ]]; then
    # SIGINT lets simctl finish the MP4 container, including after a failed test.
    kill -INT "$recording_pid" 2>/dev/null || true
    for attempt in {1..50}; do
      if ! kill -0 "$recording_pid" 2>/dev/null; then break; fi
      sleep 0.2
    done
    if kill -0 "$recording_pid" 2>/dev/null; then
      echo "Simulator recorder did not finish within 10 seconds." >&2
      kill -KILL "$recording_pid" 2>/dev/null || true
    fi
    wait "$recording_pid" 2>/dev/null || true
  fi
  if [[ -n "$previous_appearance" ]]; then
    xcrun simctl ui "$simulator_id" appearance "$previous_appearance" || test_status=1
    [[ "$(xcrun simctl ui "$simulator_id" appearance)" == "$previous_appearance" ]] || test_status=1
    echo "Restored Simulator appearance: $previous_appearance"
  fi
  if [[ -n "$previous_content_size" ]]; then
    xcrun simctl ui "$simulator_id" content_size "$previous_content_size" || test_status=1
    [[ "$(xcrun simctl ui "$simulator_id" content_size)" == "$previous_content_size" ]] || test_status=1
    echo "Restored Simulator Dynamic Type: $previous_content_size"
  fi
  if [[ -n "$remote_manifest" ]]; then rm -f "$remote_manifest"; fi
  rm -rf "$work_directory"
  exit "$test_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
simulator_id="${SAINT_LOOK_SIMULATOR_UDID:-}"
if [[ -z "$simulator_id" ]]; then
  # CoreSimulator may still be discovering preinstalled devices on a fresh runner.
  for attempt in 1 2 3; do
    xcrun simctl list devices available --json > "$work_directory/devices.json"
    xcodebuild -project SaintLook.xcodeproj -scheme SaintLook -showdestinations > "$work_directory/destinations.txt"
    cat "$work_directory/destinations.txt"
    if simulator_id="$(python3 - "$work_directory/destinations.txt" "$work_directory/devices.json" "$simulator_family" <<'PYTHON'
import json, re, sys
with open(sys.argv[1]) as source:
    runnable = source.read().split("Ineligible destinations")[0]
allowed = set(re.findall(r"id:\s*([0-9A-Fa-f-]{36})", runnable))
with open(sys.argv[2]) as source:
    devices_by_runtime = json.load(source)["devices"]
for runtime, devices in devices_by_runtime.items():
    if ".iOS-" not in runtime:
        continue
    for device in devices:
        if device.get("isAvailable") and device["name"].startswith(sys.argv[3]) and device["udid"] in allowed:
            print(device["udid"])
            sys.exit(0)
sys.exit(1)
PYTHON
    )"; then
      break
    fi
    echo "Waiting for Xcode to discover an available $simulator_family Simulator ($attempt/3)."
    sleep 2
  done
  if [[ -z "$simulator_id" ]]; then
    echo "No available $simulator_family Simulator. Install an iOS runtime in Xcode." >&2
    exit 1
  fi
fi
xcrun simctl boot "$simulator_id" 2>/dev/null || true
xcrun simctl bootstatus "$simulator_id" -b
if [[ -n "${SAINT_LOOK_UI_APPEARANCE:-}" ]]; then
  [[ "$SAINT_LOOK_UI_APPEARANCE" == light || "$SAINT_LOOK_UI_APPEARANCE" == dark ]]
  previous_appearance="$(xcrun simctl ui "$simulator_id" appearance)"
  xcrun simctl ui "$simulator_id" appearance "$SAINT_LOOK_UI_APPEARANCE"
  actual_appearance="$(xcrun simctl ui "$simulator_id" appearance)"
  echo "Simulator appearance: $actual_appearance (previous: $previous_appearance)"
  [[ "$actual_appearance" == "$SAINT_LOOK_UI_APPEARANCE" ]]
fi
if [[ -n "${SAINT_LOOK_UI_CONTENT_SIZE:-}" ]]; then
  # Exercise the real Simulator preference, including sheets, and restore it on failure too.
  previous_content_size="$(xcrun simctl ui "$simulator_id" content_size)"
  xcrun simctl ui "$simulator_id" content_size "$SAINT_LOOK_UI_CONTENT_SIZE"
  actual_content_size="$(xcrun simctl ui "$simulator_id" content_size)"
  echo "Simulator Dynamic Type: $actual_content_size (previous: $previous_content_size)"
  [[ "$actual_content_size" == "$SAINT_LOOK_UI_CONTENT_SIZE" ]]
fi
mkdir -p build
if [[ -n "${SAINT_LOOK_VISUAL_PROFILE:-}" ]]; then
  xcrun simctl list devices available --json > "build/${SAINT_LOOK_VISUAL_PROFILE}-devices.json"
  python3 - "$simulator_id" <<'VISUAL_EVIDENCE'
import hashlib, json, os, subprocess, sys
from pathlib import Path
profile = os.environ['SAINT_LOOK_VISUAL_PROFILE']
assert profile in ('iphone-light', 'iphone-dark', 'iphone-max-text', 'ipad-light')
devices = json.loads(Path('build/' + profile + '-devices.json').read_text())['devices']
selected = [(runtime, device) for runtime, entries in devices.items() for device in entries if device['udid'] == sys.argv[1]]
assert len(selected) == 1 and selected[0][1]['name'].startswith('iPad' if profile == 'ipad-light' else 'iPhone')
photos = json.loads(Path('SaintLook/TrialPhotos/manifest.json').read_text())['photos']
hashes = {}
for photo in photos:
    path = Path('SaintLook/TrialPhotos') / photo['file']
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert digest == photo['sha256'], 'Public trial photo changed'
    hashes[str(path)] = digest
shoes = Path('SaintLook/VisualFixtures/shoes.png')
hashes[str(shoes)] = hashlib.sha256(shoes.read_bytes()).hexdigest()
assert hashes[str(shoes)] == 'df7642e0879b5a13a35cd46ca4da37173e95a6b32520f3c3c5975cebc75bd229'
evidence = dict(profile=profile, simulatorUDID=sys.argv[1], model=selected[0][1]['name'], runtime=selected[0][0],
    fixtureHashes=hashes, fixtureNote='Three original photos with backgrounds and one published Commons footwear cutout; not Photoroom output',
    revision=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    xcode=subprocess.check_output(['xcodebuild', '-version'], text=True).strip(),
    appearance=subprocess.check_output(['xcrun', 'simctl', 'ui', sys.argv[1], 'appearance'], text=True).strip(),
    contentSize=subprocess.check_output(['xcrun', 'simctl', 'ui', sys.argv[1], 'content_size'], text=True).strip())
Path('build/' + profile + '-profile.json').write_text(json.dumps(evidence, indent=2) + '\n')
VISUAL_EVIDENCE
fi
result_path="$(pwd)/build/UITests-$(date -u +%Y%m%dT%H%M%SZ).xcresult"
build_options=(
  -project SaintLook.xcodeproj
  -scheme SaintLook
  -configuration Debug
  -destination "platform=iOS Simulator,id=$simulator_id"
  -parallel-testing-enabled NO
  -derivedDataPath build/DerivedData
  CODE_SIGNING_ALLOWED=NO
)
if [[ "${SAINT_LOOK_LIVE_TRIAL:-0}" == '1' ]]; then
  # Validate the exact committed public inputs before any UI action can consume quota.
  python3 - <<'TRIAL_PHOTOS'
import hashlib, json, os, re
from pathlib import Path
count = int(os.environ.get('SAINT_LOOK_TRIAL_PHOTO_COUNT', '0'))
if count not in (2, 3):
    raise SystemExit('Select two or three approved photos.')
folder = Path('SaintLook/TrialPhotos')
manifest = json.loads((folder / 'manifest.json').read_text())
photos = manifest['photos'][:count]
if manifest.get('format') != 1 or len(photos) != count:
    raise SystemExit('Trial photo manifest is incomplete.')
for photo in photos:
    if not re.fullmatch(r'photo-[1-3]\.(png|jpg)', photo.get('file', '')) or not all(photo.get(k) for k in ('source', 'license', 'author')):
        raise SystemExit('Trial photo provenance is incomplete.')
    if hashlib.sha256((folder / photo['file']).read_bytes()).hexdigest() != photo['sha256']:
        raise SystemExit('Trial photo differs from the reviewed manifest.')
TRIAL_PHOTOS
fi
xcodebuild "${build_options[@]}" build-for-testing

# XCTest runs in its own generated host, so the app's ATS settings do not apply
# to the test's loopback control connection. Change only that generated host.
python3 - <<'PYTHON'
from pathlib import Path
import plistlib
path = Path('build/DerivedData/Build/Products/Debug-iphonesimulator/SaintLookUITests-Runner.app/Info.plist')
with path.open('rb') as source:
    info = plistlib.load(source)
ats = info.setdefault('NSAppTransportSecurity', {})
domains = ats.setdefault('NSExceptionDomains', {})
for host in ('127.0.0.1', 'localhost'):
    domains.setdefault(host, {})['NSExceptionAllowsInsecureHTTPLoads'] = True
with path.open('wb') as output:
    plistlib.dump(info, output, fmt=plistlib.FMT_BINARY)
PYTHON

if [[ "${SAINT_LOOK_RECORD_VIDEO:-0}" == '1' ]]; then
  mkdir -p build/videos
  video_path="$(pwd)/build/videos/Simulator-$(date -u +%Y%m%dT%H%M%SZ).mp4"
  xcrun simctl io "$simulator_id" recordVideo --codec=h264 "$video_path" > "$work_directory/recording.log" 2>&1 &
  recording_pid=$!
  echo "Recording Simulator UI tests to $video_path"
fi

# Temporary #53 probe: collect only the name-field selection state, never general application logs.
mkdir -p build/visual-stall-diagnostics
xcrun simctl spawn "$simulator_id" log stream --level debug --style compact \
  --predicate 'eventMessage CONTAINS "[DEBUG-name-range]"' \
  > build/visual-stall-diagnostics/name-range.log 2>&1 &
name_diagnostic_pid=$!

test_options=("${build_options[@]}")
if [[ "${SAINT_LOOK_REMOTE_SMOKE:-0}" == '1' || "${SAINT_LOOK_LIVE_TRIAL:-0}" == '1' || -n "${SAINT_LOOK_VISUAL_PROFILE:-}" ]]; then
  # Shell variables are not a portable way to configure a Simulator test host.
  # Give XCTest an explicit manifest; never print or upload this secret-bearing file.
  remote_manifest="$(pwd)/build/DerivedData/Build/Products/RemoteSmoke.xctestrun"
  python3 - "$remote_manifest" <<'PYTHON'
import os, plistlib, sys
from pathlib import Path
output = Path(sys.argv[1])
inputs = [p for p in output.parent.glob('*.xctestrun') if p != output]
if len(inputs) != 1:
    raise SystemExit('Expected one generated XCTest manifest.')
with inputs[0].open('rb') as source:
    manifest = plistlib.load(source)
if 'TestConfigurations' in manifest:
    targets = [target for config in manifest['TestConfigurations'] for target in config['TestTargets']]
else:
    targets = [value for key, value in manifest.items() if not key.startswith('__') and isinstance(value, dict)]
keys = ('SAINT_LOOK_REMOTE_SMOKE', 'SAINT_LOOK_REMOTE_URL', 'SAINT_LOOK_REMOTE_TOKEN',
        'SAINT_LOOK_REMOTE_REVISION', 'SAINT_LOOK_REMOTE_DEPLOYMENT_ID')
if os.environ.get('SAINT_LOOK_LIVE_TRIAL') == '1':
    keys = tuple(key for key in keys if key != 'SAINT_LOOK_REMOTE_SMOKE') + ('SAINT_LOOK_LIVE_TRIAL', 'SAINT_LOOK_TRIAL_PHOTO_COUNT')
if os.environ.get('SAINT_LOOK_VISUAL_PROFILE'):
    if os.environ.get('SAINT_LOOK_REMOTE_SMOKE') == '1' or os.environ.get('SAINT_LOOK_LIVE_TRIAL') == '1':
        raise SystemExit('Visual fixtures cannot be combined with remote or live trials.')
    if os.environ['SAINT_LOOK_VISUAL_PROFILE'] not in ('iphone-light', 'iphone-dark', 'iphone-max-text', 'ipad-light'):
        raise SystemExit('Unknown visual profile.')
    keys = ('SAINT_LOOK_VISUAL_PROFILE',)
if any(not os.environ.get(key) for key in keys):
    raise SystemExit('Remote smoke configuration is incomplete.')
matched = 0
for target in targets:
    if target.get('BlueprintName') == 'SaintLookUITests' or 'SaintLookUITests' in target.get('TestBundlePath', ''):
        target.setdefault('EnvironmentVariables', {}).update({key: os.environ[key] for key in keys})
        matched += 1
if not matched:
    raise SystemExit('UI test target is missing from the XCTest manifest.')
with output.open('wb') as destination:
    os.chmod(output, 0o600)
    plistlib.dump(manifest, destination)
PYTHON
  test_options=(-xctestrun "$remote_manifest" -destination "platform=iOS Simulator,id=$simulator_id" -parallel-testing-enabled NO)
fi
if [[ -n "${SAINT_LOOK_UI_TEST_ONLY:-}" ]]; then
  # A newline-separated list selects a small regression set in one Simulator run.
  while IFS= read -r test_selector; do
    [[ -z "$test_selector" ]] && continue
    test_options+=("-only-testing:$test_selector")
  done <<< "$SAINT_LOOK_UI_TEST_ONLY"
fi
# Five fixed candidate checks; no retry-on-failure or run-until-success.
test_options+=(-test-iterations 5)
if [[ -n "${SAINT_LOOK_VISUAL_PROFILE:-}" && "${SAINT_LOOK_OBSERVE_VISUAL_STALLS:-0}" == 1 ]]; then
  # Observe the existing 60-second XCTest warning; do not retry or change its verdict.
  python3 scripts/observe-visual-stalls.py --udid "$simulator_id" \
    --profile "$SAINT_LOOK_VISUAL_PROFILE" --output "$(pwd)/build/visual-stall-diagnostics" \
    -- xcodebuild "${test_options[@]}" -resultBundlePath "$result_path" test-without-building
else
  xcodebuild "${test_options[@]}" -resultBundlePath "$result_path" test-without-building
fi
