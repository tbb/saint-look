#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Backend must already run on the Mac host; the Simulator shares its loopback.
# Defaults and fixture-only credentials are in WardrobeFlowTests.swift.
if ! command -v xcodebuild >/dev/null || ! command -v xcrun >/dev/null; then
  echo "Simulator tests require macOS with Xcode and an installed iOS Simulator runtime." >&2
  exit 1
fi
xcodebuild -version
work_directory="$(mktemp -d)"
trap 'rm -rf "$work_directory"' EXIT
xcodebuild -project SaintLook.xcodeproj -scheme SaintLook -showdestinations > "$work_directory/destinations.txt"
cat "$work_directory/destinations.txt"
simulator_id="${SAINT_LOOK_SIMULATOR_UDID:-}"
if [[ -z "$simulator_id" ]]; then
  simulator_id="$(xcrun simctl list devices available --json | python3 -c '
import json, re, sys
with open(sys.argv[1]) as source:
    runnable = source.read().split("Ineligible destinations")[0]
allowed = set(re.findall(r"id:([0-9A-Fa-f-]{36})", runnable))
for runtime, devices in json.load(sys.stdin)["devices"].items():
    if ".iOS-" not in runtime:
        continue
    for device in devices:
        if device.get("isAvailable") and device["name"].startswith("iPhone") and device["udid"] in allowed:
            print(device["udid"])
            sys.exit(0)
sys.exit("No available iPhone Simulator. Install an iOS runtime in Xcode.")
' "$work_directory/destinations.txt")"
fi
xcrun simctl boot "$simulator_id" 2>/dev/null || true
xcrun simctl bootstatus "$simulator_id" -b
mkdir -p build
result_path="$(pwd)/build/UITests-$(date -u +%Y%m%dT%H%M%SZ).xcresult"
xcodebuild \
  -project SaintLook.xcodeproj \
  -scheme SaintLook \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$simulator_id" \
  -parallel-testing-enabled NO \
  -derivedDataPath build/DerivedData \
  -resultBundlePath "$result_path" \
  CODE_SIGNING_ALLOWED=NO \
  test
