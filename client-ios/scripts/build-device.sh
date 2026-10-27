#!/bin/bash
set -euo pipefail
# No signing identity, account or token is needed during compilation.
root="$(cd "$(dirname "$0")/../.." && pwd)"
build="${RUNNER_TEMP:-$root/client-ios/build}/saint-look-device"
xcodebuild -quiet \
  -project "$root/client-ios/SaintLook.xcodeproj" -scheme SaintLook \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath "$build" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  build
app="$build/Build/Products/Release-iphoneos/SaintLook.app"
test -f "$app/SaintLook"
# Inspect the actual shipped bundle, not only compilation flags.
for fixture in TrialPhotos VisualFixtures; do
  if [[ -e "$app/$fixture" ]]; then
    echo "Debug photo fixture unexpectedly present in Release: $fixture" >&2
    exit 1
  fi
done
xcrun vtool -show-build "$app/SaintLook" | grep -q 'platform IOS$'
xcrun lipo "$app/SaintLook" -verify_arch arm64
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'app=%s\n' "$app" >> "$GITHUB_OUTPUT"
fi
