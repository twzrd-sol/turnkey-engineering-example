# TWZRD × Turnkey — engineering review

Prepared September 17, 2026. Source snapshot: 791087e5c8ed6bdc326acaed77837757ca53c0e0.

**Revalidated September 17, 2026:** [dependency matrix, findings and limits](VALIDATION-2026-09-17.md). Later the same day the worker was wired to TWZRD seller intelligence (fail-closed) and checked read-only against the live endpoint; see the [seller-intelligence section](VALIDATION-2026-09-17.md#seller-intelligence-wired-september-17-2026-later-the-same-day).

## What we would like to explore

TWZRD offers payment-policy and seller-reputation components. This Turnkey example adds a TWZRD approval vote to a payer-controlled Solana wallet and wires local payment policy plus TWZRD seller intelligence (the free preflight and wash check on intel.twzrd.xyz), fail-closed. Only a seller the live corpus grades `allow` can be approved; unknown or `warn`-graded sellers and any intelligence outage are refused. This is an internal implementation seeking engineering review and a small customer pilot, not an existing customer deployment. It does not verify the seller’s identity or guarantee service delivery.

## Integration boundary

The current package creates an isolated Turnkey child organization with three root users: customer hot key, TWZRD guard, and customer recovery key; threshold two. Normal operation uses hot + guard. Customer hot + recovery can bypass the guard deliberately. Recovery must remain outside the agent runtime. TWZRD cannot authorize a payment alone.

Flow: final unsigned transaction → authenticated mandate containing transaction digest, recipient, asset, amount, rail, policy and expiry → Turnkey pending signing activity → whole-transaction decode and policy evaluation → approve/reject vote. The worker binds the mandate to one activity and writes a signed vote receipt after Turnkey accepts its vote. That receipt is not proof of settlement or delivery.

Only an explicit allow is approved; warn, block, wash-flagged sellers, an unreachable intelligence service, malformed transactions, mandate mismatches and unsupported transaction shapes are rejected. `TWZRD_SELLER_INTEL=off` disables the lookup and leaves local policy only. Supported pilot shape: a single USDC TransferChecked payment to an existing token account. Unknown instructions, multiple transfers, ATA creation and unresolved lookup-table accounts fail closed.

## Evidence and its limits

| Evidence | What it supports | Limitation |
|---|---|---|
| Included source, tests and fresh validation logs | Adapter, decoding, mandate binding, quorum checks, signed vote receipts, offline approve/reject behavior, seller-intelligence approve/refuse against a local mock of the intel API | Offline tests use mocks; no customer or live Turnkey behavior is established by this run |
| Read-only live intelligence logs (validation/2026-09-17/live-seller-intel-*.log) | The wired provider reaches the public endpoint; the co-signer approves established sellers up to the card's recommended cap and refuses `warn`, over-cap, blocked and unknown sellers | Free HTTP only; no Turnkey activity, signature or payment; the vote shown is what the worker would cast, not a recorded Turnkey vote |
| Repository-documented July 14, 2026 internal mainnet experiment | Historical report of an allowed 0.001 SOL transfer and rejected transaction with an unaccounted instruction | TWZRD-owned 2-of-2 organization and separate harness; not the current 2-of-3 setup CLI |
| Historical ALLOW transaction link below | Public reference for the transfer | Not independently revalidated for this packet; chain data alone cannot establish quorum causality or the rejected outcome |

Historical transaction reference:
https://explorer.solana.com/tx/4QoxYYAy1JhByfH7A5WsaTj9wsiEcUBEnYWAAqbBghQRpa68WLMADzKsnE9ouDoDSHMEdBKGvbxRZu14mj6zFScu?cluster=mainnet-beta

The historical harness supplied a SOL/USD rate. The current CLI prices known stablecoins only and refuses unpriced SOL. Historical Turnkey activity records and harness logs are not included in this packet; the historical BLOCK claim comes from internal documentation and is not independently reproduced here.

## Inspect or reproduce without credentials

Clone or download this repository; use Node.js 20 or later:

```sh
cd twzrd-cosigner
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
npm run pilot-smoke
npm run dry-run -- --block
# npm test also exercises the real installed policy evaluator and a local mock of the intel API.
npm run live-intel-check -- --pay-to <sellerWallet> --amount 1.00   # read-only against intel.twzrd.xyz
```

The dry-run injects both the decision and a mock Turnkey approver. Setup-print emits placeholder public keys and makes no API call. Neither command creates a wallet, signs, or broadcasts. Dependency installation requires registry access.

Start with src/setup-turnkey.ts, src/quorum.ts, src/turnkey-approver.ts, src/worker.ts, src/mandate.ts and src/intelligence.ts. The twzrd-cosigner directory includes the lockfile, source, fixtures and tests. Use this source snapshot rather than assuming a public npm release. It pins @turnkey/sdk-server 6.1.1 and twzrd-x402-gate 0.9.9 (bumped from 0.9.3 on September 17 because 0.9.9 makes the wash lookup fail-closed and enforces the card's recommended cap); a pilot should review these versions.

## Questions for engineering

1. Is this child-organization root-quorum design an appropriate supported integration for your customers, including recovery and administrative changes?
2. Is polling pending signing activities the right integration point, or is there a preferred event-driven flow?
3. Can we work through one small customer-controlled 2-of-3 example: an allowed USDC payment and a policy-refused signing request?

Acceptance evidence for that pilot: configuration attestation, approved activity plus confirmed transaction, rejected activity with reason and no signing result, and customer confirmation of wallet control. First use a deterministic amount-cap or unsupported-instruction refusal. A reputation-based ALLOW needs a seller the live corpus grades `allow` (roughly 20+ unique payers over 90 days, no wash or fleet signal). Such sellers exist: on September 17, 8 of the 40 most-paid Solana merchants graded `allow`, and the read-only check approved payments to them up to a $10 cap. The 7 sellers in the public catalog all graded `warn` or `block` and would be refused.

Before a production deployment: address durable spend accounting (currently memory-backed), queue pagination (100 activities per cycle), unsupported transaction shapes and Token-2022 hook behavior. No claim of customer adoption, production readiness or universal transaction coverage is made.

Public product reference: https://intel.twzrd.xyz/llms.txt
