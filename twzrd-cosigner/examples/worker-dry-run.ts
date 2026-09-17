/**
 * Offline dry-run of the Turnkey approver worker.
 *
 * Uses mainnet fixture bytes + mock stamp client — no Turnkey org, no API key.
 * Proves the pipeline: activity → decideTurnkeyActivity → stamp record.
 *
 *   npx tsx examples/worker-dry-run.ts
 *   npx tsx examples/worker-dry-run.ts --block
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EvaluatePaymentFn } from "../src/decide.js";
import { createMockTurnkeyApprover } from "../src/approver.js";
import { processPendingActivity } from "../src/worker.js";
import type { TurnkeyPendingActivity } from "../src/turnkey.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(
  readFileSync(join(here, "../test/fixtures/mainnet-transfers.json"), "utf8"),
) as Record<string, { raw_b64: string }>;

const wantBlock = process.argv.includes("--block");
const DRY_RUN_SIGNER = "EKLwbUquEHL5LZFi7L3BmNybpBRF5kCPmbJHmXYkvshK";
const evaluate: EvaluatePaymentFn = async () =>
  wantBlock
    ? { decision: "block", reasonCodes: ["DRY_RUN_BLOCK"] }
    : { decision: "allow", reasonCodes: ["DRY_RUN_ALLOW"] };

const unsigned = Buffer.from(FIX.clean_usdc.raw_b64, "base64").toString("hex");
const activity: TurnkeyPendingActivity = {
  id: "dry-run-1",
  fingerprint: "fp-dry-run-1",
  status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
  type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
  intent: {
    signTransactionIntentV2: {
      unsignedTransaction: unsigned,
      signWith: DRY_RUN_SIGNER,
    },
  },
};

const stamp = createMockTurnkeyApprover();
const result = await processPendingActivity(activity, {
  expectedSigner: DRY_RUN_SIGNER,
  evaluate,
  resolveOwner: () => "MerchantOwnerWa11etAAAAAAAAAAAAAAAAAAAAAAA",
  approver: stamp,
  evaluateOptions: {
    policy: { maxAmountUsd: "100" },
  },
});

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      activityId: result.activityId,
      action: result.decision.action,
      verdict: result.decision.verdict,
      reasonCodes: result.decision.reasonCodes,
      stamp: result.stamp,
      mockStamps: stamp.calls,
      note:
        "dry-run only - no Turnkey API. Live path uses createTurnkeyApprover.",
    },
    null,
    2,
  ),
);
