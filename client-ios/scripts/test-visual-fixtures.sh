#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"${SWIFTC:-swiftc}" -D DEBUG \
  "$root/client-ios/SaintLook/Models.swift" \
  "$root/client-ios/SaintLook/WardrobeTaxonomy.swift" \
  "$root/client-ios/SaintLook/Outfits.swift" \
  "$root/client-ios/SaintLook/WardrobeCatalogFile.swift" \
  "$root/client-ios/SaintLook/VisualFixtures.swift" \
  "$root/client-ios/scripts/tests/visual-fixtures.swift" \
  -o "$work/visual-fixture-checks"
cp "$root/shared/wardrobe-taxonomy.json" "$work/wardrobe-taxonomy.json"
"$work/visual-fixture-checks" "$root/client-ios/SaintLook" "$root/shared/wardrobe-taxonomy.json"
