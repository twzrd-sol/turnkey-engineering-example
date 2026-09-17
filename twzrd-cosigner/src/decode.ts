/**
 * Dependency-free Solana transaction decoder, scoped to exactly what a payment
 * co-signer needs: detect System / SPL-Token / Token-2022 transfers in an unsigned
 * (or signed) transaction and pull payee, mint, amount, and decimals from the bytes.
 *
 * It deliberately does NOT resolve Address Lookup Table accounts: an ALT-loaded
 * account cannot be named from the transaction alone, so any transfer that references
 * one is flagged `altUnresolved` and the caller fails closed. This is the honest limit
 * that sinks a naive filtering-RPC but is safe for a co-signer that can simply refuse.
 *
 * Wire format reference: https://solana.com/docs/core/transactions
 */
import type { DecodedTx, DecodedTransfer, InstructionSummary } from "./types.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Memo programs have no independent asset/rent/fee movement. Compute-budget
 * instructions are parsed and bounded separately; ATA creation is not benign
 * because its funding account pays rent. */
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const MEMO_V2_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MEMO_V1_PROGRAM = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const BENIGN_PROGRAMS = new Set([
  MEMO_V2_PROGRAM,
  MEMO_V1_PROGRAM,
]);
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Empty seed: an all-zero input (e.g. the System program id) must encode to exactly
  // its leading-"1" run with no extra digit. Seeding [0] would add a spurious char.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < zeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** Accept base64 or hex (Turnkey encodes Solana unsigned transactions as hex). */
function toBytes(raw: string | Uint8Array): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  const s = raw.trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    return Uint8Array.from(Buffer.from(s, "hex"));
  }
  if (/^[A-Za-z0-9+/_=-]+$/.test(s)) {
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(normalized, "base64");
    if (buf.length > 0) return Uint8Array.from(buf);
  }
  throw new Error("[twzrd-cosigner] unsignedTransaction is neither valid hex nor base64");
}

/** compact-u16 (shortvec) reader. Returns [value, nextOffset]. */
function readShortVec(buf: Uint8Array, off: number): [number, number] {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (off >= buf.length) throw new Error("[twzrd-cosigner] truncated shortvec");
    const b = buf[off++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 21) throw new Error("[twzrd-cosigner] shortvec too long");
  }
  return [value, off];
}

function readU32LE(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function readU64LE(buf: Uint8Array, off: number): string {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
  return v.toString();
}

interface RawIx {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

/**
 * Decode a serialized transaction (with or without a leading signature vector) and
 * return the payment-shaped transfers it contains.
 */
export function decodeTransaction(raw: string | Uint8Array): DecodedTx {
  const buf = toBytes(raw);
  let off = 0;

  // Signature vector: shortvec count, then count * 64 bytes (zero-filled when unsigned).
  let sigCount: number;
  [sigCount, off] = readShortVec(buf, off);
  off += sigCount * 64;

  // Message header: version prefix (0x80|v for v0), then the 3 count bytes.
  let version: "legacy" | 0 = "legacy";
  if (off < buf.length && (buf[off] & 0x80) !== 0) {
    version = (buf[off] & 0x7f) as 0;
    off += 1;
  }
  const numRequiredSignatures = buf[off++];
  off += 2; // numReadonlySigned, numReadonlyUnsigned — not needed here

  // Static account keys.
  let keyCount: number;
  [keyCount, off] = readShortVec(buf, off);
  const staticKeys: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    staticKeys.push(base58(buf.subarray(off, off + 32)));
    off += 32;
  }
  const numStatic = staticKeys.length;

  off += 32; // recent blockhash

  // Instructions.
  let ixCount: number;
  [ixCount, off] = readShortVec(buf, off);
  const ixs: RawIx[] = [];
  for (let i = 0; i < ixCount; i++) {
    const programIdIndex = buf[off++];
    let acctLen: number;
    [acctLen, off] = readShortVec(buf, off);
    const accountIndexes: number[] = [];
    for (let a = 0; a < acctLen; a++) accountIndexes.push(buf[off++]);
    let dataLen: number;
    [dataLen, off] = readShortVec(buf, off);
    const data = buf.subarray(off, off + dataLen);
    off += dataLen;
    ixs.push({ programIdIndex, accountIndexes, data });
  }

  // Address table lookups (v0 only). We only need the count to report their presence;
  // the actual ALT pubkeys are unknowable offline, which is the whole point.
  let hasAddressTableLookups = false;
  if (version === 0) {
    let lookupCount: number;
    [lookupCount, off] = readShortVec(buf, off);
    hasAddressTableLookups = lookupCount > 0;
  }

  const keyAt = (idx: number): string | null => (idx < numStatic ? staticKeys[idx] : null);

  const transfers: DecodedTransfer[] = [];
  const instructions: InstructionSummary[] = [];
  let sawComputeBudget = false;
  let computeUnitLimit: number | null = null;
  let microLamportsPerComputeUnit: string | null = null;
  const unsupportedComputeBudget: string[] = [];
  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    const program = keyAt(ix.programIdIndex);
    if (program === COMPUTE_BUDGET_PROGRAM) {
      sawComputeBudget = true;
      if (ix.data.length === 5 && ix.data[0] === 2) {
        const limit = readU32LE(ix.data, 1);
        if (computeUnitLimit !== null) {
          unsupportedComputeBudget.push("duplicate-compute-unit-limit");
        } else if (limit === 0 || limit > MAX_COMPUTE_UNIT_LIMIT) {
          unsupportedComputeBudget.push(`invalid-compute-unit-limit:${limit}`);
        } else {
          computeUnitLimit = limit;
        }
      } else if (ix.data.length === 9 && ix.data[0] === 3) {
        const price = readU64LE(ix.data, 1);
        if (microLamportsPerComputeUnit !== null) {
          unsupportedComputeBudget.push("duplicate-compute-unit-price");
        } else {
          microLamportsPerComputeUnit = price;
        }
      } else {
        unsupportedComputeBudget.push(
          `unsupported-compute-budget-op:${ix.data[0] ?? "missing"}`,
        );
      }
    }
    const c = categorize(program, ix, keyAt, numStatic);
    if (c.category === "transfer") {
      const transferIndex = transfers.push(c.transfer) - 1;
      instructions.push({ index: i, program, category: "transfer", transferIndex });
    } else {
      instructions.push({ index: i, program, category: c.category, detail: c.detail });
    }
  }

  let computeBudget;
  if (sawComputeBudget) {
    const price = BigInt(microLamportsPerComputeUnit ?? "0");
    // Without an explicit limit, use Solana's transaction maximum as the
    // conservative upper bound rather than understate the fee.
    const units = BigInt(computeUnitLimit ?? MAX_COMPUTE_UNIT_LIMIT);
    const priorityFeeLamports = (price * units + 999_999n) / 1_000_000n;
    computeBudget = {
      computeUnitLimit,
      microLamportsPerComputeUnit,
      priorityFeeLamports: priorityFeeLamports.toString(),
      unsupported: unsupportedComputeBudget,
    };
  }

  return {
    version,
    numRequiredSignatures,
    transfers,
    instructions,
    hasAddressTableLookups,
    ...(computeBudget ? { computeBudget } : {}),
  };
}

