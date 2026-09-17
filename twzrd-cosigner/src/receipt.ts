import { createHash, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  type DecisionSigner,
} from "twzrd-x402-gate";

import type { StampResult } from "./approver.js";
import type { TurnkeyAction } from "./turnkey.js";

const DOMAIN = "twzrd:veto-receipt:v1\0";

export type VetoReceipt = {
  schema: "twzrd.veto-receipt.v1";
  decision_id: string;
  policy_id: string;
  activity_id: string;
  fingerprint: string;
  action: Exclude<TurnkeyAction, "ABSTAIN">;
  verdict: "allow" | "deny";
  reason_codes: string[];
  voted_at: string;
  vote: {
    ok: true;
    dry_run: boolean;
    activity_status?: string;
    finalized?: boolean;
  };
  key_id: string;
  signature: string;
};

export type RecordVetoReceiptInput = {
  decisionId: string;
  policyId: string;
  activityId: string;
  fingerprint: string;
  action: Exclude<TurnkeyAction, "ABSTAIN">;
  verdict: "allow" | "deny";
  reasonCodes: string[];
  stamp: StampResult & { ok: true };
};

function name(decisionId: string): string {
  return `${createHash("sha256").update(decisionId).digest("hex")}.json`;
}

export function vetoReceiptPreimage(
  receipt: Omit<VetoReceipt, "signature">,
): Buffer {
  return Buffer.from(`${DOMAIN}${canonicalJson(receipt)}`);
}

export function verifyVetoReceipt(
  receipt: VetoReceipt,
  publicKeyPem: string,
): boolean {
  const { signature, ...unsigned } = receipt;
  try {
    return verify(
      null,
      vetoReceiptPreimage(unsigned),
      publicKeyPem,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/** Durable signed evidence of the vote Turnkey reported accepting. */
export class FileVetoReceiptStore {
  constructor(
    readonly dir: string,
    readonly signer: DecisionSigner,
    readonly now: () => number = Date.now,
  ) {}

  async record(input: RecordVetoReceiptInput): Promise<VetoReceipt> {
    if (!input.decisionId || !input.policyId || !input.activityId) {
      throw new Error("decisionId, policyId, and activityId are required");
    }
    const unsigned: Omit<VetoReceipt, "signature"> = {
      schema: "twzrd.veto-receipt.v1",
      decision_id: input.decisionId,
      policy_id: input.policyId,
      activity_id: input.activityId,
      fingerprint: input.fingerprint,
      action: input.action,
      verdict: input.verdict,
      reason_codes: [...input.reasonCodes],
      voted_at: new Date(this.now()).toISOString(),
      vote: {
        ok: true,
        dry_run: input.stamp.dryRun,
        ...(input.stamp.activityStatus
          ? { activity_status: input.stamp.activityStatus }
          : {}),
        ...(input.stamp.finalized == null
          ? {}
          : { finalized: input.stamp.finalized }),
      },
      key_id: this.signer.keyId,
    };
    const receipt: VetoReceipt = {
      ...unsigned,
      signature: Buffer.from(
        await this.signer.sign(vetoReceiptPreimage(unsigned)),
      ).toString("base64"),
    };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, name(input.decisionId));
    try {
      await writeFile(path, `${JSON.stringify(receipt)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.get(input.decisionId);
      if (
        existing?.activity_id === input.activityId &&
        existing.action === input.action &&
        existing.fingerprint === input.fingerprint
      ) {
        return existing;
      }
      throw new Error("decision receipt already belongs to another vote");
    }
  }

  async get(decisionId: string): Promise<VetoReceipt | null> {
    try {
      return JSON.parse(
        await readFile(join(this.dir, name(decisionId)), "utf8"),
      ) as VetoReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
