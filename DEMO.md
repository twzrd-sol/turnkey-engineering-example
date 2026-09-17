# Demo: what the TWZRD guard seat votes, reproducibly

Generated September 17, 2026 from this repository at the commit that added this file. Transcript: [validation/2026-09-17/demo-transcript.json](validation/2026-09-17/demo-transcript.json).

Headline: TWZRD decides whether an autonomous payment should be signed; Turnkey supplies the payer-controlled 2-of-3 quorum that enforces the decision. This transcript shows the decision half with the real decoder, real policy evaluator and the live seller-intelligence service. The Turnkey approver is a mock that records the vote; the live 2-of-3 organization is not exercised here.

## Four cases, one command

```sh
cd twzrd-cosigner
npm ci --ignore-scripts --no-audit --no-fund
npm run demo -- --allow-seller <walletGradedAllow>
```

| Case | Payment | Source of the decision | Vote | Reason codes |
|---|---|---|---|---|
| A | 0.10 USDC to a seller the live corpus grades `allow` (205 unique payers, 90 days) | live preflight + wash check | APPROVE | ALLOW |
| D | 20 USDC to the same seller, above its 10 USDC recommended cap | live preflight | REJECT | INTEL_BLOCK (`twzrd_over_recommended_cap_20_gt_10`) |
| B | real mainnet bytes: 100 USDC TransferChecked, worker default 50 USD cap | whole-transaction decode, local policy | REJECT | POLICY_MAX_AMOUNT, twzrd_budget_exceeded |
| C | real mainnet bytes: native SOL System Program transfer | whole-transaction decode | REJECT | TWZRD_UNACCOUNTED_INSTRUCTION |

Cases B and C refuse before any network call, so they hold during an intelligence outage. Case A is the only path that can approve, and only on an explicit `allow` at or under the card's recommended cap. An unreachable intelligence service, a `warn` grade, a wash flag or an unknown seller all refuse (see the test suite and [VALIDATION-2026-09-17.md](VALIDATION-2026-09-17.md)).

## Boundaries

- Read-only. No Turnkey activity, signature, broadcast or payment was created.
- The allow-graded seller is an observed public counterparty in TWZRD's Solana settlement corpus, not a customer or partner, and was not contacted. It is identified by wallet only.
- Live grades and caps change and cards expire after 7 days. Rerun before quoting numbers.
- Finding an allow-graded seller: on September 17, 8 of the 40 most-paid Solana merchants in the corpus graded `allow`; none of the 7 Solana sellers in the public catalog did.

## What a funded pilot adds

Same four cases against a payer-controlled Turnkey 2-of-3 child organization created by `twzrd-cosigner setup-turnkey`, with `twzrd-cosigner preflight` attesting the quorum and `twzrd-cosigner worker` casting the votes. Acceptance evidence: quorum attestation, one approved activity with its confirmed transaction (case A shape), one rejected activity with reason and no signature (case B or C shape), and the payer's confirmation of wallet control.
