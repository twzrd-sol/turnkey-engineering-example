import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MandateRefusal,
  REFUSE,
  bindCosign,
  parseCosignRequest,
  type CosignRequest,
} from "./mandate.js";

function refuse(reason: string, field?: string): never {
  throw new MandateRefusal(reason, field);
}

function fileName(decisionId: string): string {
  return `${createHash("sha256").update(decisionId).digest("hex")}.json`;
}

/** Stable decision id known before the transaction is submitted to Turnkey. */
export function decisionIdForUnsignedTransaction(unsigned: string): string {
  const hex = unsigned.startsWith("0x") ? unsigned.slice(2) : unsigned;
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    refuse(REFUSE.INVALID_FIELD, "unsigned_transaction");
  }
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}

export interface MandateStore {
  submit(input: unknown, now?: number): Promise<CosignRequest>;
  claim(decisionId: string, activityId: string): Promise<CosignRequest | null>;
}

/** Durable single-use mandate inbox. A retry by the same activity is idempotent. */
export class FileMandateStore implements MandateStore {
  constructor(readonly dir: string) {}

  private async ensure(): Promise<void> {
    await Promise.all([
      mkdir(join(this.dir, "requests"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.dir, "claims"), { recursive: true, mode: 0o700 }),
    ]);
  }

  async submit(input: unknown, now: number = Date.now()): Promise<CosignRequest> {
    const request = parseCosignRequest(input);
    bindCosign(request, request, now);
    await this.ensure();
    try {
      await writeFile(
        join(this.dir, "requests", fileName(request.decision_id)),
        `${JSON.stringify(request)}\n`,
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        refuse(REFUSE.DECISION_REPLAY, "decision_id");
      }
      throw error;
    }
    return request;
  }

  async claim(decisionId: string, activityId: string): Promise<CosignRequest | null> {
    await this.ensure();
    const name = fileName(decisionId);
    let request: CosignRequest;
    try {
      request = parseCosignRequest(
        JSON.parse(await readFile(join(this.dir, "requests", name), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const claimPath = join(this.dir, "claims", name);
    try {
      await writeFile(claimPath, `${JSON.stringify({ activity_id: activityId })}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(claimPath, "utf8")) as {
        activity_id?: unknown;
      };
      if (existing.activity_id !== activityId) {
        refuse(REFUSE.DECISION_REPLAY, "decision_id");
      }
    }
    return request;
  }
}
