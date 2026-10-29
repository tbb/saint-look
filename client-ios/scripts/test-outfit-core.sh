#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"${SWIFTC:-swiftc}" \
  "$root/client-ios/SaintLook/Models.swift" \
  "$root/client-ios/SaintLook/WardrobeTaxonomy.swift" \
  "$root/client-ios/SaintLook/Outfits.swift" \
  "$root/client-ios/SaintLook/WardrobeCatalogFile.swift" \
  "$root/client-ios/scripts/tests/outfit-core.swift" \
  -o "$work/outfit-core-checks"
cp "$root/shared/wardrobe-taxonomy.json" "$work/wardrobe-taxonomy.json"
"$work/outfit-core-checks" "$root/shared/wardrobe-taxonomy.json"
