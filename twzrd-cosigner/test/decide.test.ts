/**
 * Decision-core tests. The x402-gate policy brain is INJECTED (ctx.evaluate), so this
 * suite runs offline. Most cases use constructed DecodedTx objects for precise control of
 * the instruction set; two cases decode real mainnet fixtures to prove the whole-tx guard
 * behaves on real data (a clean payment allows; a bundled tx with an extra instruction is
 * denied).
 *
 * Run: npx tsx test/decide.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decodeTransaction } from "../src/decode.js";
import { decidePayment, type EvaluatePaymentFn } from "../src/decide.js";
import type { DecodedTransfer, DecodedTx, InstructionSummary } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(
  readFileSync(join(here, "fixtures", "mainnet-transfers.json"), "utf8"),
) as Record<string, { info: any; raw_b64: string }>;

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "MerchantOwnerWa11etAAAAAAAAAAAAAAAAAAAAAAA";
const resolveOwner = () => OWNER;
const allowAll: EvaluatePaymentFn = async () => ({ decision: "allow", reasonCodes: ["ALLOW"] });
const blockAll: EvaluatePaymentFn = async () => ({
  decision: "block",
  reasonCodes: ["WASH_FLAGGED"],
});

/* Builders for precise instruction sets. */
function tc(destination: string, amount: string, decimals = 6, mint = USDC): DecodedTransfer {
  return {
    program: "spl-token",
    kind: "spl_transfer_checked",
    source: "Src11111111111111111111111111111111111111111",
    destination,
    mint,
    amountBaseUnits: amount,
    decimals,
    authority: "Auth1111111111111111111111111111111111111111",
    altUnresolved: false,
  };
}
function sol(destination: string, lamports: string): DecodedTransfer {
  return {
    program: "system",
    kind: "system_sol",
    source: "Src11111111111111111111111111111111111111111",
    destination,
    mint: "SOL",
    amountBaseUnits: lamports,
    decimals: 9,
    authority: "Src11111111111111111111111111111111111111111",
    altUnresolved: false,
  };
}
function bare(destination: string, amount: string): DecodedTransfer {
  return {
    program: "spl-token",
    kind: "spl_transfer",
    source: "Src11111111111111111111111111111111111111111",
    destination,
    mint: null,
    amountBaseUnits: amount,
    decimals: null,
    authority: "Auth1111111111111111111111111111111111111111",
    altUnresolved: false,
  };
}
function altTransfer(): DecodedTransfer {
  return {
    program: "spl-token",
    kind: "spl_transfer_checked",
    source: null,
    destination: null,
    mint: null,
    amountBaseUnits: "100",
    decimals: 6,
    authority: null,
    altUnresolved: true,
  };
}
function mk(transfers: DecodedTransfer[], others: string[] = []): DecodedTx {
  const instructions: InstructionSummary[] = [];
  transfers.forEach((_, i) =>
    instructions.push({ index: i, program: "spl-token", category: "transfer", transferIndex: i }),
  );
  others.forEach((o, k) =>
    instructions.push({ index: 100 + k, program: o, category: "other", detail: o }),
  );
  return { version: 0, numRequiredSignatures: 1, transfers, instructions, hasAddressTableLookups: false };
}

/* A. Priceable stable + allow -> allow, USD computed, payee = ATA owner. */
{
  let seen: any = null;
  const evaluate: EvaluatePaymentFn = async (intent) => {
    seen = intent;
    return { decision: "allow", reasonCodes: ["ALLOW"] };
  };
  const d = await decidePayment(mk([tc("DestAta", "516451")]), { evaluate, resolveOwner });
  assert.equal(d.verdict, "allow");
  assert.equal(d.perTransfer[0].payTo, OWNER);
  assert.equal(d.perTransfer[0].amountUsd, "0.516451");
  assert.equal(seen.amount, "0.516451", "brain receives USD, not base units");
  console.log("ok  priceable USDC + allow -> allow");
}

/* B. Brain blocks -> deny with the brain reason surfaced. */
{
  const d = await decidePayment(mk([tc("DestAta", "516451")]), { evaluate: blockAll, resolveOwner });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("WASH_FLAGGED"));
  console.log("ok  brain block -> deny");
}

/* C. ALT-unresolved payee -> deny WITHOUT calling the brain. */
{
  let called = false;
  const evaluate: EvaluatePaymentFn = async () => {
    called = true;
    return { decision: "allow", reasonCodes: [] };
  };
  const d = await decidePayment(mk([altTransfer()]), { evaluate, resolveOwner });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_UNRESOLVED_PAYEE"));
  assert.equal(called, false);
  console.log("ok  ALT payee -> fail-closed deny, brain not called");
}

