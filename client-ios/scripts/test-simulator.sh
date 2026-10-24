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
simulator_id="${SAINT_LOOK_SIMULATOR_UDID:-}"
if [[ -z "$simulator_id" ]]; then
  # CoreSimulator may still be discovering preinstalled devices on a fresh runner.
  for attempt in 1 2 3; do
    xcrun simctl list devices available --json > "$work_directory/devices.json"
    xcodebuild -project SaintLook.xcodeproj -scheme SaintLook -showdestinations > "$work_directory/destinations.txt"
    cat "$work_directory/destinations.txt"
    if simulator_id="$(python3 - "$work_directory/destinations.txt" "$work_directory/devices.json" <<'PYTHON'
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
        if device.get("isAvailable") and device["name"].startswith("iPhone") and device["udid"] in allowed:
            print(device["udid"])
            sys.exit(0)
sys.exit(1)
PYTHON
    )"; then
      break
    fi
    echo "Waiting for Xcode to discover an available iPhone Simulator ($attempt/3)."
    sleep 2
  done
  if [[ -z "$simulator_id" ]]; then
    echo "No available iPhone Simulator. Install an iOS runtime in Xcode." >&2
    exit 1
  fi
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
