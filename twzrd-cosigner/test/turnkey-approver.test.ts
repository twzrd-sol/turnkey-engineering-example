/** Real Turnkey SDK adapter tests. The SDK edge is injected; no API calls. */
import assert from "node:assert/strict";

import {
  createTurnkeyApprover,
  type TurnkeySdkApproverClient,
} from "../src/turnkey-approver.js";

const calls: Array<{ op: string; input: unknown }> = [];
let approveStatus: "ACTIVITY_STATUS_COMPLETED" | "ACTIVITY_STATUS_FAILED" =
  "ACTIVITY_STATUS_COMPLETED";
const sdkClient: TurnkeySdkApproverClient = {
  async getWhoami(input) {
    calls.push({ op: "whoami", input });
    return {
      organizationId: "child-org",
      userId: "guard-user",
      username: "twzrd-guard",
    };
  },
  async getOrganizationConfigs(input) {
    calls.push({ op: "config", input });
    return {
      configs: {
        quorum: {
          threshold: 2,
          userIds: ["payer-user", "guard-user", "recovery-user"],
        },
      },
    };
  },
  async getUsers(input) {
    calls.push({ op: "users", input });
    return {
      users: [
        { userId: "payer-user", userName: "payer" },
        { userId: "guard-user", userName: "twzrd-guard" },
        { userId: "recovery-user", userName: "payer-recovery" },
      ],
    };
  },
  async getActivities(input) {
    calls.push({ op: "list", input });
    return {
      activities: [
        {
          id: "sign-1",
          fingerprint: "fp-sign-1",
          status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
          type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
          intent: {
            signTransactionIntentV2: {
              unsignedTransaction: "00",
              signWith: "GuardedWallet",
              type: "TRANSACTION_TYPE_SOLANA",
            },
          },
        },
        {
          id: "done-sign",
          fingerprint: "fp-done",
          status: "ACTIVITY_STATUS_COMPLETED",
          type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
          intent: {},
        },
        {
          id: "non-sign",
          fingerprint: "fp-non-sign",
          status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
          type: "ACTIVITY_TYPE_CREATE_API_KEYS",
          intent: {},
        },
      ],
    };
  },
  async approveActivity(input) {
    calls.push({ op: "approve", input });
    return {
      activity: {
        id: "sign-1",
        status: approveStatus,
        votes:
          approveStatus === "ACTIVITY_STATUS_COMPLETED"
            ? [{ userId: "guard-user", selection: "VOTE_SELECTION_APPROVED" as const }]
            : [],
      },
    };
  },
  async rejectActivity(input) {
    calls.push({ op: "reject", input });
    return {
      activity: {
        id: "sign-2",
        status: "ACTIVITY_STATUS_REJECTED" as const,
        votes: [{ userId: "guard-user", selection: "VOTE_SELECTION_REJECTED" as const }],
      },
    };
  },
};

const approver = createTurnkeyApprover({
  organizationId: "child-org",
  client: sdkClient,
});

const pending = await approver.listPendingSignActivities();
assert.deepEqual(pending, [
  {
    id: "sign-1",
    fingerprint: "fp-sign-1",
    status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    intent: {
      signTransactionIntentV2: {
        unsignedTransaction: "00",
        signWith: "GuardedWallet",
      },
    },
  },
]);
assert.deepEqual(calls.slice(0, 4), [
  { op: "whoami", input: { organizationId: "child-org" } },
  { op: "config", input: { organizationId: "child-org" } },
  { op: "users", input: { organizationId: "child-org" } },
  {
    op: "list",
    input: {
      organizationId: "child-org",
      filterByStatus: ["ACTIVITY_STATUS_CONSENSUS_NEEDED"],
      filterByType: [
        "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
        "ACTIVITY_TYPE_SIGN_TRANSACTION",
      ],
      paginationOptions: { limit: "100" },
    },
  },
]);
console.log("ok  adapter lists only pending sign activities for the child org");

const approved = await approver.stamp("APPROVE_ACTIVITY", "fp-sign-1", {
  activityId: "sign-1",
});
const rejected = await approver.stamp("REJECT_ACTIVITY", "fp-sign-2", {
  activityId: "sign-2",
});
const abstained = await approver.stamp("ABSTAIN", "fp-non-sign", {
  activityId: "non-sign",
});

assert.deepEqual(calls.slice(4), [
  {
    op: "approve",
    input: { organizationId: "child-org", fingerprint: "fp-sign-1" },
  },
  {
    op: "reject",
    input: { organizationId: "child-org", fingerprint: "fp-sign-2" },
  },
]);
assert.deepEqual(approved, {
  ok: true,
  dryRun: false,
  detail: "approve vote recorded for sign-1; status=ACTIVITY_STATUS_COMPLETED",
  activityId: "sign-1",
  activityStatus: "ACTIVITY_STATUS_COMPLETED",
  finalized: true,
});
assert.deepEqual(rejected, {
  ok: true,
  dryRun: false,
  detail: "reject vote recorded for sign-2; status=ACTIVITY_STATUS_REJECTED",
  activityId: "sign-2",
  activityStatus: "ACTIVITY_STATUS_REJECTED",
  finalized: true,
});
assert.deepEqual(abstained, {
  ok: true,
  dryRun: true,
  detail: "abstain - no Turnkey vote",
});
console.log("ok  adapter maps the one stamp port to explicit approve/reject SDK calls");

approveStatus = "ACTIVITY_STATUS_FAILED";
const failed = await approver.stamp("APPROVE_ACTIVITY", "fp-failed", {
  activityId: "failed-sign",
});
assert.deepEqual(failed, {
  ok: false,
  dryRun: false,
  detail:
    "approve vote not confirmed for failed-sign; status=ACTIVITY_STATUS_FAILED",
  activityId: "sign-1",
  activityStatus: "ACTIVITY_STATUS_FAILED",
  finalized: true,
});
console.log("ok  failed/non-voted SDK activity is not reported as a successful vote");

console.log("turnkey-approver.test.ts: all passed");
