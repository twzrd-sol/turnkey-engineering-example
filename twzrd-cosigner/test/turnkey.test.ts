/**
 * Turnkey approver-adapter tests. TWZRD is a consensus approver on the payer's own
 * Turnkey org: a pending SIGN_TRANSACTION_V2 activity carries `unsignedTransaction`
 * (Turnkey encodes Solana as hex). The adapter decodes it, decides, and returns the
 * stamped action to make (ApproveActivity / RejectActivity) + the activity fingerprint.
 * A DENY means TWZRD never approves, so the payer's wallet never signs.
 *
 * Run: npx tsx test/turnkey.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decideTurnkeyActivity, type TurnkeyPendingActivity } from "../src/turnkey.js";
import type { EvaluatePaymentFn } from "../src/decide.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(
  readFileSync(join(here, "fixtures", "mainnet-transfers.json"), "utf8"),
) as Record<string, { raw_b64: string }>;

const hex = (b64: string) => Buffer.from(b64, "base64").toString("hex");
const CLEAN_SIGNER = "EKLwbUquEHL5LZFi7L3BmNybpBRF5kCPmbJHmXYkvshK";
const LEGACY_SIGNER = "6oi5E1YtJV7u8UbWXn6heFMRhRi1gXXvVUTSkhQSVzc4";
const resolveOwner = () => "MerchantOwnerWa11etAAAAAAAAAAAAAAAAAAAAAAA";
const allowAll: EvaluatePaymentFn = async () => ({ decision: "allow", reasonCodes: ["ALLOW"] });
const blockAll: EvaluatePaymentFn = async () => ({
  decision: "block",
  reasonCodes: ["INTEL_BLOCK"],
});

function activity(
  unsignedTransaction: string,
  signWith = CLEAN_SIGNER,
): TurnkeyPendingActivity {
  return {
    id: "act-123",
    fingerprint: "fp-abc",
    status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    intent: { signTransactionIntentV2: { unsignedTransaction, signWith } },
  };
}

/* 1. A clean, priceable, allowed USDC payment -> APPROVE_ACTIVITY with the fingerprint. */
{
  const act = activity(hex(FIX.clean_usdc.raw_b64));
  const r = await decideTurnkeyActivity(act, {
    evaluate: allowAll,
    resolveOwner,
    expectedSigner: CLEAN_SIGNER,
  });
  assert.equal(r.action, "APPROVE_ACTIVITY");
  assert.equal(r.fingerprint, "fp-abc", "the ApproveActivity must target the pending fingerprint");
  assert.equal(r.verdict, "allow");
  console.log("ok  clean allowed tx -> APPROVE_ACTIVITY(fp-abc)");
}

/* 2. A blocked counterparty -> REJECT_ACTIVITY. No TWZRD approval == wallet never signs. */
{
  const act = activity(hex(FIX.clean_usdc.raw_b64));
  const r = await decideTurnkeyActivity(act, {
    evaluate: blockAll,
    resolveOwner,
    expectedSigner: CLEAN_SIGNER,
  });
  assert.equal(r.action, "REJECT_ACTIVITY");
  assert.equal(r.verdict, "deny");
  assert.ok(r.reasonCodes.includes("INTEL_BLOCK"));
  console.log("ok  blocked tx -> REJECT_ACTIVITY");
}

/* 2b. A bundled tx (extra instruction beyond the payment) -> REJECT via the whole-tx
 *     guard, even though the payment leg itself would be allowed. */
{
  const act = activity(hex(FIX.legacy_simple.raw_b64), LEGACY_SIGNER);
  const r = await decideTurnkeyActivity(act, {
    evaluate: allowAll,
    resolveOwner,
    expectedSigner: LEGACY_SIGNER,
  });
  assert.equal(r.action, "REJECT_ACTIVITY");
  assert.ok(r.reasonCodes.includes("TWZRD_UNACCOUNTED_INSTRUCTION"));
  console.log("ok  bundled tx -> REJECT via whole-tx guard");
}

/* 3. Fail-closed: an unparseable unsignedTransaction is REJECTED, never approved. */
{
  const act = activity("deadbeefnothex!!"); // not valid hex/base64 -> decode throws
  const r = await decideTurnkeyActivity(act, {
    evaluate: allowAll,
    resolveOwner,
    expectedSigner: CLEAN_SIGNER,
  });
  assert.equal(r.action, "REJECT_ACTIVITY");
  assert.ok(r.reasonCodes.includes("TWZRD_DECODE_ERROR"), "undecodable input fails closed");
  console.log("ok  undecodable unsignedTransaction -> fail-closed REJECT");
}

/* 4. A non-payment / non-sign activity type is not our concern -> abstain (no action). */
{
  const act: TurnkeyPendingActivity = {
    id: "act-x",
    fingerprint: "fp-x",
    status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
    type: "ACTIVITY_TYPE_CREATE_API_KEYS",
    intent: {},
  };
  const r = await decideTurnkeyActivity(act, {
    evaluate: allowAll,
    resolveOwner,
    expectedSigner: CLEAN_SIGNER,
  });
  assert.equal(r.action, "ABSTAIN", "we only vote on transaction-signing activities");
  console.log("ok  non-sign activity -> ABSTAIN");
}

/* 5. The guarded key cannot be used only as fee payer for someone else's transfer. */
{
  let called = false;
  const guardedFeePayer = "3qk8ftiB5rDdx5cR4kbWHh8qmVFXfPwprKADm7jquHRv";
  const act = activity(hex(FIX.legacy_simple.raw_b64), guardedFeePayer);
  const r = await decideTurnkeyActivity(act, {
    evaluate: async () => {
      called = true;
      return { decision: "allow", reasonCodes: ["ALLOW"] };
    },
    resolveOwner,
    expectedSigner: guardedFeePayer,
  });
  assert.equal(r.action, "REJECT_ACTIVITY");
  assert.ok(r.reasonCodes.includes("TWZRD_SIGNER_NOT_TRANSFER_AUTHORITY"));
  assert.equal(called, false, "authority binding rejects before the policy brain");
  console.log("ok  guarded fee-payer-only signer -> fail-closed REJECT");
}

/* 6. A signWith value outside the configured guarded wallet is never voted through. */
{
  const act = activity(hex(FIX.clean_usdc.raw_b64), "UnexpectedTurnkeySigner");
  const r = await decideTurnkeyActivity(act, {
    evaluate: allowAll,
    resolveOwner,
    expectedSigner: CLEAN_SIGNER,
  });
  assert.equal(r.action, "REJECT_ACTIVITY");
  assert.ok(r.reasonCodes.includes("TWZRD_UNEXPECTED_SIGNER"));
  console.log("ok  unexpected Turnkey signWith -> fail-closed REJECT");
}

console.log("\nTURNKEY: all assertions passed");
