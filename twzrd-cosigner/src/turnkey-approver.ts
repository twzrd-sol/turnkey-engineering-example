/** Real @turnkey/sdk-server adapter for the single TurnkeyApprover port. */
import { Turnkey, type TurnkeyApiClient } from "@turnkey/sdk-server";

import type { TurnkeyApprover } from "./approver.js";
import {
  attestTurnkeyGuard,
  type GuardQuorumAttestation,
  type TurnkeyQuorumClient,
} from "./quorum.js";
import type { TurnkeyPendingActivity } from "./turnkey.js";

type GetActivitiesInput = Parameters<TurnkeyApiClient["getActivities"]>[0];
type GetActivitiesResponse = Awaited<
  ReturnType<TurnkeyApiClient["getActivities"]>
>;
type SdkActivity = Pick<
  GetActivitiesResponse["activities"][number],
  "id" | "fingerprint" | "status" | "type" | "intent"
>;
type ApproveResponse = Awaited<
  ReturnType<TurnkeyApiClient["approveActivity"]>
>;
type DecisionActivity = Pick<
  ApproveResponse["activity"],
  "id" | "status"
> & {
  votes: Array<
    Pick<ApproveResponse["activity"]["votes"][number], "userId" | "selection">
  >;
};

/** SDK-derived seam used to test the network adapter without credentials. */
export type TurnkeySdkApproverClient = TurnkeyQuorumClient & {
  getActivities(input: GetActivitiesInput): Promise<{ activities: SdkActivity[] }>;
  approveActivity(
    input: Parameters<TurnkeyApiClient["approveActivity"]>[0],
  ): Promise<{ activity: DecisionActivity }>;
  rejectActivity(
    input: Parameters<TurnkeyApiClient["rejectActivity"]>[0],
  ): Promise<{ activity: DecisionActivity }>;
};

type InjectedConfig = {
  organizationId: string;
  client: TurnkeySdkApproverClient;
  expectedGuardUsername?: string;
};

type CredentialConfig = {
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  apiBaseUrl?: string;
  expectedGuardUsername?: string;
  client?: never;
};

export type TurnkeyApproverConfig = InjectedConfig | CredentialConfig;

const SIGN_ACTIVITY_TYPES = new Set([
  "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
  "ACTIVITY_TYPE_SIGN_TRANSACTION",
]);

function toPendingActivity(activity: SdkActivity): TurnkeyPendingActivity {
  const v2 = activity.intent.signTransactionIntentV2;
  const v1 = activity.intent.signTransactionIntent;
  return {
    id: activity.id,
    fingerprint: activity.fingerprint,
    status: activity.status,
    type: activity.type,
    intent: {
      ...(v2
        ? {
            signTransactionIntentV2: {
              unsignedTransaction: v2.unsignedTransaction,
              signWith: v2.signWith,
            },
          }
        : {}),
      ...(v1
        ? {
            signTransactionIntent: {
              unsignedTransaction: v1.unsignedTransaction,
              signWith: v1.privateKeyId,
            },
          }
        : {}),
    },
  };
}

function sdkClient(config: TurnkeyApproverConfig): TurnkeySdkApproverClient {
  if ("client" in config && config.client) return config.client;
  if (!config.apiPublicKey || !config.apiPrivateKey) {
    throw new Error("Turnkey API public and private keys are required");
  }
  const turnkey = new Turnkey({
    apiBaseUrl: config.apiBaseUrl ?? "https://api.turnkey.com",
    apiPublicKey: config.apiPublicKey,
    apiPrivateKey: config.apiPrivateKey,
    defaultOrganizationId: config.organizationId,
  });
  return turnkey.apiClient();
}

/**
 * Adapt either an injected SDK client or credentialed Turnkey instance to the
 * one approver port used by the worker.
 */
export function createTurnkeyApprover(
  config: TurnkeyApproverConfig,
): TurnkeyApprover {
  if (!config.organizationId.trim()) {
    throw new Error("Turnkey organizationId is required");
  }
  const client = sdkClient(config);
  let attestation: Promise<GuardQuorumAttestation> | undefined;
  const ensureAttested = async () => {
    if (!attestation) {
      attestation = attestTurnkeyGuard(
        client,
        config.organizationId,
        config.expectedGuardUsername ?? "twzrd-guard",
      );
    }
    try {
      return await attestation;
    } catch (error) {
      // Permit a corrected configuration to be observed on the next poll.
      attestation = undefined;
      throw error;
    }
  };

  return {
    async listPendingSignActivities() {
      await ensureAttested();
      const response = await client.getActivities({
        organizationId: config.organizationId,
        filterByStatus: ["ACTIVITY_STATUS_CONSENSUS_NEEDED"],
        filterByType: [
          "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
          "ACTIVITY_TYPE_SIGN_TRANSACTION",
        ],
        paginationOptions: { limit: "100" },
      });
      return response.activities
        .filter(
          (activity) =>
            activity.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED" &&
            SIGN_ACTIVITY_TYPES.has(activity.type),
        )
        .map(toPendingActivity);
    },

    async stamp(action, fingerprint, meta) {
      if (action === "ABSTAIN") {
        return {
          ok: true,
          dryRun: true,
          detail: "abstain - no Turnkey vote",
        };
      }
      if (!fingerprint) throw new Error("Turnkey activity fingerprint is required");
      const guard = await ensureAttested();

      const input = { organizationId: config.organizationId, fingerprint };
      const selection =
        action === "APPROVE_ACTIVITY"
          ? "VOTE_SELECTION_APPROVED"
          : "VOTE_SELECTION_REJECTED";
      const response =
        action === "APPROVE_ACTIVITY"
          ? await client.approveActivity(input)
          : await client.rejectActivity(input);
      const activity = response.activity;
      const voteRecorded = activity.votes.some(
        (vote) =>
          vote.userId === guard.guardUserId && vote.selection === selection,
      );
      const acceptableStatus =
        action === "APPROVE_ACTIVITY"
          ? activity.status === "ACTIVITY_STATUS_COMPLETED" ||
            activity.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED"
          : activity.status === "ACTIVITY_STATUS_REJECTED" ||
            activity.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED";
      const ok = voteRecorded && acceptableStatus;
      const finalized = new Set([
        "ACTIVITY_STATUS_COMPLETED",
        "ACTIVITY_STATUS_REJECTED",
        "ACTIVITY_STATUS_FAILED",
      ]).has(activity.status);
      const verb = action === "APPROVE_ACTIVITY" ? "approve" : "reject";
      const target = meta?.activityId ?? fingerprint;

      return {
        ok,
        dryRun: false,
        detail: ok
          ? `${verb} vote recorded for ${target}; status=${activity.status}`
          : `${verb} vote not confirmed for ${target}; status=${activity.status}`,
        activityId: activity.id,
        activityStatus: activity.status,
        finalized,
      };
    },
  };
}
