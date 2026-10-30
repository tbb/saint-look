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
remote_manifest=''
benchmark_fixture_directory=''
previous_content_size=''
previous_appearance=''
simulator_family="${SAINT_LOOK_SIMULATOR_FAMILY:-iPhone}"
[[ "$simulator_family" == iPhone || "$simulator_family" == iPad ]] || { echo 'Unsupported simulator family' >&2; exit 1; }
cleanup() {
  local test_status=$?
  trap - EXIT
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
  if [[ "${SAINT_LOOK_BENCHMARK:-0}" == 1 && -n "${simulator_id:-}" ]]; then
    mkdir -p build/benchmark
    xcrun simctl terminate "$simulator_id" com.saintlook.dev >/dev/null 2>&1 || true
    benchmark_container="$(xcrun simctl get_app_container "$simulator_id" com.saintlook.dev data)" || test_status=1
    if [[ -n "${benchmark_container:-}" ]]; then
      python3 - "$benchmark_container/Library/Application Support/wardrobe-benchmark-fixtures" "build/benchmark/storage.json" <<'PYTHON' || test_status=1
import hashlib, json, sys
from pathlib import Path
root, output = map(Path, sys.argv[1:])
if not root.is_dir():
    raise SystemExit('The isolated benchmark catalog was not created.')
files = [p for p in root.rglob('*') if p.is_file() and not p.is_symlink()]
sources = [p for p in files if p.name.endswith('-source.png')]
source_hashes = set()
for source in sources:
    with source.open('rb') as stream:
        source_hashes.add(hashlib.file_digest(stream, 'sha256').hexdigest())
representations = [p for p in files if p.name.startswith('representation-') and p.suffix == '.json']
data = {'scope': 'logical file bytes in the actual imported Simulator fixture root; not ZIP size or physical APFS allocation',
        'logicalBytes': sum(p.stat().st_size for p in files), 'fileCount': len(files),
        'catalogBytes': (root / 'catalog.json').stat().st_size,
        'representationBytes': sum(p.stat().st_size for p in representations),
        'representationFiles': len(representations), 'sourceFiles': len(sources),
        'uniqueSourceSHA256Count': len(source_hashes)}
output.write_text(json.dumps(data, indent=2) + '\n')
print(json.dumps(data))
PYTHON
    fi
  fi
  if [[ -n "$benchmark_fixture_directory" ]]; then rm -rf -- "$benchmark_fixture_directory"; fi
  rm -rf "$work_directory"
  exit "$test_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "${SAINT_LOOK_BENCHMARK:-0}" == 1 ]]; then
  if [[ "${SAINT_LOOK_REMOTE_SMOKE:-0}" == 1 || "${SAINT_LOOK_LIVE_TRIAL:-0}" == 1 || -n "${SAINT_LOOK_VISUAL_PROFILE:-}" ]]; then
    echo 'The isolated benchmark cannot use live, remote-smoke or visual profile configuration.' >&2
    exit 1
  fi
  benchmark_candidate_directory="$(pwd)/SaintLook/VisualFixtures/benchmark"
  [[ ! -e "$benchmark_candidate_directory" ]] || { echo 'Refusing to overwrite existing benchmark fixtures.' >&2; exit 1; }
  mkdir "$benchmark_candidate_directory"
  benchmark_fixture_directory="$benchmark_candidate_directory"
  python3 - "$benchmark_fixture_directory" <<'PYTHON'
import hashlib, io, json, os, re, stat, sys, urllib.request, zipfile
from pathlib import Path
from urllib.parse import urlparse
origin = os.environ.get('SAINT_LOOK_BENCHMARK_ORIGIN', '')
token = os.environ.get('SAINT_LOOK_BENCHMARK_TOKEN', '')
expected = os.environ.get('SAINT_LOOK_BENCHMARK_MANIFEST_SHA256', '')
revision = os.environ.get('SAINT_LOOK_BENCHMARK_REVISION', '')
url = urlparse(origin)
if not (url.scheme == 'http' and url.hostname == '127.0.0.1' and not url.username and not url.password
        and url.port is not None and 1 <= url.port <= 65535 and url.path in ('', '/') and not url.query and not url.fragment
        and re.fullmatch(r'bench-[a-f0-9]{64}', token) and re.fullmatch(r'[a-f0-9]{64}', expected)
        and re.fullmatch(r'[a-f0-9]{40}', revision)):
    raise SystemExit('Invalid isolated benchmark configuration.')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError('Benchmark redirects are forbidden.')
request = urllib.request.Request(origin.rstrip('/') + '/benchmark/bundle', headers={'Authorization': 'Bearer ' + token})
with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
    if response.status != 200:
        raise SystemExit('Benchmark bundle was not served.')
    raw = response.read(64 * 1024 * 1024 + 1)
if len(raw) > 64 * 1024 * 1024:
    raise SystemExit('Benchmark bundle is too large.')
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    names = archive.namelist()
    if len(names) != len(set(names)) or any('/' in name or '\\' in name for name in names):
        raise SystemExit('Invalid benchmark ZIP paths.')
    manifest_bytes = archive.read('manifest.json')
    if hashlib.sha256(manifest_bytes).hexdigest() != expected:
        raise SystemExit('Benchmark manifest digest mismatch.')
    manifest = json.loads(manifest_bytes)
    if not (manifest['schemaVersion'] == 1 and manifest['count'] == 300 and manifest['uniqueSources'] == 4
            and manifest['sourceRevision'] == '73700bab547ed71113dbf27db18136e054a1cca2'
            and manifest['benchmarkRevision'] == revision
            and manifest['spaceID'] == 'df268e5dab58fc14040ec8d5966455e546943406bf04380d24ee8ffcf4ca7e17'
            and manifest['tokenSHA256'] == hashlib.sha256(token.encode()).hexdigest()
            and manifest['imageProviders'] == 'synthetic-public-photo-copies'
            and manifest['sourceProvenance'] == 'public-manifest-encoder-on-runner'):
        raise SystemExit('Benchmark provenance mismatch.')
    assets = manifest['assets']
    if len({item['name'] for item in assets}) != len(assets) or set(names) != {'manifest.json', *(item['name'] for item in assets)}:
        raise SystemExit('Unexpected benchmark assets.')
    if sum(item.file_size for item in archive.infolist()) > 128 * 1024 * 1024:
        raise SystemExit('Expanded benchmark bundle is too large.')
    output = Path(sys.argv[1])
    for item in assets:
        name = item['name']
        if not re.fullmatch(r'[a-z0-9-]+\.(png|jpg|json)', name) or not 0 < item['bytes'] <= 6 * 1024 * 1024:
            raise SystemExit('Invalid benchmark asset descriptor.')
        info = archive.getinfo(name)
        if stat.S_ISLNK(info.external_attr >> 16):
            raise SystemExit('Benchmark symlinks are forbidden.')
        data = archive.read(name)
        if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise SystemExit('Benchmark asset digest mismatch.')
        (output / name).write_bytes(data)
    (output / 'manifest.json').write_bytes(manifest_bytes)
print('Verified isolated benchmark: 300 packets, four unique public sources; no production credentials.')
PYTHON
fi
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

test_options=("${build_options[@]}")
if [[ "${SAINT_LOOK_REMOTE_SMOKE:-0}" == '1' || "${SAINT_LOOK_LIVE_TRIAL:-0}" == '1' || -n "${SAINT_LOOK_VISUAL_PROFILE:-}" || "${SAINT_LOOK_BENCHMARK:-0}" == '1' ]]; then
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
if os.environ.get('SAINT_LOOK_REMOTE_DATA_VERSION'):
    keys += ('SAINT_LOOK_REMOTE_DATA_VERSION',)
if os.environ.get('SAINT_LOOK_LIVE_TRIAL') == '1':
    keys = tuple(key for key in keys if key != 'SAINT_LOOK_REMOTE_SMOKE') + ('SAINT_LOOK_LIVE_TRIAL', 'SAINT_LOOK_TRIAL_PHOTO_COUNT')
if os.environ.get('SAINT_LOOK_BENCHMARK') == '1':
    keys = ('SAINT_LOOK_BENCHMARK', 'SAINT_LOOK_BENCHMARK_ORIGIN', 'SAINT_LOOK_BENCHMARK_TOKEN',
            'SAINT_LOOK_BENCHMARK_MANIFEST_SHA256', 'SAINT_LOOK_BENCHMARK_REVISION')
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
if [[ "${SAINT_LOOK_BENCHMARK:-0}" == 1 ]]; then
  benchmark_log="$work_directory/benchmark-xcodebuild.log"
  : > "$benchmark_log"
  chmod 600 "$benchmark_log"
  benchmark_status=0
  xcodebuild "${test_options[@]}" -resultBundlePath "$result_path" test-without-building \
    | tee "$benchmark_log" || benchmark_status=$?
  mkdir -p build/benchmark
  python3 - "$benchmark_log" "$benchmark_status" <<'PYTHON' || benchmark_status=1
import json, os, sys
from pathlib import Path
allowed = {'evidence', 'phase', 'datasetItems', 'uniqueSourcePhotographs', 'syntheticClones',
           'baselineRevision', 'benchmarkRevision', 'spaceID', 'requestId', 'snapshotId',
           'HTTPPayloadBytes', 'serverHTTPMilliseconds', 'tapToFirstObservedScreenshotUpperBoundMilliseconds',
           'device', 'operatingSystem', 'testHostLogicalProcessors', 'testHostPhysicalMemoryBytes',
           'connectionClass', 'limitations'}
records = []
token = os.environ['SAINT_LOOK_BENCHMARK_TOKEN']
for line in Path(sys.argv[1]).read_text().splitlines():
    if 'BENCHMARK_REAL_IOS ' not in line:
        continue
    encoded = line.split('BENCHMARK_REAL_IOS ', 1)[1].strip()
    value = json.loads(encoded)
    if set(value) != allowed or token in encoded or value['datasetItems'] != 300 or value['uniqueSourcePhotographs'] != 4:
        raise SystemExit('Unexpected benchmark observation fields.')
    records.append(value)
if int(sys.argv[2]) == 0 and len(records) != 2:
    raise SystemExit('Successful benchmark must preserve both observations.')
Path('build/benchmark/observations.json').write_text(json.dumps({'scope': 'observed screenshot upper bounds, not exact first-frame times',
    'testExitCode': int(sys.argv[2]), 'observations': records}, indent=2) + '\n')
PYTHON
  exit "$benchmark_status"
elif [[ -n "${SAINT_LOOK_VISUAL_PROFILE:-}" && "${SAINT_LOOK_OBSERVE_VISUAL_STALLS:-0}" == 1 ]]; then
  # Observe the existing 60-second XCTest warning; do not retry or change its verdict.
  python3 scripts/observe-visual-stalls.py --udid "$simulator_id" \
    --profile "$SAINT_LOOK_VISUAL_PROFILE" --output "$(pwd)/build/visual-stall-diagnostics" \
    -- xcodebuild "${test_options[@]}" -resultBundlePath "$result_path" test-without-building
else
  xcodebuild "${test_options[@]}" -resultBundlePath "$result_path" test-without-building
fi
