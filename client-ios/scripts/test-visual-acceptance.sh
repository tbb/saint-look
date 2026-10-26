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
# Every profile selects a matching model; an inherited explicit iPhone UDID must not mask iPad coverage.
unset SAINT_LOOK_SIMULATOR_UDID
for profile in "${profiles[@]}"; do
  export SAINT_LOOK_VISUAL_PROFILE="$profile"
  export SAINT_LOOK_UI_TEST_ONLY=SaintLookUITests/VisualAcceptanceTests
  export SAINT_LOOK_SIMULATOR_FAMILY=iPhone
  export SAINT_LOOK_UI_APPEARANCE=light
  export SAINT_LOOK_UI_CONTENT_SIZE=large
  export SAINT_LOOK_RECORD_VIDEO=0
  case "$profile" in
    iphone-light) export SAINT_LOOK_RECORD_VIDEO=1 ;;
    iphone-dark) export SAINT_LOOK_UI_APPEARANCE=dark ;;
    iphone-max-text) export SAINT_LOOK_UI_CONTENT_SIZE=accessibility-extra-extra-extra-large ;;
    ipad-light) export SAINT_LOOK_SIMULATOR_FAMILY=iPad ;;
  esac
  current=0
  bash "$root/client-ios/scripts/test-simulator.sh" || current=$?
  if (( current >= 128 )); then exit "$current"; fi
  if (( current != 0 )); then status=$current; fi
  # Profile and every xcresult survive failures; CI exports their attachments with always().
done
exit "$status"
