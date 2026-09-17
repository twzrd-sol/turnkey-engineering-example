/**
 * Wire-format hardening for the hand-rolled decoder (src/decode.ts).
 *
 * decode.test.ts checks the decoder against REAL mainnet transactions (RPC ground
 * truth) — the right test for "do we read Solana correctly". But those captured txs
 * are all small: single-byte shortvec counts, common pubkeys, well-formed bytes. This
 * suite exercises the parser MECHANICS they don't reach, because a bug in the
 * dependency-free byte reader (base58, compact-u16, u64, header) on this seat is a
 * mis-decode → a wrong ALLOW → a signable drain.
 *
 * The message ENCODER below is an independent inverse of the decoder written for this
 * test, plus an independent base58 DECODE — so a round-trip cross-checks decode.ts
 * against a second implementation, not against itself.
 *
 * Run: npx tsx test/decode-fuzz.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decodeTransaction } from "../src/decode.js";
import { decidePayment, type EvaluatePaymentFn } from "../src/decide.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Independent base58 decode (the inverse of decode.ts's hand-rolled encode). */
function bs58decode(s: string): number[] {
  const bytes: number[] = [];
  for (const ch of s) {
    const val = B58.indexOf(ch);
    if (val < 0) throw new Error(`bad base58 char: ${ch}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry = Math.floor(carry / 256);
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry = Math.floor(carry / 256);
    }
  }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);
  return bytes.reverse();
}

/** compact-u16 (shortvec) writer — the inverse of decode.ts's readShortVec. */
function wShortVec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    if (v < 0x80) {
      out.push(v);
      return out;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
}

function wU64LE(amount: bigint): number[] {
  const out: number[] = [];
  let v = amount;
  for (let i = 0; i < 8; i++) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}

function wU32LE(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

interface EncIx {
  programIndex: number;
  accounts: number[];
  data: number[];
}

/** Assemble a serialized (unsigned) Solana message. Mirrors the exact byte layout
 *  decode.ts reads: sig vector, header, static keys, blockhash, instructions, ALT count. */
function buildTx(opts: {
  version: "legacy" | 0;
  keys: string[]; // base58 pubkeys
  instructions: EncIx[];
  altLookups?: number;
}): string {
  const b: number[] = [];
  // Signature vector: one zero-filled 64-byte slot (unsigned). decode skips count*64.
  b.push(...wShortVec(1), ...new Array(64).fill(0));
  // Header: optional v0 version byte, then the 3 count bytes.
  if (opts.version === 0) b.push(0x80);
  b.push(1); // numRequiredSignatures
  b.push(0, 0); // numReadonlySigned, numReadonlyUnsigned
  // Static account keys.
  b.push(...wShortVec(opts.keys.length));
  for (const k of opts.keys) {
    const bytes = bs58decode(k);
    if (bytes.length !== 32) throw new Error(`key ${k} decoded to ${bytes.length} bytes`);
    b.push(...bytes);
  }
  // Recent blockhash.
  b.push(...new Array(32).fill(0));
  // Instructions.
  b.push(...wShortVec(opts.instructions.length));
  for (const ix of opts.instructions) {
    b.push(ix.programIndex);
    b.push(...wShortVec(ix.accounts.length), ...ix.accounts);
    b.push(...wShortVec(ix.data.length), ...ix.data);
  }
  // Address table lookups (v0 only). decode reads only the count.
  if (opts.version === 0) b.push(...wShortVec(opts.altLookups ?? 0));
  return Buffer.from(b).toString("base64");
}

// Known real pubkeys — all round-trippable (input string === re-encoded output).
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/* A. Legacy transferChecked, MAX u64 amount, 130 static keys (forces a 2-byte shortvec
 *    key count — the multi-byte compact-u16 path real small txs never hit). Round-trips
 *    base58 on the mint and dest, and the full u64 range. */
{
  const MAX_U64 = (1n << 64n) - 1n;
  const keys = [TOKEN, USDC, USDT, SYSTEM];
  while (keys.length < 130) keys.push(SYSTEM); // pad to force 2-byte key-count shortvec
  const txB64 = buildTx({
    version: "legacy",
    keys,
    instructions: [
      { programIndex: 0, accounts: [3, 1, 2, 3], data: [12, ...wU64LE(MAX_U64), 6] },
    ],
  });
  const tx = decodeTransaction(txB64);
  assert.equal(tx.transfers.length, 1, "one transfer decoded through 130 keys");
  const t = tx.transfers[0];
  assert.equal(t.kind, "spl_transfer_checked");
  assert.equal(t.mint, USDC, "mint round-trips through base58 (key index 1)");
  assert.equal(t.destination, USDT, "dest round-trips through base58 (key index 2)");
  assert.equal(t.amountBaseUnits, "18446744073709551615", "full u64 range, no truncation");
  assert.equal(t.decimals, 6);
  assert.equal(t.altUnresolved, false);
  console.log("ok  130-key legacy tx: 2-byte shortvec + max-u64 + base58 round-trip");
}

/* B. v0 transferChecked whose DEST account index points past the static keys (i.e. an
 *    ALT-loaded account). Must flag altUnresolved + null destination while still reading
 *    the amount from instruction data — the fail-closed crux, synthesized rather than
 *    captured. */
{
  const keys = [TOKEN, USDC, SYSTEM]; // numStatic = 3
  const txB64 = buildTx({
    version: 0,
    keys,
    // accounts [source, mint, dest, owner]; dest index 3 == numStatic -> ALT-loaded.
    instructions: [{ programIndex: 0, accounts: [0, 1, 3, 2], data: [12, ...wU64LE(500000n), 6] }],
    altLookups: 1,
  });
  const tx = decodeTransaction(txB64);
  assert.equal(tx.hasAddressTableLookups, true, "v0 ALT count detected");
  const t = tx.transfers[0];
  assert.equal(t.altUnresolved, true, "ALT-loaded dest flags unresolved");
  assert.equal(t.destination, null, "an account past static keys cannot be named");
  assert.equal(t.mint, USDC, "the static mint is still resolvable");
  assert.equal(t.amountBaseUnits, "500000", "amount read from ix data despite the ALT account");
  console.log("ok  v0 ALT-referenced dest: unresolved + null payee, amount preserved");
}

/* C. Native System SOL transfer round-trips with the 9-decimal SOL marker. */
{
  const txB64 = buildTx({
    version: "legacy",
    keys: [SYSTEM, USDC, USDT], // program, from, to
    instructions: [{ programIndex: 0, accounts: [1, 2], data: [...wU32LE(2), ...wU64LE(1_000_000_000n)] }],
  });
  const t = decodeTransaction(txB64).transfers.find((x) => x.kind === "system_sol");
  assert.ok(t, "system transfer decoded");
  assert.equal(t!.mint, "SOL");
  assert.equal(t!.decimals, 9);
  assert.equal(t!.destination, USDT);
  assert.equal(t!.amountBaseUnits, "1000000000");
  console.log("ok  system SOL transfer round-trip");
}

/* D. Bare SPL Transfer (opcode 3) decodes with null mint/decimals (unverifiable asset). */
{
  const txB64 = buildTx({
    version: "legacy",
    keys: [TOKEN, USDC, USDT, SYSTEM],
    instructions: [{ programIndex: 0, accounts: [1, 2, 3], data: [3, ...wU64LE(100000n)] }],
  });
  const t = decodeTransaction(txB64).transfers[0];
  assert.equal(t.kind, "spl_transfer");
  assert.equal(t.mint, null, "bare transfer carries no mint");
  assert.equal(t.decimals, null, "bare transfer carries no decimals");
  assert.equal(t.destination, USDT);
  assert.equal(t.amountBaseUnits, "100000");
  console.log("ok  bare SPL transfer: null mint/decimals");
}

/* E. 130 instructions (forces a 2-byte instruction-count shortvec): 129 compute-budget +
 *    1 transferChecked. Every instruction still categorized; exactly one transfer. */
{
  const keys = [COMPUTE_BUDGET, TOKEN, USDC, USDT, SYSTEM];
  const ixs: EncIx[] = [];
  for (let i = 0; i < 129; i++) ixs.push({ programIndex: 0, accounts: [], data: [2, ...wU32LE(200000)] });
  ixs.push({ programIndex: 1, accounts: [2 /*mint idx used as src*/, 2, 3, 4], data: [12, ...wU64LE(50000n), 6] });
  const tx = decodeTransaction(buildTx({ version: "legacy", keys, instructions: ixs }));
  assert.equal(tx.instructions.length, 130, "2-byte instruction-count shortvec parsed");
  assert.equal(tx.transfers.length, 1, "exactly one transfer among 130 instructions");
  assert.ok(
    tx.instructions.filter((i) => i.category === "benign").length === 129,
    "the 129 compute-budget ix are benign",
  );
  console.log("ok  130-instruction tx: 2-byte ix-count shortvec, one transfer");
}

/* F. Truncation robustness → fail-closed. Every prefix of a real mainnet tx must either
 *    make the decoder throw or make the decision core DENY — even under a fully permissive
 *    brain (allow-all + owner-is-self + everything-priced-$1). A corrupted tx must never
 *    yield an APPROVE; only a whole, understood tx may. */
{
  const here = dirname(fileURLToPath(import.meta.url));
  const FIX = JSON.parse(readFileSync(join(here, "fixtures", "mainnet-transfers.json"), "utf8")) as Record<
    string,
    { raw_b64?: string }
  >;
  const allowAll: EvaluatePaymentFn = async () => ({ decision: "allow", reasonCodes: ["ALLOW"] });
  const permissive = {
    evaluate: allowAll,
    resolveOwner: (acct: string) => acct, // treat every ATA as its own owner
    usdRate: () => "1", // price any asset at $1 so only decode/guard failures deny
  };

  let checked = 0;
  for (const [name, f] of Object.entries(FIX)) {
    if (!f.raw_b64) continue;
    const full = Buffer.from(f.raw_b64, "base64");
    for (const frac of [0.25, 0.5, 0.75, 0.9]) {
      const cut = Math.max(1, Math.floor(full.length * frac));
      const truncated = Buffer.from(full.subarray(0, cut)).toString("base64");
      let decoded;
      try {
        decoded = decodeTransaction(truncated);
      } catch {
        checked++;
        continue; // decoder rejected the corrupt bytes — fail-closed
      }
      const d = await decidePayment(decoded, permissive);
      assert.equal(
        d.verdict,
        "deny",
        `truncated ${name}@${frac} decoded but was not denied (reasons: ${d.reasonCodes.join(",")})`,
      );
      checked++;
    }
  }
  assert.ok(checked > 0, "at least one fixture truncation was exercised");
  console.log(`ok  truncation robustness: ${checked} corrupt prefixes all threw or denied`);
}

console.log("\nDECODE-FUZZ: all assertions passed");
