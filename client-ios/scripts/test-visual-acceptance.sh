#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
# Called with the same local controlled backend/proxy as regression suites.
# No simulator environment override reaches production provider credentials.
profiles=(iphone-light iphone-dark iphone-max-text ipad-light)
if [[ "${SAINT_LOOK_VISUAL_PROFILES:-all}" != all ]]; then
  case "$SAINT_LOOK_VISUAL_PROFILES" in
    iphone-light|iphone-dark|iphone-max-text|ipad-light) profiles=("$SAINT_LOOK_VISUAL_PROFILES") ;;
    *) echo 'Unknown visual profile selection' >&2; exit 1 ;;
  esac
fi
trap 'exit 130' INT
trap 'exit 143' TERM
status=0
export SAINT_LOOK_OBSERVE_VISUAL_STALLS=1
# Every profile selects a matching model; an inherited explicit iPhone UDID must not mask iPad coverage.
unset SAINT_LOOK_SIMULATOR_UDID
for profile in "${profiles[@]}"; do
  export SAINT_LOOK_VISUAL_PROFILE="$profile"
  export SAINT_LOOK_UI_TEST_ONLY=SaintLookUITests/VisualAcceptanceTests/testPublicPhotoJourney
  export SAINT_LOOK_SIMULATOR_FAMILY=iPhone
  export SAINT_LOOK_UI_APPEARANCE=light
  export SAINT_LOOK_UI_CONTENT_SIZE=large
  export SAINT_LOOK_RECORD_VIDEO=0
  case "$profile" in
    iphone-light) export SAINT_LOOK_RECORD_VIDEO=1 ;;
    iphone-dark) export SAINT_LOOK_UI_APPEARANCE=dark ;;
    iphone-max-text) export SAINT_LOOK_UI_CONTENT_SIZE=accessibility-extra-extra-extra-large ;;
    ipad-light)
      export SAINT_LOOK_SIMULATOR_FAMILY=iPad
      # Temporary diagnostic: reproduce only retained booted-device load, not prior tests.
      mkdir -p "$root/client-ios/build"
      xcrun simctl list devices available --json > "$root/client-ios/build/ipad53-before-devices.json"
      retained_iphone="$(python3 - "$root/client-ios/build/ipad53-before-devices.json" <<'PYTHON'
import json, sys
runtime = "com.apple.CoreSimulator.SimRuntime.iOS-26-4"
devices = json.load(open(sys.argv[1]))["devices"].get(runtime, [])
matches = [device for device in devices if device["name"] == "iPhone 17 Pro" and device.get("isAvailable")]
assert len(matches) == 1, "Expected one available iPhone 17 Pro on iOS 26.4"
assert matches[0]["state"] == "Shutdown", "Probe requires a previously shut-down iPhone"
print(matches[0]["udid"])
PYTHON
      )"
      echo "[DEBUG-ipad53] Retaining booted iPhone 17 Pro, iOS 26.4, $retained_iphone; no app installed or launched"
      xcrun simctl boot "$retained_iphone"
      xcrun simctl bootstatus "$retained_iphone" -b
      xcrun simctl list devices available --json > "$root/client-ios/build/ipad53-retained-devices.json"
      ;;
  esac
  current=0
  bash "$root/client-ios/scripts/test-simulator.sh" || current=$?
  if (( current >= 128 )); then exit "$current"; fi
  if (( current != 0 )); then status=$current; fi
  # Profile and every xcresult survive failures; CI exports their attachments with always().
done
exit "$status"
