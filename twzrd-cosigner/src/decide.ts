/**
 * Decision core. Turns decoded transfers into an ALLOW / DENY verdict by running each
 * payment-shaped transfer through the injected twzrd-x402-gate policy brain.
 *
 * Fail-closed rules (a co-signer that cannot understand a payment must never approve it):
 *   - payee unresolvable (ALT-hidden destination)            -> DENY, brain not consulted
 *   - SPL transfer with no ATA->owner resolver                -> DENY (an ATA is not a
 *     scoreable counterparty)
 *   - amount not convertible to USD (non-stable, no oracle)   -> DENY (never approve
 *     money we cannot price; a 1 SOL charge is not "$1")
 *   - nothing payment-shaped decoded                          -> DENY by default
 *
 * The USD-amount honesty here mirrors the MPP charge guard: policy ceilings are USD,
 * wire amounts are base-unit tokens, and we refuse to bridge the two by assumption.
 */
import type {
  DecodedTx,
  DecodedTransfer,
  PaymentIntentLike,
  EvaluatePaymentFn,
  EvaluatedDecision,
  EvaluateOptions,
} from "./types.js";
import { bindCosign, MandateRefusal } from "./mandate.js";

export type {
  PaymentIntentLike,
  EvaluatePaymentFn,
  EvaluatedDecision,
  EvaluateOptions,
} from "./types.js";

/** Solana mainnet CAIP-2 (genesis-hash prefix); classifyNetwork keys on "solana". */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** 1:1 USD-pegged mints -> decimals. EURC is EUR-denominated and intentionally absent. */
export const DEFAULT_STABLE_USD_MINTS: Record<string, number> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": 6, // PYUSD
};

/** Conservative v0 ceiling for requested priority fees (0.0001 SOL). */
export const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = "100000";

export type Verdict = "allow" | "deny";

export interface DecideContext {
  /** Injected policy brain (twzrd-x402-gate's evaluateIntent, structurally). */
  evaluate: EvaluatePaymentFn;
  /** Options forwarded to the brain (policy, mandate, intelligence, ledger, signer). */
  evaluateOptions?: EvaluateOptions;
  /** Resolve a token account (ATA) to its owner wallet. Required for SPL transfers. */
  resolveOwner?: (tokenAccount: string) => Promise<string | null> | string | null;
  /** Override / extend the 1:1 USD stable table. */
  stableUsdMints?: Record<string, number>;
  /** Price a non-stable asset to a USD decimal string, or null if it cannot. */
  usdRate?: (
    mint: string,
    amountBaseUnits: string,
    decimals: number | null,
  ) => Promise<string | null> | string | null;
  /** Requested compute-budget priority-fee ceiling. Default 100,000 lamports. */
  maxPriorityFeeLamports?: string;
  /** Verdict when nothing payment-shaped was decoded. Default deny (fail-closed). */
  onUndecodable?: Verdict;
  /**
   * Co-sign tuple for this spend (rail, recipient, asset, amount, expiry,
   * policy_id, decision_id). When set, ALLOW requires an exact bind.
   */
  cosign?: unknown;
  /** If true, missing cosign is DENY (TWZRD_MANDATE_REQUIRED). Default false. */
  requireCosign?: boolean;
  /** Clock for expiry. Default Date.now(). */
  now?: number;
  /** Observed rail; default SOLANA_MAINNET_CAIP2. */
  rail?: string;
  /** Policy configured for this guarded wallet. Required when cosign is set. */
  policyId?: string;
  /** SHA-256 decision id derived from the unsigned transaction. */
  decisionId?: string;
  /**
   * Whole-tx guard: deny any transaction containing an instruction that is neither an
   * evaluated transfer nor a known fund-safe (benign) instruction. Default true —
   * approving a transaction with an instruction we cannot account for defeats the whole
   * enforcement guarantee (an appended approve/drain/unknown-program rides through).
   * Set false only if the integrator has another way to bound non-payment instructions.
   */
  requireAllInstructionsAccounted?: boolean;
  /**
   * Allow bare SPL Transfer (opcode 3), which does NOT carry the mint or decimals in the
   * instruction, so the asset cannot be verified from the transaction alone. Default
   * false — require TransferChecked. Enable only with an out-of-band mint resolver.
   */
  allowBareTransfer?: boolean;
  purpose?: string;
}

export interface PerTransferDecision {
  transfer: DecodedTransfer;
  verdict: Verdict;
  reasonCodes: string[];
  payTo: string | null;
  amountUsd: string | null;
  intent?: PaymentIntentLike;
  brain?: EvaluatedDecision;
}

