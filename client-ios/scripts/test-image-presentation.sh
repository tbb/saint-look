#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"${SWIFTC:-swiftc}" "$root/client-ios/SaintLook/GarmentImagePresentation.swift" \
  "$root/client-ios/scripts/tests/image-presentation.swift" -o "$work/image-checks"
"$work/image-checks"
