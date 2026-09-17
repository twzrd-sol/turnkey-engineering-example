/**
 * Turnkey decision adapter. The proven topology is an isolated child organization
 * whose wallet is controlled by a 2-of-3 root quorum (hot + TWZRD veto +
 * customer recovery). A pending
 * SIGN_TRANSACTION_V2 activity then blocks in ACTIVITY_STATUS_CONSENSUS_NEEDED
 * until TWZRD stamps ApproveActivity or RejectActivity against its fingerprint. No approval
 * means the child wallet does not sign through this required quorum path.
 *
 * This module maps an activity to the action the worker should stamp. It performs the
 * decode + policy decision; the actual Turnkey API stamping (ApproveActivity /
 * RejectActivity) is left to the SDK adapter so this stays testable offline.
 */
import { decodeTransaction } from "./decode.js";
import { decidePayment, type DecideContext, type CosignerDecision, type Verdict } from "./decide.js";
import { MandateRefusal } from "./mandate.js";
import { decisionIdForUnsignedTransaction } from "./mandate-store.js";

export interface TurnkeyPendingActivity {
  id: string;
  fingerprint: string;
  status: string;
  type: string;
  intent?: {
    signTransactionIntentV2?: { unsignedTransaction?: string; signWith?: string };
    signTransactionIntent?: { unsignedTransaction?: string; signWith?: string };
    [key: string]: unknown;
  };
}

export type TurnkeyAction = "APPROVE_ACTIVITY" | "REJECT_ACTIVITY" | "ABSTAIN";

export interface TurnkeyDecision {
  action: TurnkeyAction;
  /** The fingerprint the worker passes to ApproveActivity / RejectActivity. */
  fingerprint: string;
  verdict: Verdict | "abstain";
  reasonCodes: string[];
  /** Present when the activity carried a valid unsigned transaction. */
  decisionId?: string;
  /** Policy seat used for mandate binding. */
  policyId?: string;
  detail?: CosignerDecision;
}

export interface TurnkeyDecideContext extends DecideContext {
  /**
   * Solana address of the one guarded Turnkey wallet this worker may approve.
   * The activity's signWith and the decoded transfer authority must both match.
   */
  expectedSigner: string;
  /** Claim the one mandate whose decision id hashes this unsigned transaction. */
  resolveCosign?: (decisionId: string, activityId: string) => Promise<unknown | null>;
}

const SIGN_ACTIVITY_TYPES = new Set([
  "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
  "ACTIVITY_TYPE_SIGN_TRANSACTION",
]);

function extractUnsignedTransaction(activity: TurnkeyPendingActivity): string | undefined {
  const i = activity.intent;
  return (
    i?.signTransactionIntentV2?.unsignedTransaction ??
    i?.signTransactionIntent?.unsignedTransaction
  );
}

function extractSignWith(activity: TurnkeyPendingActivity): string | undefined {
  const i = activity.intent;
  return i?.signTransactionIntentV2?.signWith ?? i?.signTransactionIntent?.signWith;
}

/**
 * Decide how to vote on one pending Turnkey activity. Fails closed at every step: a
 * non-sign type abstains, a missing or undecodable transaction is rejected, and any
 * policy DENY is a reject. Only an explicit ALLOW yields APPROVE_ACTIVITY.
 */
export async function decideTurnkeyActivity(
  activity: TurnkeyPendingActivity,
  ctx: TurnkeyDecideContext,
): Promise<TurnkeyDecision> {
  if (!SIGN_ACTIVITY_TYPES.has(activity.type)) {
    return {
      action: "ABSTAIN",
      fingerprint: activity.fingerprint,
      verdict: "abstain",
      reasonCodes: ["TWZRD_NOT_A_SIGN_ACTIVITY"],
    };
  }

  const expectedSigner = ctx.expectedSigner.trim();
  if (!expectedSigner) {
    return {
      action: "REJECT_ACTIVITY",
      fingerprint: activity.fingerprint,
      verdict: "deny",
      reasonCodes: ["TWZRD_EXPECTED_SIGNER_REQUIRED"],
    };
  }

  const signWith = extractSignWith(activity)?.trim();
  if (!signWith) {
    return {
      action: "REJECT_ACTIVITY",
      fingerprint: activity.fingerprint,
      verdict: "deny",
      reasonCodes: ["TWZRD_NO_SIGNER"],
    };
  }
  if (signWith !== expectedSigner) {
    return {
      action: "REJECT_ACTIVITY",
      fingerprint: activity.fingerprint,
      verdict: "deny",
      reasonCodes: ["TWZRD_UNEXPECTED_SIGNER"],
    };
  }

  const unsigned = extractUnsignedTransaction(activity);
  if (!unsigned) {
    return {
      action: "REJECT_ACTIVITY",
      fingerprint: activity.fingerprint,
      verdict: "deny",
      reasonCodes: ["TWZRD_NO_UNSIGNED_TX"],
    };
  }

  let decoded;
  try {
    decoded = decodeTransaction(unsigned);
  } catch {
    return {
      action: "REJECT_ACTIVITY",
      fingerprint: activity.fingerprint,
      verdict: "deny",
      reasonCodes: ["TWZRD_DECODE_ERROR"],
    };
  }

  const decisionId = decisionIdForUnsignedTransaction(unsigned);
  let cosign = ctx.cosign;
  if (ctx.resolveCosign) {
    try {
      cosign = await ctx.resolveCosign(decisionId, activity.id);
    } catch (error) {
      const reason =
        error instanceof MandateRefusal
          ? `TWZRD_MANDATE_${error.reason.toUpperCase()}`
          : "TWZRD_MANDATE_UNAVAILABLE";
      return {
        action: "REJECT_ACTIVITY",
        fingerprint: activity.fingerprint,
        verdict: "deny",
        reasonCodes: [reason],
        decisionId,
        policyId: ctx.policyId,
      };
    }
  }

  // Exactly-one-transfer is enforced by decidePayment. Bind that transfer to
  // the guarded key before invoking the brain so the child cannot be approved
  // merely as fee payer for an external signer's payment.
  if (
    decoded.transfers.length === 1 &&
    decoded.transfers[0]?.authority !== expectedSigner
  ) {
    return {
      action: "REJECT_ACTIVITY",
      fingerprint: activity.fingerprint,
      verdict: "deny",
      reasonCodes: ["TWZRD_SIGNER_NOT_TRANSFER_AUTHORITY"],
      decisionId,
      policyId: ctx.policyId,
    };
  }

  const decision = await decidePayment(decoded, {
    ...ctx,
    cosign,
    decisionId,
    requireCosign: ctx.requireCosign || ctx.resolveCosign != null,
  });
  return {
    action: decision.verdict === "allow" ? "APPROVE_ACTIVITY" : "REJECT_ACTIVITY",
    fingerprint: activity.fingerprint,
    verdict: decision.verdict,
    reasonCodes: decision.reasonCodes,
    decisionId,
    policyId: ctx.policyId,
    detail: decision,
  };
}