export interface CosignerDecision {
  verdict: Verdict;
  reasonCodes: string[];
  transfers: DecodedTransfer[];
  perTransfer: PerTransferDecision[];
  /** Programs/labels of instructions that tripped the whole-tx guard, if any. */
  unaccounted?: string[];
  priorityFeeLamports?: string;
}

/** base units -> USD decimal string (<=6 dp) for a 1:1 peg. */
function baseUnitsToUsd(amountBaseUnits: string, decimals: number): string {
  const raw = BigInt(amountBaseUnits);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  if (frac === 0n) return whole.toString();
  // toMicroUsd accepts at most 6 fractional digits.
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, 6);
  fracStr = fracStr.replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

export async function decidePayment(
  decoded: DecodedTx,
  ctx: DecideContext,
): Promise<CosignerDecision> {
  const stable = { ...DEFAULT_STABLE_USD_MINTS, ...(ctx.stableUsdMints ?? {}) };

  if (decoded.computeBudget?.unsupported.length) {
    return {
      verdict: "deny",
      reasonCodes: ["TWZRD_COMPUTE_BUDGET_UNSUPPORTED"],
      transfers: decoded.transfers,
      perTransfer: [],
      unaccounted: decoded.computeBudget.unsupported,
      priorityFeeLamports: decoded.computeBudget.priorityFeeLamports,
    };
  }

  const priorityFeeLamports = decoded.computeBudget?.priorityFeeLamports ?? "0";
  const maxPriorityFeeLamports =
    ctx.maxPriorityFeeLamports ?? DEFAULT_MAX_PRIORITY_FEE_LAMPORTS;
  if (!/^\d+$/.test(maxPriorityFeeLamports)) {
    return {
      verdict: "deny",
      reasonCodes: ["TWZRD_INVALID_PRIORITY_FEE_CAP"],
      transfers: decoded.transfers,
      perTransfer: [],
      priorityFeeLamports,
    };
  }
  if (BigInt(priorityFeeLamports) > BigInt(maxPriorityFeeLamports)) {
    return {
      verdict: "deny",
      reasonCodes: ["TWZRD_PRIORITY_FEE_EXCEEDED"],
      transfers: decoded.transfers,
      perTransfer: [],
      priorityFeeLamports,
    };
  }

  // Whole-tx guard (default on): refuse any transaction we cannot fully account for.
  // This runs BEFORE per-transfer evaluation — a single unknown instruction poisons the
  // whole transaction, so there is nothing to approve regardless of the transfers.
  if (ctx.requireAllInstructionsAccounted !== false) {
    const other = decoded.instructions.filter((i) => i.category === "other");
    if (other.length > 0) {
      return {
        verdict: "deny",
        reasonCodes: ["TWZRD_UNACCOUNTED_INSTRUCTION"],
        transfers: decoded.transfers,
        perTransfer: [],
        unaccounted: other.map((o) => o.detail ?? o.program ?? "unknown"),
      };
    }
  }

  if (decoded.transfers.length === 0) {
    const verdict: Verdict = ctx.onUndecodable ?? "deny";
    return {
      verdict,
      reasonCodes: verdict === "deny" ? ["TWZRD_NO_PAYMENT_DECODED"] : ["TWZRD_NO_PAYMENT_ALLOWED"],
      transfers: [],
      perTransfer: [],
    };
  }

  if (decoded.transfers.length !== 1) {
    return {
      verdict: "deny",
      reasonCodes: ["TWZRD_MULTI_TRANSFER_UNSUPPORTED"],
      transfers: decoded.transfers,
      perTransfer: [],
      priorityFeeLamports,
    };
  }

  const perTransfer: PerTransferDecision[] = [];

  for (const t of decoded.transfers) {
    // 1. Must be able to name the payee.
    if (t.altUnresolved || t.destination === null) {
      perTransfer.push({
        transfer: t,
        verdict: "deny",
        reasonCodes: ["TWZRD_UNRESOLVED_PAYEE"],
        payTo: null,
        amountUsd: null,
      });
      continue;
    }

    // 1b. Bare SPL Transfer carries no mint/decimals — the asset is unverifiable.
    if (t.kind === "spl_transfer" && ctx.allowBareTransfer !== true) {
      perTransfer.push({
        transfer: t,
        verdict: "deny",
        reasonCodes: ["TWZRD_BARE_TRANSFER"],
        payTo: null,
        amountUsd: null,
      });
      continue;
    }

    // 2. Resolve payTo (owner wallet), not the token account.
    let payTo: string;
    if (t.kind === "system_sol") {
      payTo = t.destination;
    } else {
      if (!ctx.resolveOwner) {
        perTransfer.push({
          transfer: t,
          verdict: "deny",
          reasonCodes: ["TWZRD_OWNER_RESOLVER_REQUIRED"],
          payTo: null,
          amountUsd: null,
        });
        continue;
      }
      const owner = await ctx.resolveOwner(t.destination);
      if (!owner) {
        perTransfer.push({
          transfer: t,
          verdict: "deny",
          reasonCodes: ["TWZRD_OWNER_UNRESOLVED"],
          payTo: null,
          amountUsd: null,
        });
        continue;
      }
      payTo = owner;
    }

    // 2b. Decimals sanity: a TransferChecked declares its decimals in the instruction, and
    // for a known stable we hold the true decimals. If they disagree, the intent is
    // malformed or hostile (misdeclaring decimals high makes a large transfer look tiny to
    // slip under a USD cap). On-chain TransferChecked would revert on a decimals mismatch,
    // but we refuse here rather than rely on that.
    if (
      t.mint &&
      t.mint !== "SOL" &&
      stable[t.mint] !== undefined &&
      t.decimals !== null &&
      t.decimals !== stable[t.mint]
    ) {
      perTransfer.push({
        transfer: t,
        verdict: "deny",
        reasonCodes: ["TWZRD_MISDECLARED_DECIMALS"],
        payTo,
        amountUsd: null,
      });
      continue;
    }

    // 3. Price to USD honestly, or fail closed. For a known stable we price with OUR true
    // decimals, never the instruction-declared value.
    let amountUsd: string | null = null;
    if (t.mint && t.mint !== "SOL" && stable[t.mint] !== undefined) {
      amountUsd = baseUnitsToUsd(t.amountBaseUnits, stable[t.mint]);
    } else if (ctx.usdRate) {
      amountUsd = await ctx.usdRate(t.mint ?? "SOL", t.amountBaseUnits, t.decimals);
    }
    if (amountUsd === null) {
      perTransfer.push({
        transfer: t,
        verdict: "deny",
        reasonCodes: ["TWZRD_UNPRICED_ASSET"],
        payTo,
        amountUsd: null,
      });
      continue;
    }

    if (ctx.requireCosign && ctx.cosign == null) {
      perTransfer.push({
        transfer: t,
        verdict: "deny",
        reasonCodes: ["TWZRD_MANDATE_REQUIRED"],
        payTo,
        amountUsd,
      });
      continue;
    }
    if (ctx.cosign != null) {
      try {
        bindCosign(
          ctx.cosign,
          {
            rail: ctx.rail ?? SOLANA_MAINNET_CAIP2,
            recipient: payTo,
            asset: t.mint ?? "SOL",
            amount: t.amountBaseUnits,
            policy_id: ctx.policyId ?? "",
            decision_id: ctx.decisionId ?? "",
          },
          ctx.now,
        );
      } catch (e) {
        const reason =
          e instanceof MandateRefusal
            ? `TWZRD_MANDATE_${e.reason.toUpperCase()}`
            : "TWZRD_MANDATE_INVALID";
        perTransfer.push({
          transfer: t,
          verdict: "deny",
          reasonCodes: [reason],
          payTo,
          amountUsd,
        });
        continue;
      }
    }

    // 4. Run the policy brain.
    const intent: PaymentIntentLike = {
      protocol: "direct",
      network: SOLANA_MAINNET_CAIP2,
      asset: t.mint ?? "native:SOL",
      amount: amountUsd,
      payTo,
      context: ctx.purpose ? { purpose: ctx.purpose } : undefined,
    };
    const brain = await ctx.evaluate(intent, ctx.evaluateOptions ?? {});
    // Co-signer seat: ALLOW means sign the whole transaction, so ONLY an explicit "allow"
    // authorizes it. A "warn" (which advisory/fee-payer hooks may pass) must NOT sign here.
    let verdict: Verdict = "deny";
    let reasonCodes = brain.reasonCodes;
    if (brain.decision === "allow") {
      verdict = "allow";
    } else if (brain.decision === "warn") {
      reasonCodes = [...brain.reasonCodes, "TWZRD_POLICY_WARN_REFUSED"];
    }
    perTransfer.push({ transfer: t, verdict, reasonCodes, payTo, amountUsd, intent, brain });
  }

  const verdict: Verdict = perTransfer.every((p) => p.verdict === "allow") ? "allow" : "deny";
  const reasonCodes = Array.from(new Set(perTransfer.flatMap((p) => p.reasonCodes)));
  return {
    verdict,
    reasonCodes,
    transfers: decoded.transfers,
    perTransfer,
    priorityFeeLamports,
  };
}
