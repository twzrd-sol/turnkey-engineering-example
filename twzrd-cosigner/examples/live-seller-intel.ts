/**
 * Read-only check of the live seller-intelligence path.
 *
 * Runs the exact provider the worker uses against the public intel endpoint
 * for one intent and prints what the co-signer would do. Free HTTP only:
 * no Turnkey org, no wallet, no signing, no payment.
 *
 *   npx tsx examples/live-seller-intel.ts --pay-to <sellerWallet> [--amount 1.00]
 */
import { randomBytes } from "node:crypto";

import { createMemorySpendLedger, createSeededDecisionSigner, evaluateIntent } from "twzrd-x402-gate";

import { SOLANA_MAINNET_CAIP2 } from "../src/decide.js";
import { createSellerIntelligence, describeSellerIntel } from "../src/intelligence.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const payTo = arg("--pay-to");
if (!payTo) throw new Error("usage: live-seller-intel.ts --pay-to <sellerWallet> [--amount 1.00]");
const amount = arg("--amount", "1.00")!;

let observation: unknown;
const intelligence = createSellerIntelligence({ mode: "live", onObservation: (o) => (observation = o) })!;
const result = await evaluateIntent(
  { protocol: "direct", network: SOLANA_MAINNET_CAIP2, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount, payTo },
  { signer: createSeededDecisionSigner(randomBytes(32).toString("hex")), ledger: createMemorySpendLedger(), policy: { maxAmountUsd: "50", refuseWashFlagged: true }, intelligence },
);
const cosignerVote = result.decision === "allow" ? "APPROVE_ACTIVITY" : "REJECT_ACTIVITY";
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), mode: describeSellerIntel("live"), intent: { payTo, amountUsd: amount }, intelligence: observation, evaluator: { decision: result.decision, reasonCodes: result.reasonCodes }, cosignerVote, note: "read-only; no Turnkey activity, no signature, no payment" }, null, 2));
