/**
 * TWZRD co-signer — shared types. The decision brain (twzrd-x402-gate's
 * evaluateIntent) is dependency-injected via `EvaluatePaymentFn`, so the decode +
 * decide core has no vendor dependency and is testable fully offline. The
 * structural types below mirror the fields this package actually reads from the
 * x402-gate PaymentIntent / SpendPolicy / PaymentDecision; the production adapter
 * (see README) supplies the real implementation.
 */

/** A single payment-shaped transfer decoded from an unsigned Solana transaction. */
export type DecodedTransferKind = "system_sol" | "spl_transfer" | "spl_transfer_checked";

export interface DecodedTransfer {
  program: "system" | "spl-token" | "spl-token-2022";
  kind: DecodedTransferKind;
  /** Sender token account (SPL) or funding wallet (SOL). null when it lives in an ALT. */
  source: string | null;
  /** Recipient token account (SPL) or wallet (SOL). null when it lives in an ALT. */
  destination: string | null;
  /** Mint, "SOL" for native, or null when unknown (plain Transfer / ALT-hidden). */
  mint: string | null;
  /** Raw u64 amount as a decimal string (base units / lamports). Never a float. */
  amountBaseUnits: string;
  /** Token decimals when known (TransferChecked ix byte, or 9 for SOL); else null. */
  decimals: number | null;
  /** The authority moving the funds (the payer); null when it lives in an ALT. */
  authority: string | null;
  /**
   * True when any account this transfer needs was loaded from an Address Lookup
   * Table and therefore cannot be named from the transaction bytes alone. The payee
   * is unknowable offline in that case, so the co-signer must fail closed.
   */
  altUnresolved: boolean;
}

/**
 * Every instruction in the transaction, classified. The whole-tx guard requires that
 * EVERY instruction be either an evaluated `transfer` or a fund-safe `benign` one; a
 * single `other` instruction (an unknown program, an SPL approve/setAuthority/close, an
 * appended System transfer, an ALT-hidden program id) means the co-signer cannot account
 * for what the transaction does and must fail closed. Evaluating only the transfers we
 * recognize while ignoring the rest is exactly the append-a-drain bypass.
 */
export type InstructionCategory = "transfer" | "benign" | "other";

export interface InstructionSummary {
  index: number;
  /** Program id, or null when the program id itself is ALT-loaded (suspicious). */
  program: string | null;
  category: InstructionCategory;
  /** Human label / opcode note; for "other" this is why it was not accounted. */
  detail?: string;
  /** Index into DecodedTx.transfers when category === "transfer". */
  transferIndex?: number;
}

/** Requested Compute Budget settings and their priority-fee upper bound. */
export interface ComputeBudgetSummary {
  computeUnitLimit: number | null;
  microLamportsPerComputeUnit: string | null;
  /** ceil(limit * micro-lamports-per-CU / 1_000_000), in lamports. */
  priorityFeeLamports: string;
  /** Duplicate, malformed, or unsupported compute-budget settings. */
  unsupported: string[];
}

export interface DecodedTx {
  version: "legacy" | 0;
  numRequiredSignatures: number;
  /** Recognized payment-shaped transfers (derived from `instructions`). */
  transfers: DecodedTransfer[];
  /** Every instruction, classified — the basis of the whole-tx guard. */
  instructions: InstructionSummary[];
  hasAddressTableLookups: boolean;
  computeBudget?: ComputeBudgetSummary;
}

/** Structural view of the fields we set on a twzrd-x402-gate PaymentIntent. */
export interface PaymentIntentLike {
  protocol: "direct";
  network: string;
  asset: string;
  /** USD decimal string (<=6 fractional digits). The brain treats amount as USD. */
  amount: string;
  payTo: string;
  context?: { purpose?: string; recurring?: boolean };
}

/** Structural view of what evaluateIntent returns that we consume. */
export interface EvaluatedDecision {
  decision: "allow" | "warn" | "block";
  reasonCodes: string[];
  [key: string]: unknown;
}

/** Options forwarded to the injected brain. Kept loose on purpose. */
export interface EvaluateOptions {
  policy?: unknown;
  mandate?: unknown;
  intelligence?: unknown;
  ledger?: unknown;
  signer?: unknown;
  now?: number;
}

/** The injected decision brain (structurally twzrd-x402-gate's evaluateIntent). */
export type EvaluatePaymentFn = (
  intent: PaymentIntentLike,
  options: EvaluateOptions,
) => Promise<EvaluatedDecision>;
