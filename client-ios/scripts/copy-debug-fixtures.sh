#!/bin/bash
set -euo pipefail
# These public images serve UI tests / explicit live trials, never a shipped wardrobe.
fixture_source="${SRCROOT:?}/SaintLook"
fixture_target="${TARGET_BUILD_DIR:?}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}"
for fixture_name in TrialPhotos VisualFixtures; do
  rm -rf -- "$fixture_target/$fixture_name"
  if [[ "${CONFIGURATION:?}" == Debug ]]; then
    mkdir -p "$fixture_target"
    cp -R "$fixture_source/$fixture_name" "$fixture_target/$fixture_name"
  fi
done
