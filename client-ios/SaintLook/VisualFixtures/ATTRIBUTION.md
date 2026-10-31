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

## Real generation regression examples (#99)

`fitting-trial-{tee,jeans,hoodie,polo}.png` are real Gemini image outputs, segmented with Photoroom sandbox and placed on the shared mannequin canvas. Watermarks remain intact. Generated 31 October 2026: tee uses the second prompt revision; other items use the first. These are UI render fixtures, with explicitly controlled representations (`visual-fixture-only`), not proof of learned recommendation quality. No provider is called when the DEBUG-only `fitting-trial-ready` scenario loads. They are excluded from Release.

Sources and derivative licenses:

- Tee: [Worn T-shirt white](https://commons.wikimedia.org/wiki/File:Worn_T-shirt_white.png), Taylor 49, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- Polo: [Classical polo shirt](https://commons.wikimedia.org/wiki/File:Classical_polo_shirt.jpg), Elkagye, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
- Jeans: [Black Jeans](https://commons.wikimedia.org/wiki/File:Black_Jeans_(3168529272).jpg), Marcus Quigmire, [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/). Original hash in `docs/research/epic63-public-manifest.json`.
- Hoodie: [Celine Hoodie](https://commons.wikimedia.org/wiki/File:Celine_Hoodie.jpg), 킥스타일, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Source normalized to PNG, then illustrated and aligned; not an endorsement by the photographer or brand.

All transformations preserve the garment's identifying details as far as the observed generated result permits; semantic fidelity is assessed visually, not asserted by the geometry test.
