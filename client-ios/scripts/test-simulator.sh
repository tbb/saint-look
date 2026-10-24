#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Backend must already run on the Mac host; the Simulator shares its loopback.
# Defaults and fixture-only credentials are in WardrobeFlowTests.swift.
if ! command -v xcodebuild >/dev/null || ! command -v xcrun >/dev/null; then
  echo "Simulator tests require macOS with Xcode and an installed iOS Simulator runtime." >&2
  exit 1
fi
simulator_id="${SAINT_LOOK_SIMULATOR_UDID:-}"
if [[ -z "$simulator_id" ]]; then
  simulator_id="$(xcrun simctl list devices available --json | python3 -c '
import json, sys
for runtime, devices in json.load(sys.stdin)["devices"].items():
    if ".iOS-" not in runtime:
        continue
    for device in devices:
        if device.get("isAvailable") and device["name"].startswith("iPhone"):
            print(device["udid"])
            sys.exit(0)
sys.exit("No available iPhone Simulator. Install an iOS runtime in Xcode.")
')"
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
