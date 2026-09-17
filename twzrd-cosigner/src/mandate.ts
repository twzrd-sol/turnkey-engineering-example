/**
 * Mandate-bound veto: no ALLOW unless the co-sign tuple is complete and
 * matches this spend. TWZRD holds twzrd-guard; this is the share, not a logger.
 */
export const COSIGN_FIELDS = [
  "rail",
  "recipient",
  "asset",
  "amount",
  "expiry",
  "policy_id",
  "decision_id",
] as const;

export type CosignField = (typeof COSIGN_FIELDS)[number];
export type CosignRequest = { [K in CosignField]: string };

export const REFUSE = {
  MISSING_FIELD: "missing_field",
  UNKNOWN_FIELD: "unknown_field",
  INVALID_FIELD: "invalid_field",
  EXPIRED: "expired",
  POLICY_NOT_FOUND: "policy_not_found",
  DECISION_REPLAY: "decision_replay",
  TUPLE_MISMATCH: "tuple_mismatch",
} as const;

export class MandateRefusal extends Error {
  readonly reason: string;
  readonly field?: string;
  constructor(reason: string, field?: string) {
    super(field ? `${reason}: ${field}` : reason);
    this.name = "MandateRefusal";
    this.reason = reason;
    this.field = field;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RAIL = /^[a-z][a-z0-9-]*(?::[A-Za-z0-9._-]+)+$/;
const EXPIRY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function refuse(reason: string, field?: string): never {
  throw new MandateRefusal(reason, field);
}

export function parseCosignRequest(input: unknown): CosignRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    refuse(REFUSE.INVALID_FIELD, "request");
  }
  const rec = input as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!(COSIGN_FIELDS as readonly string[]).includes(key)) {
      refuse(REFUSE.UNKNOWN_FIELD, key);
    }
  }
  for (const key of COSIGN_FIELDS) {
    if (!Object.hasOwn(rec, key)) refuse(REFUSE.MISSING_FIELD, key);
    const v = rec[key];
    if (typeof v !== "string" || !v || v !== v.trim()) refuse(REFUSE.INVALID_FIELD, key);
  }
  const req = rec as CosignRequest;
  if (!RAIL.test(req.rail)) refuse(REFUSE.INVALID_FIELD, "rail");
  if (!/^[1-9][0-9]*$/.test(req.amount)) refuse(REFUSE.INVALID_FIELD, "amount");
  if (!EXPIRY.test(req.expiry) || !Number.isFinite(Date.parse(req.expiry))) {
    refuse(REFUSE.INVALID_FIELD, "expiry");
  }
  if (!ID.test(req.policy_id)) refuse(REFUSE.INVALID_FIELD, "policy_id");
  if (!ID.test(req.decision_id)) refuse(REFUSE.INVALID_FIELD, "decision_id");
  return Object.freeze(
    Object.fromEntries(COSIGN_FIELDS.map((key) => [key, req[key]])),
  ) as CosignRequest;
}

export type ObservedSpend = {
  rail: string;
  recipient: string;
  asset: string;
  amount: string;
  policy_id: string;
  decision_id: string;
};

/** Complete tuple, unexpired, identical to this spend — or no share. */
export function bindCosign(
  input: unknown,
  observed: ObservedSpend,
  now: number = Date.now(),
): CosignRequest {
  const req = parseCosignRequest(input);
  if (Date.parse(req.expiry) <= now) refuse(REFUSE.EXPIRED, "expiry");
  for (const key of [
    "rail",
    "recipient",
    "asset",
    "amount",
    "policy_id",
    "decision_id",
  ] as const) {
    if (req[key] !== observed[key]) refuse(REFUSE.TUPLE_MISMATCH, key);
  }
  return req;
}
