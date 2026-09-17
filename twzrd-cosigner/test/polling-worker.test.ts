/** Polling worker tests over the unified approver port; no timers or network. */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TurnkeyApprover } from "../src/approver.js";
import type { EvaluatePaymentFn } from "../src/decide.js";
import type { TurnkeyAction, TurnkeyPendingActivity } from "../src/turnkey.js";
import { processPendingOnce, runCosignerWorker } from "../src/worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(
  readFileSync(join(here, "fixtures", "mainnet-transfers.json"), "utf8"),
) as Record<string, { raw_b64: string }>;
const hex = (b64: string) => Buffer.from(b64, "base64").toString("hex");
const CLEAN_SIGNER = "EKLwbUquEHL5LZFi7L3BmNybpBRF5kCPmbJHmXYkvshK";
const resolveOwner = () => "MerchantOwnerWa11etAAAAAAAAAAAAAAAAAAAAAAA";
const allowAll: EvaluatePaymentFn = async () => ({
  decision: "allow",
  reasonCodes: ["ALLOW"],
});

function activity(id: string, unsignedTransaction: string): TurnkeyPendingActivity {
  return {
    id,
    fingerprint: `fp-${id}`,
    status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    intent: {
      signTransactionIntentV2: {
        unsignedTransaction,
        signWith: CLEAN_SIGNER,
      },
    },
  };
}

function unsupportedComputeTx(): string {
  const raw = Buffer.from(FIX.clean_usdc.raw_b64, "base64");
  const setLimit = Buffer.from("02f4010000", "hex");
  const offset = raw.indexOf(setLimit);
  assert.ok(offset >= 0, "fixture contains SetComputeUnitLimit(500)");
  raw[offset] = 1;
  return raw.toString("hex");
}

class MockApprover implements TurnkeyApprover {
  readonly votes: Array<{ action: TurnkeyAction; fingerprint: string }> = [];

  constructor(
    readonly pending: TurnkeyPendingActivity[],
    readonly failFingerprint?: string,
  ) {}

  async listPendingSignActivities() {
    return this.pending;
  }

  async stamp(action: TurnkeyAction, fingerprint: string) {
    if (fingerprint === this.failFingerprint) throw new Error("Turnkey unavailable");
    if (action !== "ABSTAIN") this.votes.push({ action, fingerprint });
    return { ok: true, dryRun: false };
  }
}

/* One cycle makes ALLOW + fail-closed decisions and never votes on a non-sign activity. */
{
  const nonSign: TurnkeyPendingActivity = {
    id: "other",
    fingerprint: "fp-other",
    status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
    type: "ACTIVITY_TYPE_CREATE_API_KEYS",
    intent: {},
  };
  const approver = new MockApprover([
    activity("allow", hex(FIX.clean_usdc.raw_b64)),
    activity("block", unsupportedComputeTx()),
    nonSign,
  ]);
  const result = await processPendingOnce({
    approver,
    expectedSigner: CLEAN_SIGNER,
    evaluate: allowAll,
    resolveOwner,
  });
  assert.deepEqual(approver.votes, [
    { action: "APPROVE_ACTIVITY", fingerprint: "fp-allow" },
    { action: "REJECT_ACTIVITY", fingerprint: "fp-block" },
  ]);
  assert.deepEqual(result, {
    processed: 3,
    approved: 1,
    rejected: 1,
    abstained: 1,
    errors: 0,
  });
  console.log("ok  polling cycle approves clean, rejects unaccounted, abstains non-sign");
}

/* A transient vote error leaves the activity pending and never fails open. */
{
  const approver = new MockApprover(
    [activity("allow", hex(FIX.clean_usdc.raw_b64))],
    "fp-allow",
  );
  let errors = 0;
  const result = await processPendingOnce({
    approver,
    expectedSigner: CLEAN_SIGNER,
    evaluate: allowAll,
    resolveOwner,
    onError: () => {
      errors += 1;
    },
  });
  assert.deepEqual(approver.votes, []);
  assert.equal(result.errors, 1);
  assert.equal(result.approved, 0);
  assert.equal(errors, 1);
  console.log("ok  Turnkey vote error leaves pending without approval");
}

