# Revalidation — September 17, 2026

## Result

The example still builds and passes offline checks, including against the newer registry dependencies tested below. This is compatibility evidence, not current live Turnkey or customer-deployment proof.

The July 14 date describes the historical 2-of-2 mainnet experiment. The source exported to this repository was a September 17 snapshot, including later 2-of-3 enrollment, mandate and receipt changes. Its dependency pins nevertheless remained old.

## Fresh-checkout matrix

Environment: Node.js 24.19.0. Baseline public commit: bcf2ecc. Registry versions checked September 17, 2026.

| Gate | Turnkey SDK | npm test | npm run typecheck | npm run pilot-smoke |
|---|---|---|---|---|
| 0.9.3 (original pin) | 6.1.1 (original pin) | PASS | PASS | PASS |
| 0.9.9 (registry latest) | 6.1.1 | PASS | PASS | PASS |
| 0.9.9 | 8.5.0 (registry latest) | PASS | PASS | PASS |

Versions were installed with `npm install --ignore-scripts --no-audit --no-fund --save-exact`, then the three commands above ran for each combination. Baseline started with `npm ci --ignore-scripts --no-audit --no-fund`. Original dependency files were restored after the experiment; this repository still pins 0.9.3 / 6.1.1. No claim is made about untested intermediate combinations or Node 20.

Logs: [baseline](validation/2026-09-17/baseline-tests.log), [new gate](validation/2026-09-17/gate099-tests.log), [new gate and SDK](validation/2026-09-17/gate099-turnkey850-tests.log), [new SDK smoke](validation/2026-09-17/gate099-turnkey850-smoke.log).

## Important finding: seller intelligence was not wired in the CLI (fixed later the same day, see below)

`src/cli.ts` calls `evaluateIntent(intent, { signer, ledger, policy })`. There is no `intelligence` provider in that call. Setting `refuseWashFlagged: true` is not itself a reputation lookup. The policy runtime only checks remote intelligence when that provider is supplied.

Accordingly, this example currently demonstrates transaction validation, local payment policy, mandate binding and approval/rejection votes. It does not demonstrate live seller-reputation enforcement. The introductory brief has been corrected to make that distinction.

The existing dry-run injects an allow/block result. Its clean fixture is a $100 USDC payment; the stock CLI defaults to a $50 cap. A dry-run ALLOW therefore does not mean that same transaction would be allowed under CLI defaults.

Added `test/policy-integration.test.ts`, now part of `npm test`, to use the actual installed policy evaluator with mock Turnkey votes:

- $100 fixture with a $100 cap and no intelligence provider: approve.
- Same fixture with the CLI default $50 cap: reject.
- Explicitly injected wash intelligence: reject with WASH_FLAGGED.
- Explicitly injected warn intelligence: reject with TWZRD_POLICY_WARN_REFUSED.

These cases pass with both gate 0.9.3 and 0.9.9. Injected intelligence is a test fixture, not a live HTTP response. Logs: [original gate](validation/2026-09-17/baseline-policy-integration.log), [current gate](validation/2026-09-17/current-policy-integration.log).

## Relationship to other TWZRD packages

Only twzrd-x402-gate and @turnkey/sdk-server are runtime dependencies of this example. Other packages do not update its behavior automatically.

| Package | Registry version observed | Relationship |
|---|---|---|
| twzrd-x402-gate | 0.9.9 | Direct policy-runtime dependency; tested above |
| @wzrd_sol/plugin-trustgate | 0.3.7 | Separate agent integration; not imported here |
| twzrd-mcp-server | 0.5.4 | Separate MCP client; not imported here |
| twzrd-doorman | 0.3.0 | Separate integration; not imported here |

No compatibility claim is made for combining those separate packages with this example.

## What remains before a customer pilot

Wire and test the intended live seller-intelligence provider if reputation is part of the pilot claim. Review current SDK compatibility against an actual isolated 2-of-3 organization. Capture a real USDC ALLOW and policy BLOCK, including Turnkey records; offline SDK mocks cannot prove service compatibility or root-quorum behavior. Keep customer recovery outside the agent runtime.

Existing production limitations remain: memory-backed spend accounting, 100-activity polling pages, restricted instruction coverage, and unresolved Token-2022 hook effects. This run did not create a wallet, sign, broadcast, inspect credentials, or revalidate July chain evidence.

RED: the earlier brief implied seller intelligence was active, while inspection and the real-policy test establish the CLI omits its provider. GREEN: the dependency matrix, typechecks, smoke checks and added policy-integration assertions pass; the brief now states the actual boundary. SCOPE: offline compatibility only, no live Turnkey or settlement validation.

## Seller intelligence wired (September 17, 2026, later the same day)

