/**
 * Dry-run worker: decide + mock stamp, zero Turnkey network.
 * Run: npx tsx test/worker.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { EvaluatePaymentFn } from "../src/decide.js";
import { SOLANA_MAINNET_CAIP2 } from "../src/decide.js";
import { createMockTurnkeyApprover } from "../src/approver.js";
import { decodeTransaction } from "../src/decode.js";
import {
  FileMandateStore,
  decisionIdForUnsignedTransaction,
} from "../src/mandate-store.js";
import { createStaticResolveOwner } from "../src/resolve-owner.js";
import { processPendingActivity, processPendingActivities } from "../src/worker.js";
import type { TurnkeyPendingActivity } from "../src/turnkey.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(
  readFileSync(join(here, "fixtures", "mainnet-transfers.json"), "utf8"),
) as Record<string, { raw_b64: string }>;

const hex = (b64: string) => Buffer.from(b64, "base64").toString("hex");
const CLEAN_SIGNER = "EKLwbUquEHL5LZFi7L3BmNybpBRF5kCPmbJHmXYkvshK";
const LEGACY_SIGNER = "6oi5E1YtJV7u8UbWXn6heFMRhRi1gXXvVUTSkhQSVzc4";
const allowAll: EvaluatePaymentFn = async () => ({ decision: "allow", reasonCodes: ["ALLOW"] });
const blockAll: EvaluatePaymentFn = async () => ({
  decision: "block",
  reasonCodes: ["INTEL_BLOCK"],
});
const warnAll: EvaluatePaymentFn = async () => ({
  decision: "warn",
  reasonCodes: ["INTEL_WARN"],
});

function activity(
  id: string,
  unsignedTransaction: string,
  signWith = CLEAN_SIGNER,
): TurnkeyPendingActivity {
  return {
    id,
    fingerprint: `fp-${id}`,
    status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    intent: { signTransactionIntentV2: { unsignedTransaction, signWith } },
  };
}

const alwaysOwner = () => "MerchantOwnerWa11etAAAAAAAAAAAAAAAAAAAAAAA";

async function run() {
  /* Clean allow → mock APPROVE stamp recorded */
  {
    const stamp = createMockTurnkeyApprover();
    const r = await processPendingActivity(activity("a1", hex(FIX.clean_usdc.raw_b64)), {
      expectedSigner: CLEAN_SIGNER,
      evaluate: allowAll,
      resolveOwner: alwaysOwner,
      approver: stamp,
    });
    assert.equal(r.decision.action, "APPROVE_ACTIVITY");
    assert.equal(r.stamp.ok, true);
    assert.equal(r.stamp.dryRun, true);
    assert.equal(stamp.calls.length, 1);
    assert.equal(stamp.calls[0]!.action, "APPROVE_ACTIVITY");
    assert.equal(stamp.calls[0]!.fingerprint, "fp-a1");
    console.log("ok  dry-run ALLOW -> mock APPROVE stamp");
  }

  /* Policy block → mock REJECT stamp */
  {
    const stamp = createMockTurnkeyApprover();
    const r = await processPendingActivity(activity("a2", hex(FIX.clean_usdc.raw_b64)), {
      expectedSigner: CLEAN_SIGNER,
      evaluate: blockAll,
      resolveOwner: alwaysOwner,
      approver: stamp,
    });
    assert.equal(r.decision.action, "REJECT_ACTIVITY");
    assert.equal(stamp.calls[0]!.action, "REJECT_ACTIVITY");
    console.log("ok  dry-run BLOCK -> mock REJECT stamp");
  }

  /* warn → REJECT (co-signer never signs on warn) + mock stamp */
  {
    const stamp = createMockTurnkeyApprover();
    const r = await processPendingActivity(activity("a3", hex(FIX.clean_usdc.raw_b64)), {
      expectedSigner: CLEAN_SIGNER,
      evaluate: warnAll,
      resolveOwner: alwaysOwner,
      approver: stamp,
    });
    assert.equal(r.decision.action, "REJECT_ACTIVITY");
    assert.ok(r.decision.reasonCodes.includes("TWZRD_POLICY_WARN_REFUSED"));
    assert.equal(stamp.calls[0]!.action, "REJECT_ACTIVITY");
    console.log("ok  dry-run WARN -> REJECT + POLICY_WARN_REFUSED");
  }

  /* Bundled / unaccounted → REJECT, no approve */
  {
    const stamp = createMockTurnkeyApprover();
    const r = await processPendingActivity(
      activity("a4", hex(FIX.legacy_simple.raw_b64), LEGACY_SIGNER),
      {
        expectedSigner: LEGACY_SIGNER,
        evaluate: allowAll,
        resolveOwner: alwaysOwner,
        approver: stamp,
      },
    );
    assert.equal(r.decision.action, "REJECT_ACTIVITY");
    assert.ok(r.decision.reasonCodes.includes("TWZRD_UNACCOUNTED_INSTRUCTION"));
    assert.equal(stamp.calls[0]!.action, "REJECT_ACTIVITY");
    console.log("ok  dry-run bundled tx -> REJECT via whole-tx guard");
  }

  /* Batch: allow + block → two stamps, never silent skip */
  {
    const stamp = createMockTurnkeyApprover();
    const results = await processPendingActivities(
      [
        activity("b1", hex(FIX.clean_usdc.raw_b64)),
        activity("b2", hex(FIX.clean_usdc.raw_b64)),
      ],
      {
        expectedSigner: CLEAN_SIGNER,
        evaluate: async (_i, _o) =>
          // alternate via call count
          stamp.calls.length === 0
            ? { decision: "allow", reasonCodes: ["ALLOW"] }
            : { decision: "block", reasonCodes: ["INTEL_BLOCK"] },
        resolveOwner: alwaysOwner,
        approver: stamp,
      },
    );
    // Note: evaluate runs before stamp for each; after first allow, stamp.calls.length is 1
    // so second gets block. First is allow.
    assert.equal(results[0]!.decision.action, "APPROVE_ACTIVITY");
    assert.equal(results[1]!.decision.action, "REJECT_ACTIVITY");
    assert.equal(stamp.calls.length, 2);
    console.log("ok  dry-run batch allow+block");
  }

  /* resolveOwner empty → SPL fail closed, still stamps REJECT */
  {
    const stamp = createMockTurnkeyApprover();
    const r = await processPendingActivity(activity("a5", hex(FIX.clean_usdc.raw_b64)), {
      expectedSigner: CLEAN_SIGNER,
      evaluate: allowAll,
      resolveOwner: createStaticResolveOwner({}),
      approver: stamp,
    });
    assert.equal(r.decision.action, "REJECT_ACTIVITY");
    assert.ok(
      r.decision.reasonCodes.includes("TWZRD_OWNER_UNRESOLVED") ||
        r.decision.reasonCodes.includes("TWZRD_OWNER_RESOLVER_REQUIRED"),
    );
    assert.equal(stamp.calls[0]!.action, "REJECT_ACTIVITY");
    console.log("ok  dry-run missing owner -> REJECT fail-closed");
  }

  /* A stored mandate binds policy + transaction and cannot authorize a second activity. */
  {
    const dir = await mkdtemp(join(tmpdir(), "twzrd-worker-mandate-"));
    try {
      const unsigned = hex(FIX.clean_usdc.raw_b64);
      const transfer = decodeTransaction(unsigned).transfers[0]!;
      const store = new FileMandateStore(dir);
      const policyId = "partner.v1";
      await store.submit({
        rail: SOLANA_MAINNET_CAIP2,
        recipient: alwaysOwner(),
        asset: transfer.mint!,
        amount: transfer.amountBaseUnits,
        expiry: "2099-01-01T00:00:00Z",
        policy_id: policyId,
        decision_id: decisionIdForUnsignedTransaction(unsigned),
      });
      const stamp = createMockTurnkeyApprover();
      const ctx = {
        expectedSigner: CLEAN_SIGNER,
        evaluate: allowAll,
        resolveOwner: alwaysOwner,
        approver: stamp,
        policyId,
        resolveCosign: (decisionId: string, activityId: string) =>
          store.claim(decisionId, activityId),
      };

      const allowed = await processPendingActivity(activity("mandate-1", unsigned), ctx);
      assert.equal(allowed.decision.action, "APPROVE_ACTIVITY");
      const replay = await processPendingActivity(activity("mandate-2", unsigned), ctx);
      assert.equal(replay.decision.action, "REJECT_ACTIVITY");
      assert.ok(replay.decision.reasonCodes.includes("TWZRD_MANDATE_DECISION_REPLAY"));
      console.log("ok  mandate binds one unsigned transaction to one Turnkey activity");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("worker.test.ts: all passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
