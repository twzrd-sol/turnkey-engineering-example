/**
 * Mandate-bound veto. No live Turnkey. Tuple must be complete and match the spend.
 */
import assert from "node:assert/strict";

import {
  bindCosign,
  MandateRefusal,
  parseCosignRequest,
  REFUSE,
} from "../src/mandate.js";
import { decidePayment, type EvaluatePaymentFn } from "../src/decide.js";
import type { DecodedTransfer, DecodedTx, InstructionSummary } from "../src/types.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "MerchantOwnerWa11etAAAAAAAAAAAAAAAAAAAAAAA";
const RAIL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const allowAll: EvaluatePaymentFn = async () => ({ decision: "allow", reasonCodes: ["ALLOW"] });

function tc(amount = "1000000"): DecodedTransfer {
  return {
    program: "spl-token",
    kind: "spl_transfer_checked",
    source: "Src11111111111111111111111111111111111111111",
    destination: "DestAta1111111111111111111111111111111111111",
    mint: USDC,
    amountBaseUnits: amount,
    decimals: 6,
    authority: "Auth1111111111111111111111111111111111111111",
    altUnresolved: false,
  };
}

function mk(transfers: DecodedTransfer[]): DecodedTx {
  const instructions: InstructionSummary[] = transfers.map((t, i) => ({
    index: i,
    program: t.program,
    category: "transfer",
    transferIndex: i,
  }));
  return {
    version: 0,
    numRequiredSignatures: 1,
    transfers,
    instructions,
    hasAddressTableLookups: false,
  };
}

function tuple(over: Record<string, string> = {}) {
  return {
    rail: RAIL,
    recipient: OWNER,
    asset: USDC,
    amount: "1000000",
    expiry: "2099-01-01T00:00:00Z",
    policy_id: "pol-1",
    decision_id: "dec-1",
    ...over,
  };
}

{
  const req = parseCosignRequest(tuple());
  assert.equal(req.decision_id, "dec-1");
  assert.throws(() => parseCosignRequest({ ...tuple(), extra: "x" }), MandateRefusal);
  assert.throws(() => parseCosignRequest({ ...tuple(), amount: "" }), /missing_field|invalid_field/);
  try {
    parseCosignRequest({ rail: RAIL });
    assert.fail("expected missing");
  } catch (e) {
    assert.ok(e instanceof MandateRefusal);
    assert.equal(e.reason, REFUSE.MISSING_FIELD);
  }
  console.log("ok  parse refuses incomplete or extra fields");
}

{
  bindCosign(tuple(), {
    rail: RAIL,
    recipient: OWNER,
    asset: USDC,
    amount: "1000000",
    policy_id: "pol-1",
    decision_id: "dec-1",
  });
  assert.throws(
    () =>
      bindCosign(tuple(), {
        rail: RAIL,
        recipient: "Other",
        asset: USDC,
        amount: "1000000",
        policy_id: "pol-1",
        decision_id: "dec-1",
      }),
    /tuple_mismatch: recipient/,
  );
  assert.throws(
    () => bindCosign(tuple({ expiry: "2000-01-01T00:00:00Z" }), {
      rail: RAIL,
      recipient: OWNER,
      asset: USDC,
      amount: "1000000",
      policy_id: "pol-1",
      decision_id: "dec-1",
    }),
    /expired/,
  );
  console.log("ok  bind refuses mismatch and expiry");
}

{
  const d = await decidePayment(mk([tc()]), {
    evaluate: allowAll,
    resolveOwner: () => OWNER,
    cosign: tuple(),
    policyId: "pol-1",
    decisionId: "dec-1",
  });
  assert.equal(d.verdict, "allow");
  console.log("ok  matching cosign allows");
}

{
  const d = await decidePayment(mk([tc()]), {
    evaluate: allowAll,
    resolveOwner: () => OWNER,
    requireCosign: true,
  });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_MANDATE_REQUIRED"));
  console.log("ok  requireCosign without tuple denies");
}

{
  const d = await decidePayment(mk([tc("999")]), {
    evaluate: allowAll,
    resolveOwner: () => OWNER,
    cosign: tuple(),
    policyId: "pol-1",
    decisionId: "dec-1",
  });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.some((c) => c.startsWith("TWZRD_MANDATE_")));
  console.log("ok  amount mismatch denies before brain allow");
}

{
  const d = await decidePayment(mk([tc()]), {
    evaluate: allowAll,
    resolveOwner: () => OWNER,
    cosign: tuple(),
    policyId: "other-policy",
    decisionId: "dec-1",
  });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_MANDATE_TUPLE_MISMATCH"));
  console.log("ok  policy id is bound, not decorative");
}

console.log("mandate.test.ts: all passed");