`src/intelligence.ts` wraps the gate's own `createTwzrdIntelligenceProvider` and `src/cli.ts` now passes it to `evaluateIntent` in the worker. Two knobs are pinned in code rather than read from the environment: `failOpen: false` (a vote is a signature, so an unreachable intelligence service votes REJECT even if `TWZRD_FAIL_OPEN=1` is set) and `refuseWashFlagged: true`. `TWZRD_SELLER_INTEL=off` disables the lookup; any other value than `live`/`off` is a startup error. Requests carry `X-TWZRD-Integration: twzrd-cosigner`. The worker logs one line per lookup (decision id, verdict, score, wash flag, reason) and no secrets.

### Offline: real gate HTTP client against a local mock of the intel API

`test/seller-intelligence.test.ts` (part of `npm test`) starts a loopback HTTP server that answers `POST /v1/intel/preflight` and `GET /v1/intel/merchant_card/{wallet}`, then runs the real worker with the real policy evaluator and mock Turnkey votes on the $100 USDC fixture under a $100 cap:

| Mock intel answer | Co-signer vote | Reason codes |
|---|---|---|
| decision=allow, score 82, wash_flagged=false | APPROVE | ALLOW |
| decision=warn, score 45 (never-seen seller) | REJECT | INTEL_WARN, TWZRD_POLICY_WARN_REFUSED |
| decision=block | REJECT | INTEL_BLOCK |
| decision=allow but merchant_card wash_flagged=true | REJECT | WASH_FLAGGED, INTEL_BLOCK |
| decision=allow but merchant_card returns 503 | REJECT | INTEL_BLOCK (gate 0.9.9 fail-closed; 0.9.3 approved here) |
| nothing listening, `TWZRD_FAIL_OPEN=1` in env | REJECT | INTEL_BLOCK, reason `twzrd_fail_closed` |

The test also asserts the preflight body scores the resolved owner wallet (not the token account), carries `price_usdc: 100` and the Solana mainnet CAIP-2 chain, and that the wash check was called. Log: [gate099-seller-intelligence.log](validation/2026-09-17/gate099-seller-intelligence.log). Full suite after the change: [final-tests-with-seller-intel.log](validation/2026-09-17/final-tests-with-seller-intel.log). Typecheck and pilot-smoke pass.

### Dependency pin change

twzrd-x402-gate is now pinned at 0.9.9 (was 0.9.3). The bump is deliberate: 0.9.9 distinguishes "intel answered with no wash signal" from "intel unreachable" and fails closed on the latter, and it enforces the card's `recommended_cap_usdc`. 0.9.3 approved in the 503 case. Everything else in the earlier matrix still passes on 0.9.9. @turnkey/sdk-server stays at 6.1.1.

### Read-only live check against intel.twzrd.xyz

`npm run live-intel-check -- --pay-to <wallet> --amount <usd>` runs the exact provider the worker uses against the public endpoint and prints the evaluator result and the vote the co-signer would cast. Free HTTP only; no Turnkey organization, wallet, signature or payment. Results on September 17 with gate 0.9.9:

| Seller | Amount | Live card | Evaluator | Co-signer vote |
|---|---|---|---|---|
| DB2s5Peo… (TWZRD's own x402 seller) | $1.00 | warn, score 52, recommended cap 0.25 | INTEL_BLOCK (`twzrd_over_recommended_cap_1_gt_0.25`) | REJECT |
| DB2s5Peo… | $0.20 | warn, score 52 | INTEL_WARN | REJECT |
| TW6ntaGz… (external seller from the public catalog) | $1.00 | warn, score 57.1 | INTEL_WARN | REJECT |
| AK9Bivbd… (fixture destination token account, never seen) | $1.00 | unknown subject | INTEL_BLOCK | REJECT |

Logs: `validation/2026-09-17/live-seller-intel-*.log`. The merchant_card wash check returned `wash_flagged: null` with `decision: insufficient_evidence` for all three; null is "not evaluated", never "clean", and the gate does not invent a wash flag from it.

### What this means for the pilot

The wired path works end to end and refuses conservatively. It has not yet produced a live ALLOW: none of the probed sellers is graded `allow` by the free corpus. The server upgrades `warn` to `allow` only for sellers with roughly 20 or more unique payers over 90 days, no wash or gone-dark signal and fleet revenue under half. A reputation-based ALLOW in a pilot therefore needs either such a seller or an explicit policy decision to approve `warn` under the card's recommended cap; the co-signer today rejects every `warn` by design and this run did not change that.

RED: with live intelligence on, payments to unknown or `warn`-graded sellers are refused, so a pilot cannot show an ALLOW against an arbitrary seller. GREEN: provider wired, six mock-API scenarios and the full suite pass on gate 0.9.9, and the live endpoint is reached read-only with the expected refusals. SCOPE: no Turnkey activity, signature or payment was created; the `warn` policy question is left to the operator.
