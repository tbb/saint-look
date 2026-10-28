# Visual UI fixtures — Debug only

`shoes.png`: unchanged original from Wikimedia Commons, **Creepers shoes Transparent**. Original photograph by Alchemica, transparent derivative by Il Passeggero. CC BY-SA 3.0.

- Source: https://commons.wikimedia.org/wiki/File:Creepers_shoes_Transparent.png
- Download: https://upload.wikimedia.org/wikipedia/commons/d/d7/Creepers_shoes_Transparent.png
- License: https://creativecommons.org/licenses/by-sa/3.0/
- SHA-256: `df7642e0879b5a13a35cd46ca4da37173e95a6b32520f3c3c5975cebc75bd229`
- 1706 × 1344, PNG with transparency. The published derivative already removes the background; no local image modification.

The visual journey also uses the three originals under `TrialPhotos`; their attribution and hashes remain there. Those images have backgrounds. Marking local fixtures ready exercises UI composition only; it does not assert Photoroom cutout quality. No provider is called to create these fixtures.

Both directories are copied into Debug builds only by `scripts/copy-debug-fixtures.sh`. The separate `wardrobe-visual-fixtures` local catalog and explicit UI-test launch flag isolate visual fixtures from normal wardrobe data.

## Deterministic fitting layers

`fitting-{tee,jacket,jeans,shoes}.{svg,png}` are original repository test drawings, authored as simple local SVG paths and rasterized with the existing sharp dependency. Regenerate manually with `node client-ios/scripts/generate-fitting-fixtures.mjs` after installing backend dependencies. They contain no external photography, AI generation, or provider requests.

Every PNG is a transparent 1024×1024 full canvas aligned to the provisional 360×560 mannequin (SVG viewBox `-100 0 560 560`). The open burgundy jacket reveals the cream tee; blue trousers and dark shoes retain separate lower layers. These fixtures establish compositing, persistence and interaction evidence only. They do not establish garment likeness, realistic fit, generation quality or approval of trial #45.

Only the explicit DEBUG `fitting-ready` scenario seeds these four items and the named test look. Existing `ready-four` and `mixed-offline` scenarios are unchanged. All files live under the already Debug-only `VisualFixtures` resource directory and are removed from Release bundles by the existing resource-copy script.
