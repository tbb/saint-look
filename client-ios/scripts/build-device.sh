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
# Embed public build provenance after compilation; no owner credentials are read.
python3 - "$app/Info.plist" "$root" <<'PYINFO'
from pathlib import Path
import plistlib, re, subprocess, sys
info_path, source_root = Path(sys.argv[1]), sys.argv[2]
revision = subprocess.check_output(['git', '-C', source_root, 'rev-parse', 'HEAD'], text=True).strip()
if not re.fullmatch(r'[0-9a-f]{40}', revision):
    raise SystemExit('Build source revision is unavailable')
tracked_changes = subprocess.check_output(['git', '-C', source_root, 'status', '--porcelain', '--untracked-files=no'], text=True)
info = plistlib.loads(info_path.read_bytes())
info['SaintLookBuildRevision'] = revision
info['SaintLookBuildSourceClean'] = not tracked_changes.strip()
info_path.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
PYINFO
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
