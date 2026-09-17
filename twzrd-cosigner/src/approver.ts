/**
 * One Turnkey approver port for both offline tests and the live SDK adapter.
 *
 * The decision core emits APPROVE_ACTIVITY, REJECT_ACTIVITY, or ABSTAIN. The
 * adapter owns the vendor-specific vote call; the worker never imports an SDK.
 */
import type {
  TurnkeyAction,
  TurnkeyPendingActivity,
} from "./turnkey.js";

export type StampRecord = {
  at: number;
  action: TurnkeyAction;
  fingerprint: string;
  activityId?: string;
};

export type StampResult = {
  ok: boolean;
  /** True when no network vote was made (mock or abstain). */
  dryRun: boolean;
  detail?: string;
  activityId?: string;
  activityStatus?: string;
  /** True when Turnkey reports a terminal target-activity status. */
  finalized?: boolean;
};

export interface TurnkeyApprover {
  /** Pending sign activities awaiting the TWZRD consensus vote. */
  listPendingSignActivities(): Promise<TurnkeyPendingActivity[]>;
  /** Apply one decision through the vendor adapter. ABSTAIN never votes. */
  stamp(
    action: TurnkeyAction,
    fingerprint: string,
    meta?: { activityId?: string },
  ): Promise<StampResult>;
}

export type MockTurnkeyApprover = TurnkeyApprover & {
  readonly calls: readonly StampRecord[];
  clear(): void;
};

/** In-memory approver for offline dry-runs and unit tests. */
export function createMockTurnkeyApprover(
  pending: TurnkeyPendingActivity[] = [],
): MockTurnkeyApprover {
  const calls: StampRecord[] = [];
  return {
    get calls() {
      return calls;
    },
    clear() {
      calls.length = 0;
    },
    async listPendingSignActivities() {
      return [...pending];
    },
    async stamp(action, fingerprint, meta) {
      if (action === "ABSTAIN") {
        return { ok: true, dryRun: true, detail: "abstain - no vote" };
      }
      calls.push({
        at: Date.now(),
        action,
        fingerprint,
        activityId: meta?.activityId,
      });
      return {
        ok: true,
        dryRun: true,
        detail: `mock ${action} fingerprint=${fingerprint}`,
      };
    },
  };
}
