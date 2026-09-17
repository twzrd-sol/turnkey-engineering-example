/**
 * Turnkey approver worker: poll → decide → stamp one consensus vote.
 *
 * Dry-run injects createMockTurnkeyApprover. Live code injects the real SDK
 * adapter from turnkey-approver.ts. The worker itself has no vendor import.
 */
import {
  decideTurnkeyActivity,
  type TurnkeyPendingActivity,
  type TurnkeyDecision,
  type TurnkeyDecideContext,
} from "./turnkey.js";
import type { StampResult, TurnkeyApprover } from "./approver.js";

export type WorkerContext = TurnkeyDecideContext & {
  approver: TurnkeyApprover;
};

export type WorkerResult = {
  activityId: string;
  decision: TurnkeyDecision;
  stamp: StampResult;
};

/**
 * Process one pending Turnkey activity end-to-end (decide + stamp).
 * Never throws on policy DENY - stamp REJECT. Throws only if the approver throws.
 */
export async function processPendingActivity(
  activity: TurnkeyPendingActivity,
  ctx: WorkerContext,
): Promise<WorkerResult> {
  const { approver, ...decideCtx } = ctx;
  const decision = await decideTurnkeyActivity(activity, decideCtx);
  const stamp = await approver.stamp(decision.action, decision.fingerprint, {
    activityId: activity.id,
  });
  return { activityId: activity.id, decision, stamp };
}

/** Sequential batch helper for dry-run scripts and tests. */
export async function processPendingActivities(
  activities: TurnkeyPendingActivity[],
  ctx: WorkerContext,
): Promise<WorkerResult[]> {
  const out: WorkerResult[] = [];
  for (const a of activities) {
    out.push(await processPendingActivity(a, ctx));
  }
  return out;
}

export type PollingWorkerContext = WorkerContext & {
  onDecision?: (
    activity: TurnkeyPendingActivity,
    decision: TurnkeyDecision,
  ) => void;
  /** Called after Turnkey reports that a non-abstain vote was accepted. */
  onResult?: (
    activity: TurnkeyPendingActivity,
    decision: TurnkeyDecision,
    stamp: StampResult & { ok: true },
  ) => void | Promise<void>;
  onError?: (activity: TurnkeyPendingActivity, error: unknown) => void;
};

export type CycleResult = {
  processed: number;
  approved: number;
  rejected: number;
  abstained: number;
  errors: number;
};

/** Process each currently pending sign activity exactly once. */
export async function processPendingOnce(
  ctx: PollingWorkerContext,
): Promise<CycleResult> {
  const pending = await ctx.approver.listPendingSignActivities();
  const result: CycleResult = {
    processed: 0,
    approved: 0,
    rejected: 0,
    abstained: 0,
    errors: 0,
  };
  const { approver, onDecision, onResult, onError, ...decideCtx } = ctx;

  for (const activity of pending) {
    result.processed += 1;
    let decision: TurnkeyDecision;
    try {
      decision = await decideTurnkeyActivity(activity, decideCtx);
    } catch (error) {
      result.errors += 1;
      onError?.(activity, error);
      try {
        const stamp = await approver.stamp(
          "REJECT_ACTIVITY",
          activity.fingerprint,
          { activityId: activity.id },
        );
        if (stamp.ok) result.rejected += 1;
      } catch (rejectError) {
        onError?.(activity, rejectError);
      }
      continue;
    }

    onDecision?.(activity, decision);
    if (decision.action === "ABSTAIN") {
      result.abstained += 1;
      continue;
    }

    try {
      const stamp = await approver.stamp(
        decision.action,
        decision.fingerprint,
        { activityId: activity.id },
      );
      if (!stamp.ok) {
        result.errors += 1;
        onError?.(activity, new Error(stamp.detail ?? "Turnkey vote failed"));
        continue;
      }
      if (decision.action === "APPROVE_ACTIVITY") result.approved += 1;
      else result.rejected += 1;
      try {
        await onResult?.(activity, decision, { ...stamp, ok: true });
      } catch (error) {
        result.errors += 1;
        onError?.(activity, error);
      }
    } catch (error) {
      // Leave the activity pending. A transient SDK failure must never approve.
      result.errors += 1;
      onError?.(activity, error);
    }
  }

  return result;
}

export type RunWorkerOptions = PollingWorkerContext & {
  intervalMs?: number;
  signal?: AbortSignal;
  onCycle?: (result: CycleResult) => void;
  /** Required so a failed list call is never retried silently. */
  onPollError: (error: unknown) => void;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Poll until aborted. Each successful list call is one independently counted cycle. */
export async function runCosignerWorker(opts: RunWorkerOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? 3_000;
  const sleep = opts.sleepImpl ?? defaultSleep;
  while (!opts.signal?.aborted) {
    try {
      const result = await processPendingOnce(opts);
      opts.onCycle?.(result);
    } catch (error) {
      // A list/read outage cannot approve anything. Report it and retry after
      // the normal interval rather than terminating the long-running worker.
      opts.onPollError(error);
    }
    if (opts.signal?.aborted) break;
    await sleep(intervalMs, opts.signal);
  }
}
