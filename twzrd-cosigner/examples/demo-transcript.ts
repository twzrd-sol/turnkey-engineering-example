/**
 * Reproducible demo transcript: what the TWZRD guard seat would vote on four
 * payments, using the real decoder, real policy evaluator and the real live
 * seller-intelligence provider, with a mock Turnkey approver in place of the
 * live 2-of-3 organization.
 *
 * Free HTTP to intel.twzrd.xyz only. No Turnkey activity, no signature, no
 * payment, no funds. The seller is passed in; nothing here contacts a seller.
 *
 *   npx tsx examples/demo-transcript.ts --allow-seller <walletGradedAllow> [--allow-amount 0.10] [--over-cap-amount 20]
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { createMemorySpendLedger, createSeededDecisionSigner, evaluateIntent } from "twzrd-x402-gate";

import { createMockTurnkeyApprover } from "../src/approver.js";
import { SOLANA_MAINNET_CAIP2, type EvaluatePaymentFn } from "../src/decide.js";
import { createSellerIntelligence, describeSellerIntel, type SellerIntelObservation } from "../src/intelligence.js";
import type { TurnkeyPendingActivity } from "../src/turnkey.js";
import { processPendingActivity } from "../src/worker.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const allowSeller = arg("--allow-seller");
if (!allowSeller) throw new Error("usage: demo-transcript.ts --allow-seller <wallet> [--allow-amount 0.10] [--over-cap-amount 20]");
const allowAmount = arg("--allow-amount", "0.10")!;
const overCapAmount = arg("--over-cap-amount", "20")!;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CLI_DEFAULT_CAP_USD = "50";

const fixtures = JSON.parse(readFileSync(new URL("../test/fixtures/mainnet-transfers.json", import.meta.url), "utf8")) as Record<string, { raw_b64: string; info: Record<string, unknown> }>;
const signer = createSeededDecisionSigner(randomBytes(32).toString("hex"));
const observations: SellerIntelObservation[] = [];
const intelligence = createSellerIntelligence({ mode: "live", runId: `demo-${Date.now()}`, onObservation: (o) => observations.push(o) })!;
const policy = { maxAmountUsd: CLI_DEFAULT_CAP_USD, refuseWashFlagged: true };

/** Same evaluator wiring as src/cli.ts runWorker. */
const evaluate: EvaluatePaymentFn = async (intent) => {
  const r = await evaluateIntent(intent, { signer, ledger: createMemorySpendLedger(), policy, intelligence });
  return { decision: r.decision, reasonCodes: r.reasonCodes };
};

type Case = { id: string; kind: "live_intelligence" | "deterministic_local"; what: string; vote: string; reasonCodes: string[]; intelligence?: SellerIntelObservation; note: string };
const cases: Case[] = [];

async function intentCase(id: string, what: string, amount: string, note: string): Promise<void> {
  const before = observations.length;
  const r = await evaluate({ protocol: "direct", network: SOLANA_MAINNET_CAIP2, asset: USDC, amount, payTo: allowSeller! }, {});
  cases.push({ id, kind: "live_intelligence", what, vote: r.decision === "allow" ? "APPROVE_ACTIVITY" : "REJECT_ACTIVITY", reasonCodes: r.reasonCodes, intelligence: observations[before], note });
}

async function activityCase(id: string, what: string, fixture: string, signWith: string, note: string): Promise<void> {
  const approver = createMockTurnkeyApprover();
  const activity: TurnkeyPendingActivity = {
    id: `demo-${fixture}`, fingerprint: `fp-${fixture}`, status: "ACTIVITY_STATUS_CONSENSUS_NEEDED", type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    intent: { signTransactionIntentV2: { unsignedTransaction: Buffer.from(fixtures[fixture].raw_b64, "base64").toString("hex"), signWith } },
  };
  const before = observations.length;
  const result = await processPendingActivity(activity, { expectedSigner: signWith, evaluate, resolveOwner: () => allowSeller!, approver });
  cases.push({ id, kind: "deterministic_local", what, vote: result.decision.action, reasonCodes: result.decision.reasonCodes, intelligence: observations[before], note });
}

await intentCase("A", `${allowAmount} USDC to an allow-graded seller`, allowAmount, "Live free preflight + wash check; approve only on an explicit allow under the card's recommended cap.");
await intentCase("D", `${overCapAmount} USDC to the same seller`, overCapAmount, "Same seller, amount above the card's recommended cap: refused by live intelligence before any signature.");
await activityCase("B", "Real mainnet transaction bytes: 100 USDC TransferChecked, worker default 50 USD cap", "clean_usdc", "EKLwbUquEHL5LZFi7L3BmNybpBRF5kCPmbJHmXYkvshK", "Whole-transaction decode then local policy; the cap refuses before intelligence is consulted (no network dependence).");
await activityCase("C", "Real mainnet transaction bytes: native SOL system transfer", "system_sol", "GoSBxCH19sMnZVEifsXeeMdEfkTv6Zh6MWvQFQF3e5m7", "A System Program transfer is not a supported payment instruction for this seat; anything the decoder cannot account for fails closed.");

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  intelligence: describeSellerIntel("live"),
  approver: "mock (records the vote the guard seat would cast); live path uses createTurnkeyApprover against the payer's 2-of-3 organization",
  policy,
  cases,
  boundaries: [
    "read-only: no Turnkey activity, signature, broadcast or payment",
    "the seller wallet is an observed public counterparty in TWZRD's settlement corpus, not a customer or partner, and was not contacted",
    "live grades and caps change; rerun before quoting",
    "the live 2-of-3 Turnkey organization is not exercised by this transcript",
  ],
}, null, 2));