/* D. Native SOL, no oracle -> deny UNPRICED. */
{
  const d = await decidePayment(mk([sol("DestWallet", "5374")]), { evaluate: allowAll, resolveOwner });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_UNPRICED_ASSET"));
  console.log("ok  unpriced SOL -> fail-closed deny");
}

/* E. Native SOL WITH usdRate -> priced and evaluated. */
{
  const usdRate = () => "0.000800";
  const d = await decidePayment(mk([sol("DestWallet", "5374")]), {
    evaluate: allowAll,
    resolveOwner,
    usdRate,
  });
  assert.equal(d.verdict, "allow");
  assert.equal(d.perTransfer[0].amountUsd, "0.000800");
  console.log("ok  priced SOL -> evaluated");
}

/* F. SPL transfer, no owner resolver -> deny. */
{
  const d = await decidePayment(mk([tc("DestAta", "1000000")]), { evaluate: allowAll });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_OWNER_RESOLVER_REQUIRED"));
  console.log("ok  missing owner resolver -> fail-closed deny");
}

/* G. Nothing payment-shaped -> deny by default. */
{
  const d = await decidePayment(mk([]), { evaluate: allowAll });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_NO_PAYMENT_DECODED"));
  console.log("ok  no payment -> fail-closed deny");
}

/* H. onUndecodable=allow opt-in. */
{
  const d = await decidePayment(mk([]), { evaluate: allowAll, onUndecodable: "allow" });
  assert.equal(d.verdict, "allow");
  console.log("ok  onUndecodable=allow respected");
}

/* I. WHOLE-TX GUARD: an unaccounted instruction (e.g. an appended SPL approve) denies the
 *    whole transaction WITHOUT consulting the brain — the appended-drain / hidden-approve
 *    bypass is closed. */
{
  let called = false;
  const evaluate: EvaluatePaymentFn = async () => {
    called = true;
    return { decision: "allow", reasonCodes: ["ALLOW"] };
  };
  const d = await decidePayment(mk([tc("DestAta", "100000")], ["spl-token-op-4"]), {
    evaluate,
    resolveOwner,
  });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_UNACCOUNTED_INSTRUCTION"));
  assert.deepEqual(d.unaccounted, ["spl-token-op-4"]);
  assert.equal(called, false, "brain is never consulted for a tx we cannot fully account for");
  console.log("ok  whole-tx guard: unaccounted instruction -> deny, brain not called");
}

/* J. Bare SPL Transfer (no mint in the ix) -> deny (asset unverifiable). */
{
  const d = await decidePayment(mk([bare("DestAta", "100000")]), { evaluate: allowAll, resolveOwner });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_BARE_TRANSFER"));
  console.log("ok  bare transfer -> deny (unverifiable mint)");
}

/* K. v0 fails closed on every multi-transfer transaction before any per-leg brain call.
 *    This prevents split-leg evasion of a per-intent USD ceiling. */
{
  let called = false;
  const evaluate: EvaluatePaymentFn = async () => {
    called = true;
    return { decision: "allow", reasonCodes: ["ALLOW"] };
  };
  const d = await decidePayment(mk([tc("FirstAta", "49000000"), tc("SecondAta", "49000000")]), {
    evaluate,
    resolveOwner,
  });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_MULTI_TRANSFER_UNSUPPORTED"));
  assert.equal(called, false, "split legs are rejected before creating ALLOW tokens");
  console.log("ok  multi-transfer split-cap bypass fails closed");
}

/* L. Guard opt-out is respected for integrators who bound non-payment ix another way. */
{
  const d = await decidePayment(mk([tc("DestAta", "100000")], ["unknown-program:Xyz"]), {
    evaluate: allowAll,
    resolveOwner,
    requireAllInstructionsAccounted: false,
  });
  assert.equal(d.verdict, "allow", "opt-out lets the unaccounted instruction through");
  console.log("ok  requireAllInstructionsAccounted=false respected");
}

/* M. REAL clean payment tx (ComputeBudget + single transferChecked) passes the guard. */
{
  const decoded = decodeTransaction(FIX.clean_usdc.raw_b64);
  assert.ok(
    decoded.instructions.every((i) => i.category !== "other"),
    "a clean payment tx has no unaccounted instruction",
  );
  const d = await decidePayment(decoded, { evaluate: allowAll, resolveOwner });
  assert.equal(d.verdict, "allow");
  console.log("ok  real clean USDC tx -> passes guard, allow");
}

