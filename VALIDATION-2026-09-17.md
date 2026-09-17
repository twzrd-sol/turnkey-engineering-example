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

## Important finding: seller intelligence is not wired in the CLI

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
