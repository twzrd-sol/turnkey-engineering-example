/** Real installed policy runtime; mock Turnkey votes. No network or funds. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { evaluateIntent, createSeededDecisionSigner, createMemorySpendLedger } from "twzrd-x402-gate";
import { createMockTurnkeyApprover } from "../src/approver.js";
import { processPendingActivity } from "../src/worker.js";
import type { EvaluatePaymentFn } from "../src/decide.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mainnet-transfers.json", import.meta.url), "utf8"));
const signer = createSeededDecisionSigner(randomBytes(32).toString("hex"));
const wallet = "EKLwbUquEHL5LZFi7L3BmNybpBRF5kCPmbJHmXYkvshK";
for (const scenario of [
  { name: "CLI-equivalent local policy without intelligence allows under-cap payment", cap: "100", intel: undefined, action: "APPROVE_ACTIVITY", reason: undefined },
  { name: "CLI default $50 cap refuses the $100 fixture", cap: "50", intel: undefined, action: "REJECT_ACTIVITY", reason: undefined },
  { name: "explicitly injected wash intelligence refuses payment", cap: "100", intel: { washFlagged: true }, action: "REJECT_ACTIVITY", reason: "WASH_FLAGGED" },
  { name: "explicitly injected warn refuses payment", cap: "100", intel: { decision: "warn" as const }, action: "REJECT_ACTIVITY", reason: "TWZRD_POLICY_WARN_REFUSED" },
]) {
  let intelligenceCalls = 0;
  const evaluate: EvaluatePaymentFn = async (intent) => {
    const result = await evaluateIntent(intent, {
      signer, ledger: createMemorySpendLedger(),
      policy: { maxAmountUsd: scenario.cap, refuseWashFlagged: true },
      ...(scenario.intel ? { intelligence: () => { intelligenceCalls++; return scenario.intel!; } } : {}),
    });
    return { decision: result.decision, reasonCodes: result.reasonCodes };
  };
  const approver = createMockTurnkeyApprover();
  const result = await processPendingActivity({
    id: "policy-integration", fingerprint: "offline-fixture", status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    intent: { signTransactionIntentV2: { unsignedTransaction: Buffer.from(fixture.clean_usdc.raw_b64, "base64").toString("hex"), signWith: wallet } },
  }, { expectedSigner: wallet, evaluate, resolveOwner: () => "MerchantOwnerWa11etAAAAAAAAAAAAAAAAAAAAAAA", approver });
  assert.equal(result.decision.action, scenario.action, JSON.stringify(result.decision));
  assert.equal(approver.calls[0]?.action, scenario.action);
  assert.equal(intelligenceCalls, scenario.intel ? 1 : 0);
  if (scenario.reason) assert.ok(result.decision.reasonCodes.includes(scenario.reason), JSON.stringify(result.decision.reasonCodes));
  console.log(`ok  ${scenario.name}: ${result.decision.reasonCodes.join(",")}`);
}
