# Read-only fal access diagnostic

The first fal queue POST in run `40688465238` returned HTTP 403 at
2026-10-28 12:31:41 UTC. Its error body and request ID were not retained. The
[queue reference](https://fal.ai/docs/api-reference/inference-api/queue/submit-path.md)
lists missing permissions, model restrictions, account locks and spending limits
as possible causes. The status alone does not identify one.

`fitting-fal-access.yml` is manual-only on main, using the existing GitHub secret
in one step. It makes one GET to `api.fal.ai/v1/models/requests/by-endpoint`, for
`fal-ai/nano-banana-pro/edit`, 12:31–12:33 UTC on 2026-10-28, limit 10. It does not
expand payloads or paginate. If exactly one matching terminal-error record is
found, a second GET reads the queue result using its validated UUID. There are
no POSTs, retries, arbitrary URLs, billing requests, images or inference calls.

A record matching this endpoint and time window is only a **candidate**, not a
proven match to the original POST: its request ID was lost and input/output
storage was disabled. `sourceRunId` identifies the window being investigated;
neither it nor `record_found` proves identity. A candidate's error classification
must not be attributed categorically to the failed trial without independent
request binding from the dashboard or provider support.

The report contains only HTTP statuses, matching UUID/endpoint metadata, closed
error classifications and body hash/size/type metadata. Arbitrary messages,
headers, account details and inputs/outputs are never copied into the report.
Exact known error strings are recognized; unrecognized strings remain `unknown`.
No classification is inferred from 403 alone. The original ledger and all
reservation markers remain untouched.

The [history endpoint](https://fal.ai/docs/platform-apis/v1/models/requests/by-endpoint)
requires `models:requests:read`, included in the API preset. A key lacking that
permission may fail this read even if other operations are permitted. A
pre-queue refusal may have no history entry, and `X-Fal-Store-IO: 0` disables
history payload retention. `no_record` or `unknown` is a useful stopping result,
not permission to submit again. Use the existing dashboard or private support
to inspect the key's allowed models and account restrictions in that case.
[Key permissions](https://fal.ai/docs/documentation/model-apis/authentication/key-based),
[retention](https://fal.ai/docs/documentation/model-apis/media-expiration).

Local verification uses the CLI's loopback-only fixture option and a literal
fixture key. It never reads the real secret or calls fal. The workflow has no
provider POST capability in its CLI and must be reviewed before manual dispatch.
