# Isolated fal garment comparison (#118)

Diagnostic branch only; no production provider or saved item changes. The nine initial cases use the user's three original photos. FASHN receives the current SwiftUI mannequin contour (open arm pose); editors receive the original plus the production measured pose guide for tops, original only for trousers. Editors use a square 1024 composition. There is no extra Photoroom unfolding before these candidates, so comparison against the historical accepted Gemini results is an end-result comparison, not equal pipeline cost or equal attempt count.

The baseline is the accepted v6 hoodie from run41479059754 and tee/trousers from run41480143001. Those results include a correction for hoodie/tee. Three photos cannot establish broad generalization. Native alpha, source ratio and existing geometry admission are diagnostics, not complete identity verification. FASHN returns a whole figure, and a synthetic target mannequin is outside the documented person-photo input guarantee.

Run the existing manual workflow `gemini-public-photo-trial.yml` at `codex/fal-garment-comparison`, batch `initial`. A separately chosen `repeat-*` batch submits three more outputs after visual inspection. No workflow rerun is allowed: an ambiguous paid outcome requires receipt recovery, not submission again. Read-only queue polling never retries a POST. All source images, prompts with references, receipts and outputs are encrypted; the public summary contains no image URLs or credentials.

Local no-network plan validation:

```sh
GARMENT_QUALITY_TRIAL_KEY_FILE=/path/to/local/key node scripts/fitting/fal-comparison/run.mjs --plan
```

Provider contracts and pricing sources: `docs/research/fal-garment-comparison.md`.
