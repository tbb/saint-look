# Similar replacement (#70)

`POST /v1/recommendations/single` is the existing authenticated single-place
contract. Optional `intent` is `complement` (default, #69) or `similar`.
All responses echo the intent. Similar responses also identify
`rankingVersion: observable-context-v1`.

For similar intent the original must be in `items` with an active prepared
representation. Original and admissible candidates carry `effectiveFeatures`,
the complete published illustration feature object (`version`, display `type`,
display `colors`, and `traits`). It is not the editable manual draft. The server
checks its canonical digest against the delivered preparation receipt's
`artifacts.effectiveFeaturesSHA256` and matches its type/colours against the
representation input. Missing original returns 400 `similarity_source_required`;
missing required traits returns 400 `similarity_features_required`; substituted
or inconsistent evidence returns 400 `invalid_prepared_item`.

Other admission, exclusion, category, pin, duplicate, body-layer and stale-response
rules are unchanged. The original is excluded from candidates **and** model
context. Every other occupied place is fixed. No exact-analogue requirement and no
score cutoff removes an otherwise admissible candidate. No alternative leaves
the composition unchanged. Errors are not replaced by random results.

## Explicit ranking method

Observable style similarity is the arithmetic mean of available comparisons:

- exact type equality (always available);
- Jaccard similarity of the main colour sets, only when both are nonempty;
- exact silhouette equality, only when both values are observed;
- exact pattern equality, only when both values are observed.

`unknown` and `not_applicable` observations are omitted, not treated as matches
or penalties. This means evidence-poor candidates can receive a score from fewer
components; it is a stated heuristic limitation, not calibrated confidence.

With nonempty context, `score = 0.5 * observableStyle + 0.5 * (cosine + 1) / 2`.
Cosine is the actual OutfitTransformer-LaBSE complement-context metric. Clamping
cosine to [-1,1] contains floating-point drift only. We do not interpret the
projected item embedding as a proven visual-similarity model or a whole-look score.
With no other occupied place, similar intent ranks only the explicit observations,
without calling the context model. Complement intent still returns `empty_context`.
An error for a nonempty model context never invokes this observation-only branch.
Exact ties use ascending item UUID, independent of input order.

Weights are a transparent product choice for this first implementation, not a
trained or validated taste metric. They need user acceptance on actual wardrobes.

## Public observation and verification

`backend/test/recommendations-similar.test.mjs` exercises both intentions,
soft imperfect alternatives, pins/exclusions, source admission, trait-digest
binding and context-free similar replacement through the existing HTTP server.
The common #69 tests retain deletion/version races and model/network failure cases.
No image stage or encoder is rerun by a recommendation.

`backend/test/real-similarity.mjs` is an opt-in, unpaid actual-checkpoint experiment:

```sh
SAINT_LOOK_REAL_MODEL_TEST=1 \
SAINT_LOOK_PUBLIC_DATASET=/path/to/epic63-public-v1 \
SAINT_LOOK_MODEL_PYTHON=/path/to/python \
SAINT_LOOK_MODEL_ASSETS=/path/to/assets \
SAINT_LOOK_SIMILAR_EVIDENCE=/tmp/similarity.json \
node --test backend/test/real-similarity.mjs
```

The checked input is six public photographs from the existing attributed manifest.
The comparison replaces a white T-shirt with blue jeans fixed. None of the four
alternatives is another T-shirt. Context-only selected the light polo; similar
intent selected the white sweater. See `recommendation-similar-measurements.json`
for exact image digests, per-candidate cosine/style/combined scores and local HTTP
times. These are observed program results, not an assertion that either outfit
has good taste. Some observable traits are explicit agent-reviewed input fixtures;
unknown source traits are omitted. There was no JEV/fal/Photoroom call. Synthetic
delivered receipts isolate ranking and do not prove full live preparation or
manual application acceptance. WAN and first rendered iOS frame remain unmeasured.

The editor exposes both intentions on the same occupied, unpinned place, in new
and saved-look editing. It applies one draft mutation with one undo, never implicit
save. The manual two-intention device demonstration is still required for issue
closure; automated HTTP evidence does not replace it.
