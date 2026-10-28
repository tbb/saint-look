# JEV rounded-response regression

`jev-rounded-response.json` is the unchanged `replay` projection of the sanitized
response from [diagnostic run 40683876977](https://github.com/tbb/saint-look/actions/runs/40683876977).
It contains only model, usage and the enumerated/numeric answers allowed by the
diagnostic capture policy. It contains no images, headers or arbitrary text.

- Original sanitized `response.json` SHA-256:
  `eddf234c18f000d087c2dc237f46a56c1661036b8f01f9d9be4bae1ea78f4726`.
- This formatted projection SHA-256:
  `c1a0ac55ee09885374130217d16b7df322206ed146dba1a35dd227940ca12503`.

The recorded `item_type` probabilities total 0.99 (binary floating point:
0.9900000000000001). The previous 0.001 sum tolerance rejects this answer.
Changing only the sum guard allows the complete saved response to validate;
the observed values, confidence and low-confidence `unknown` behavior stay intact.
The earlier failed trial did not retain its response, so this does not establish
the cause of that earlier failure.

[Choice documentation](https://docs.typesafe.ai/primitives/choice) requires a
complete distribution and a maximum-probability selected choice.
[OpenAPI](https://api.typesafe.ai/openapi.json) describes an approximate total of
one, but gives no decimal precision guarantee (checked 2026-10-28).
The hundredth rounding model is an inference from the captured answer, not a
provider guarantee. For values on the hundredth grid, validation accepts only
when the sum can reach one within each value's ±0.005 rounding interval, clipped
to [0,1]. This scales with the option count and handles rounded zeros. It does
not normalize or replace the observed probabilities. Values off that grid keep
the original 0.001 tolerance. All key, range, finite-number, maximum-choice,
confidence, model and usage checks remain in force.

Only the fitting experiment adapter changes. This fixture is replayed through
the trial CLI and a loopback HTTP provider, without paid requests. Existing live
admission and one-shot markers are untouched; this fix does not authorize or
resume a trial.
