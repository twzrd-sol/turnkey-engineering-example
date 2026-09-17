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
| E | positive control: case D's block turned into an operator-signed `blocked_never_signed` attestation, verified offline | Ed25519 over the attestation leaf, key derived from the signer's PEM | n/a | genuine verifies, tampered leaf does not, bound to case D's decision id |

Cases B and C refuse before any network call, so they hold during an intelligence outage. Case A is the only path that can approve, and only on an explicit `allow` at or under the card's recommended cap. An unreachable intelligence service, a `warn` grade, a wash flag or an unknown seller all refuse (see the test suite and [VALIDATION-2026-09-17.md](VALIDATION-2026-09-17.md)).

## Buyer-gate proof: refused before the signer runs

The gate itself ships the measurable buyer-side result. From a clean install of twzrd-x402-gate 0.9.9 with the x402 dependencies, `node node_modules/twzrd-x402-gate/bin/twzrd-gate-eval-refuse.js` reaches a live 402, asks TWZRD, gets `block`, and aborts payment creation. Report captured September 17: [validation/2026-09-17/gate-eval-refuse.json](validation/2026-09-17/gate-eval-refuse.json).

```
twzrd_decision: block
signer_invocation_count: 0
payment_retry_count: 0
usdc_spent: 0
verified: true
```

The script labels this an internal self-serve transcript, not external partner proof. Case E above is the matching positive control for the verifier: a refusal produces a signed, intent-bound attestation that a relying party can check offline, and a tampered one fails.

## Boundaries

- Read-only. No Turnkey activity, signature, broadcast or payment was created.
- The allow-graded seller is an observed public counterparty in TWZRD's Solana settlement corpus, not a customer or partner, and was not contacted. It is identified by wallet only.
- Live grades and caps change and cards expire after 7 days. Rerun before quoting numbers.
- Finding an allow-graded seller: on September 17, 8 of the 40 most-paid Solana merchants in the corpus graded `allow`; none of the 7 Solana sellers in the public catalog did.

## What a funded pilot adds

Same four cases against a payer-controlled Turnkey 2-of-3 child organization created by `twzrd-cosigner setup-turnkey`, with `twzrd-cosigner preflight` attesting the quorum and `twzrd-cosigner worker` casting the votes. Acceptance evidence: quorum attestation, one approved activity with its confirmed transaction (case A shape), one rejected activity with reason and no signature (case B or C shape), and the payer's confirmation of wallet control.