/* N. REAL bundled tx (has a CloseAccount alongside the transfer) trips the guard. */
{
  const decoded = decodeTransaction(FIX.legacy_simple.raw_b64);
  assert.ok(
    decoded.instructions.some((i) => i.category === "other"),
    "the bundled fixture has an unaccounted instruction (CloseAccount)",
  );
  const d = await decidePayment(decoded, { evaluate: allowAll, resolveOwner });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_UNACCOUNTED_INSTRUCTION"));
  console.log("ok  real bundled tx -> whole-tx guard deny");
}

/* O. A "warn" from the brain must NOT authorize a signature on the co-signer seat. */
{
  const warnBrain: EvaluatePaymentFn = async () => ({
    decision: "warn",
    reasonCodes: ["UNKNOWN_UNDER_LIMIT"],
  });
  const d = await decidePayment(mk([tc("DestAta", "500000")]), { evaluate: warnBrain, resolveOwner });
  assert.equal(d.verdict, "deny", "warn is never ALLOW for a co-signer");
  assert.ok(d.reasonCodes.includes("TWZRD_POLICY_WARN_REFUSED"));
  assert.ok(d.reasonCodes.includes("UNKNOWN_UNDER_LIMIT"), "brain reason is preserved");
  console.log("ok  brain warn -> DENY (co-signer never signs on warn)");
}

/* P. Misdeclared decimals on a known stable -> deny (attacker shrinks a big transfer). */
{
  // 1_000_000 base units of USDC declared as 0 decimals would look like $1,000,000, but a
  // hostile declaration of high decimals would look like ~$0; either way the declared
  // decimals disagree with USDC's true 6, so we refuse.
  const d = await decidePayment(mk([tc("DestAta", "1000000", 0)]), { evaluate: allowAll, resolveOwner });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_MISDECLARED_DECIMALS"));
  console.log("ok  misdeclared decimals -> deny");
}

/* Q. A corrupt transfer (null destination but not flagged ALT) still denies — the payee
 *    check is belt-and-suspenders against any decode producing undefined fields. */
{
  const corrupt: DecodedTransfer = {
    program: "spl-token",
    kind: "spl_transfer_checked",
    source: "Src",
    destination: null,
    mint: USDC,
    amountBaseUnits: "1000000",
    decimals: 6,
    authority: "Auth",
    altUnresolved: false,
  };
  const d = await decidePayment(mk([corrupt]), { evaluate: allowAll, resolveOwner });
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_UNRESOLVED_PAYEE"));
  console.log("ok  corrupt null-destination transfer -> deny");
}

/* R. Full u64 precision: an amount above Number.MAX_SAFE_INTEGER is priced exactly (bigint
 *    throughout), so a huge transfer can never be silently understated below a USD cap. */
{
  const MAX_U64 = "18446744073709551615"; // 2^64 - 1, far above Number.MAX_SAFE_INTEGER
  let seen: any = null;
  const evaluate: EvaluatePaymentFn = async (intent) => {
    seen = intent;
    return { decision: "allow", reasonCodes: ["ALLOW"] };
  };
  const d = await decidePayment(mk([tc("DestAta", MAX_U64)]), { evaluate, resolveOwner });
  assert.equal(d.perTransfer[0].amountUsd, "18446744073709.551615", "no precision loss on u64");
  assert.equal(seen.amount, "18446744073709.551615", "brain sees the exact amount, not a rounded one");
  console.log("ok  max-u64 amount priced exactly (no Number precision loss)");
}

/* S. A hostile SetComputeUnitPrice cannot hide a large SOL fee beside a USD payment. */
{
  const raw = Buffer.from(FIX.clean_usdc.raw_b64, "base64");
  const originalPriceIx = Buffer.from("0380d1f00800000000", "hex");
  const priceIxOffset = raw.indexOf(originalPriceIx);
  assert.equal(priceIxOffset, 297, "fixture SetComputeUnitPrice offset is stable");
  raw.writeBigUInt64LE(20_000_000_000n, priceIxOffset + 1);
  const decoded = decodeTransaction(raw);
  const d = await decidePayment(decoded, { evaluate: allowAll, resolveOwner });
  assert.equal(decoded.computeBudget?.priorityFeeLamports, "10000000");
  assert.equal(d.verdict, "deny");
  assert.ok(d.reasonCodes.includes("TWZRD_PRIORITY_FEE_EXCEEDED"));
  console.log("ok  excessive compute-unit price fails closed before the brain");
}

console.log("\nDECIDE: all assertions passed");
