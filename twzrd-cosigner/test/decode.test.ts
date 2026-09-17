/**
 * Decoder tests against REAL mainnet transactions (fixtures/mainnet-transfers.json,
 * captured 2026-07-13 via getTransaction). Ground truth is the RPC's own jsonParsed
 * output, so these are non-circular: the decoder is checked against Solana, not against
 * our own encoder.
 *
 * Run: npx tsx test/decode.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decodeTransaction } from "../src/decode.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(
  readFileSync(join(here, "fixtures", "mainnet-transfers.json"), "utf8"),
) as Record<string, { sig: string; info: any; raw_b64: string; has_alt: boolean }>;

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_PROGRAM_BYTES = Buffer.from(
  "0306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000",
  "hex",
);
const ATA_PROGRAM_BYTES = Buffer.from(
  "8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859",
  "hex",
);

/* 1. A plain USDC transferChecked with all accounts in static keys decodes fully:
 *    mint, dest ATA, amount, decimals. */
{
  const f = FIX.legacy_simple;
  const tx = decodeTransaction(f.raw_b64);
  const t = tx.transfers.find((x) => x.kind === "spl_transfer_checked");
  assert.ok(t, "should find a transferChecked");
  assert.equal(t!.altUnresolved, false, "all transfer accounts are in static keys");
  assert.equal(t!.program, "spl-token");
  assert.equal(t!.mint, USDC, "mint resolves from the checked instruction accounts");
  assert.equal(
    t!.destination,
    f.info.destination,
    "destination ATA matches the RPC ground truth",
  );
  assert.equal(
    t!.amountBaseUnits,
    f.info.tokenAmount.amount,
    "raw u64 amount matches RPC",
  );
  assert.equal(t!.decimals, f.info.tokenAmount.decimals, "decimals from the checked ix byte");
  console.log("ok  decode legacy USDC transferChecked ->", t!.amountBaseUnits, "base units");
}

/* 2. A v0 tx whose transferChecked references an ALT-loaded account (here the mint):
 *    the decoder MUST flag altUnresolved so the caller fails closed, while still reading
 *    amount/decimals from instruction DATA. This is the crux the filtering-RPC seat died
 *    on and the co-signer must handle honestly — an ALT-hidden account it cannot name. */
{
  const f = FIX.v0_alt;
  const tx = decodeTransaction(f.raw_b64);
  assert.equal(tx.hasAddressTableLookups, true, "v0 tx with ALTs is detected");
  const t = tx.transfers.find((x) => x.kind === "spl_transfer_checked");
  assert.ok(t, "transferChecked still detected via program+discriminator");
  assert.equal(t!.altUnresolved, true, "an ALT-referenced account must flag unresolved");
  assert.equal(t!.mint, null, "the ALT-loaded mint cannot be named offline");
  assert.equal(
    t!.amountBaseUnits,
    f.info.tokenAmount.amount,
    "amount is still readable from ix data even when an account is in an ALT",
  );
  console.log("ok  decode v0+ALT flags unresolved, keeps amount");
}

/* 3. A native System-program SOL transfer decodes with the native marker and 9 decimals. */
{
  const f = FIX.system_sol;
  const tx = decodeTransaction(f.raw_b64);
  const t = tx.transfers.find((x) => x.kind === "system_sol");
  assert.ok(t, "should find a system transfer");
  assert.equal(t!.program, "system");
  assert.equal(t!.mint, "SOL");
  assert.equal(t!.decimals, 9);
  assert.equal(t!.destination, f.info.destination, "recipient wallet matches RPC");
  assert.equal(t!.amountBaseUnits, String(f.info.lamports), "lamports match RPC");
  console.log("ok  decode native SOL transfer ->", t!.amountBaseUnits, "lamports");
}

/* 4. Programs the decoder does not understand yield no phantom transfers. */
{
  const f = FIX.legacy_simple;
  const tx = decodeTransaction(f.raw_b64);
  for (const t of tx.transfers) {
    assert.ok(
      ["system", "spl-token", "spl-token-2022"].includes(t.program),
      "only known transfer programs are emitted",
    );
  }
  console.log("ok  no phantom transfers from unknown programs");
}

/* 5. Instruction accounting: every instruction is categorized. A clean payment has only
 *    benign + transfer; a bundled tx exposes its extra instruction as "other". */
{
  const clean = decodeTransaction(FIX.clean_usdc.raw_b64);
  assert.ok(
    clean.instructions.every((i) => i.category === "benign" || i.category === "transfer"),
    "clean payment: only compute-budget + the transfer",
  );
  assert.equal(clean.instructions.filter((i) => i.category === "transfer").length, 1);

  const bundled = decodeTransaction(FIX.legacy_simple.raw_b64);
  const other = bundled.instructions.filter((i) => i.category === "other");
  assert.ok(other.length >= 1, "the CloseAccount alongside the transfer is 'other'");
  assert.ok(
    other.some((i) => (i.detail ?? "").startsWith("spl-token-op-")),
    "a non-transfer SPL opcode is flagged, not silently ignored",
  );

  const sys = decodeTransaction(FIX.system_sol.raw_b64);
  assert.ok(
    sys.instructions.some((i) => i.category === "other"),
    "the unknown program alongside the SOL transfer is 'other'",
  );
  console.log("ok  every instruction categorized (benign / transfer / other)");
}

/* 6. Compute-budget instructions are decoded into a bounded fee exposure. */
{
  const tx = decodeTransaction(FIX.clean_usdc.raw_b64);
  assert.deepEqual(tx.computeBudget, {
    computeUnitLimit: 500,
    microLamportsPerComputeUnit: "150000000",
    priorityFeeLamports: "75000",
    unsupported: [],
  });
  console.log("ok  compute budget exposes the requested priority fee");
}

/* 7. ATA creation has a rent-payer side effect and is not blanket-benign. */
{
  const raw = Buffer.from(FIX.clean_usdc.raw_b64, "base64");
  const programOffset = raw.indexOf(COMPUTE_PROGRAM_BYTES);
  assert.ok(programOffset >= 0, "fixture contains the compute-budget program key");
  ATA_PROGRAM_BYTES.copy(raw, programOffset);
  const tx = decodeTransaction(raw);
  assert.ok(
    tx.instructions.slice(0, 2).every((ix) => ix.category === "other"),
    "ATA program instructions are unaccounted until their rent exposure is modeled",
  );
  console.log("ok  ATA instructions fail closed instead of hiding rent exposure");
}

console.log("\nDECODE: all assertions passed");
