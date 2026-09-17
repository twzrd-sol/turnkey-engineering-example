/**
 * Seller intelligence for the co-signer seat.
 *
 * Wraps twzrd-x402-gate's live preflight (POST /v1/intel/preflight, then the
 * free GET /v1/intel/merchant_card/{wallet} wash check) as the `intelligence`
 * provider for evaluateIntent. Nothing here signs or pays.
 *
 * Co-signer semantics differ from an advisory hook, so two gate knobs are
 * pinned rather than read from the environment:
 *   - failOpen is always false: if the intelligence service is unreachable the
 *     evaluator receives decision=block and the worker votes REJECT. A vote is
 *     a signature; "unknown" must never sign. TWZRD_FAIL_OPEN is ignored here.
 *   - refuseWashFlagged is always true.
 *
 * Consequence for pilots: a seller with no corpus evidence gets a free-tier
 * `warn`, and the co-signer signs only on an explicit `allow`, so payments to
 * never-seen sellers are refused with INTEL_WARN / TWZRD_POLICY_WARN_REFUSED.
 * That is the intended conservative behavior of a guard seat, and it is why an
 * allow in a pilot must target a seller with real evidence.
 */
import {
  createTwzrdIntelligenceProvider,
  type IntelligenceProvider,
  type TwzrdApprovalResult,
} from "twzrd-x402-gate";

export type SellerIntelMode = "live" | "off";

export const DEFAULT_INTEL_BASE = "https://intel.twzrd.xyz";

/** `TWZRD_SELLER_INTEL`: unset or "live" enables; "off" disables; anything else is an error. */
export function parseSellerIntelMode(raw: string | undefined): SellerIntelMode {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "" || value === "live" || value === "1" || value === "on") return "live";
  if (value === "off" || value === "0" || value === "false") return "off";
  throw new Error(`TWZRD_SELLER_INTEL must be "live" or "off" (got ${JSON.stringify(raw)})`);
}

export type SellerIntelObservation = {
  decisionId: string;
  payTo: string;
  amountUsd: string;
  approved: boolean;
  verdict: string;
  score: number | null;
  washFlagged: boolean | null | undefined;
  reason: string;
  preflightId?: number;
};

export type SellerIntelligenceOptions = {
  mode: SellerIntelMode;
  /** Base URL of the intelligence service. Default: TWZRD_INTEL_BASE or the public endpoint. */
  intelBase?: string;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
  /** Correlation id stamped on requests as X-TWZRD-Run-Id. */
  runId?: string;
  /** Audit sink for every approval result. Errors thrown here never alter the decision. */
  onObservation?: (observation: SellerIntelObservation) => void;
};

/** Returns undefined when mode is "off" so callers can omit the provider entirely. */
export function createSellerIntelligence(
  options: SellerIntelligenceOptions,
): IntelligenceProvider | undefined {
  if (options.mode === "off") return undefined;
  const intelBase = (options.intelBase ?? process.env.TWZRD_INTEL_BASE ?? DEFAULT_INTEL_BASE).replace(/\/+$/, "");
  return createTwzrdIntelligenceProvider({
    intelBase,
    fetch: options.fetch,
    failOpen: false,
    refuseWashFlagged: true,
    attribution: {
      integration: "twzrd-cosigner",
      runId: options.runId ?? `cosigner-${process.pid}-${Date.now()}`,
    },
    onApproval: (approval: TwzrdApprovalResult, intent) => {
      options.onObservation?.({
        decisionId: approval.decisionId,
        payTo: intent.payTo,
        amountUsd: intent.amount,
        approved: approval.approved,
        verdict: String(approval.verdict),
        score: approval.score,
        washFlagged: approval.washFlagged,
        reason: approval.reason,
        preflightId: approval.preflightId,
      });
    },
  });
}

export function describeSellerIntel(mode: SellerIntelMode, intelBase?: string): string {
  if (mode === "off") return "seller intelligence OFF (local policy only; TWZRD_SELLER_INTEL=off)";
  const base = (intelBase ?? process.env.TWZRD_INTEL_BASE ?? DEFAULT_INTEL_BASE).replace(/\/+$/, "");
  return `seller intelligence LIVE via ${base} (fail-closed; unknown sellers refused)`;
}