/* Result hook runs only after an accepted vote and carries the transaction id. */
{
  const unsigned = hex(FIX.clean_usdc.raw_b64);
  const approver = new MockApprover([activity("receipt", unsigned)]);
  let observed: { action: string; decisionId?: string; stampOk: boolean } | undefined;
  const result = await processPendingOnce({
    approver,
    expectedSigner: CLEAN_SIGNER,
    evaluate: allowAll,
    resolveOwner,
    policyId: "partner.v1",
    onResult: (_activity, decision, stamp) => {
      observed = {
        action: decision.action,
        decisionId: decision.decisionId,
        stampOk: stamp.ok,
      };
    },
  });
  assert.equal(result.approved, 1);
  assert.equal(observed?.action, "APPROVE_ACTIVITY");
  assert.match(observed?.decisionId ?? "", /^[0-9a-f]{64}$/);
  assert.equal(observed?.stampOk, true);
  console.log("ok  accepted vote exposes transaction-bound receipt callback");
}

/* Brain failure is explicitly rejected; approval is impossible. */
{
  const approver = new MockApprover([
    activity("brain-error", hex(FIX.clean_usdc.raw_b64)),
  ]);
  const result = await processPendingOnce({
    approver,
    expectedSigner: CLEAN_SIGNER,
    evaluate: async () => {
      throw new Error("brain unavailable");
    },
    resolveOwner,
  });
  assert.deepEqual(approver.votes, [
    { action: "REJECT_ACTIVITY", fingerprint: "fp-brain-error" },
  ]);
  assert.equal(result.errors, 1);
  assert.equal(result.rejected, 1);
  console.log("ok  brain error is fail-closed to reject");
}

/* The outer loop is abortable with an injected sleep. */
{
  const approver = new MockApprover([]);
  const controller = new AbortController();
  let sleeps = 0;
  await runCosignerWorker({
    approver,
    expectedSigner: CLEAN_SIGNER,
    evaluate: allowAll,
    resolveOwner,
    signal: controller.signal,
    sleepImpl: async () => {
      sleeps += 1;
      if (sleeps === 2) controller.abort();
    },
    onPollError: () => {},
  });
  assert.equal(sleeps, 2);
  console.log("ok  polling loop stops on abort");
}

/* A transient list failure is reported, slept, and retried instead of killing the worker. */
{
  let polls = 0;
  const approver: TurnkeyApprover = {
    async listPendingSignActivities() {
      polls += 1;
      if (polls === 1) throw new Error("list unavailable");
      return [];
    },
    async stamp() {
      throw new Error("no activity should be stamped");
    },
  };
  const controller = new AbortController();
  let pollErrors = 0;
  await runCosignerWorker({
    approver,
    expectedSigner: CLEAN_SIGNER,
    evaluate: allowAll,
    resolveOwner,
    signal: controller.signal,
    sleepImpl: async () => {},
    onPollError: () => {
      pollErrors += 1;
    },
    onCycle: () => controller.abort(),
  });
  assert.equal(polls, 2);
  assert.equal(pollErrors, 1);
  console.log("ok  transient list failure is retried without worker exit");
}

/* Normal timer completion removes abort listeners instead of leaking one per poll. */
{
  const approver = new MockApprover([]);
  const controller = new AbortController();
  let cycles = 0;
  let listenersBeforeAbort = -1;
  await runCosignerWorker({
    approver,
    expectedSigner: CLEAN_SIGNER,
    evaluate: allowAll,
    resolveOwner,
    signal: controller.signal,
    intervalMs: 0,
    onPollError: () => {},
    onCycle: () => {
      cycles += 1;
      if (cycles === 12) {
        listenersBeforeAbort = getEventListeners(controller.signal, "abort").length;
        controller.abort();
      }
    },
  });
  assert.equal(listenersBeforeAbort, 0);
  console.log("ok  polling timer does not accumulate abort listeners");
}

console.log("polling-worker.test.ts: all passed");