type Classified =
  | { category: "transfer"; transfer: DecodedTransfer }
  | { category: "benign"; detail: string }
  | { category: "other"; detail: string };

function categorize(
  program: string | null,
  ix: RawIx,
  keyAt: (idx: number) => string | null,
  numStatic: number,
): Classified {
  const anyAltIn = (n: number) => ix.accountIndexes.slice(0, n).some((i) => i >= numStatic);
  const { data, accountIndexes: a } = ix;

  // A program id we cannot even name (loaded from an ALT) is inherently unaccountable.
  if (program === null) return { category: "other", detail: "alt-loaded-program" };

  if (BENIGN_PROGRAMS.has(program)) return { category: "benign", detail: program };

  if (program === COMPUTE_BUDGET_PROGRAM) {
    if (data.length === 5 && data[0] === 2) {
      return {
        category: "benign",
        detail: `compute-unit-limit:${readU32LE(data, 1)}`,
      };
    }
    if (data.length === 9 && data[0] === 3) {
      return {
        category: "benign",
        detail: `compute-unit-price-micro-lamports:${readU64LE(data, 1)}`,
      };
    }
    return {
      category: "other",
      detail: `compute-budget-op-${data[0] ?? "missing"}`,
    };
  }

  if (program === ATA_PROGRAM) {
    return { category: "other", detail: "associated-token-account-rent" };
  }

  if (program === SYSTEM_PROGRAM) {
    // System::Transfer = discriminator u32 == 2, then u64 lamports. Accounts: [from, to].
    if (data.length >= 12 && readU32LE(data, 0) === 2 && a.length >= 2) {
      const from = keyAt(a[0]);
      return {
        category: "transfer",
        transfer: {
          program: "system",
          kind: "system_sol",
          source: from,
          destination: keyAt(a[1]),
          mint: "SOL",
          amountBaseUnits: readU64LE(data, 4),
          decimals: 9,
          authority: from,
          altUnresolved: anyAltIn(2),
        },
      };
    }
    return { category: "other", detail: `system-op-${data.length >= 4 ? readU32LE(data, 0) : "?"}` };
  }

  if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
    const p = program === TOKEN_2022_PROGRAM ? "spl-token-2022" : "spl-token";
    // Transfer (3): accounts [source, dest, owner], data [3, u64]. (Mint not carried.)
    if (data.length >= 9 && data[0] === 3 && a.length >= 3) {
      return {
        category: "transfer",
        transfer: {
          program: p,
          kind: "spl_transfer",
          source: keyAt(a[0]),
          destination: keyAt(a[1]),
          mint: null,
          amountBaseUnits: readU64LE(data, 1),
          decimals: null,
          authority: keyAt(a[2]),
          altUnresolved: anyAltIn(3),
        },
      };
    }
    // TransferChecked (12): accounts [source, mint, dest, owner], data [12, u64, u8].
    if (data.length >= 10 && data[0] === 12 && a.length >= 4) {
      return {
        category: "transfer",
        transfer: {
          program: p,
          kind: "spl_transfer_checked",
          source: keyAt(a[0]),
          mint: keyAt(a[1]),
          destination: keyAt(a[2]),
          amountBaseUnits: readU64LE(data, 1),
          decimals: data[9],
          authority: keyAt(a[3]),
          altUnresolved: anyAltIn(4),
        },
      };
    }
    // Any other SPL opcode (approve, setAuthority, mintTo, burn, closeAccount, ...)
    // can move funds or authority and is NOT accounted for.
    return { category: "other", detail: `${p}-op-${data.length >= 1 ? data[0] : "?"}` };
  }

  return { category: "other", detail: `unknown-program:${program}` };
}
