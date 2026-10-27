# Visual UI fixtures — Debug only

`shoes.png`: unchanged original from Wikimedia Commons, **Creepers shoes Transparent**. Original photograph by Alchemica, transparent derivative by Il Passeggero. CC BY-SA 3.0.

- Source: https://commons.wikimedia.org/wiki/File:Creepers_shoes_Transparent.png
- Download: https://upload.wikimedia.org/wikipedia/commons/d/d7/Creepers_shoes_Transparent.png
- License: https://creativecommons.org/licenses/by-sa/3.0/
- SHA-256: `df7642e0879b5a13a35cd46ca4da37173e95a6b32520f3c3c5975cebc75bd229`
- 1706 × 1344, PNG with transparency. The published derivative already removes the background; no local image modification.

The visual journey also uses the three originals under `TrialPhotos`; their attribution and hashes remain there. Those images have backgrounds. Marking local fixtures ready exercises UI composition only; it does not assert Photoroom cutout quality. No provider is called to create these fixtures.

Both directories are copied into Debug builds only by `scripts/copy-debug-fixtures.sh`. The separate `wardrobe-visual-fixtures` local catalog and explicit UI-test launch flag isolate visual fixtures from normal wardrobe data.
