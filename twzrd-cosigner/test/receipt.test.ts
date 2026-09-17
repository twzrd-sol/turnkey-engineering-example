import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSeededDecisionSigner } from "twzrd-x402-gate";

import { FileVetoReceiptStore, verifyVetoReceipt } from "../src/receipt.js";

const root = await mkdtemp(join(tmpdir(), "twzrd-receipts-"));
const signer = createSeededDecisionSigner(
  "7a4c2e916d08bf35c1a7e49d620bf8135a9ce247d18b306f4e92ca751d63b80e",
  "test-veto-key",
);
const store = new FileVetoReceiptStore(root, signer, () => Date.parse("2026-08-30T08:00:00Z"));
const input = {
  decisionId: "a".repeat(64),
  policyId: "partner.v1",
  activityId: "activity-1",
  fingerprint: "fp-1",
  action: "APPROVE_ACTIVITY" as const,
  verdict: "allow" as const,
  reasonCodes: ["ALLOW"],
  stamp: { ok: true as const, dryRun: false, finalized: true },
};

try {
  const receipt = await store.record(input);
  assert.equal(receipt.schema, "twzrd.veto-receipt.v1");
  assert.equal(receipt.vote.finalized, true);
  assert.equal(verifyVetoReceipt(receipt, signer.publicKeyPem), true);
  assert.equal(
    verifyVetoReceipt({ ...receipt, action: "REJECT_ACTIVITY" }, signer.publicKeyPem),
    false,
  );
  assert.deepEqual(await store.record(input), receipt);
  await assert.rejects(
    () => store.record({ ...input, activityId: "activity-2" }),
    /another vote/,
  );
  assert.deepEqual(await store.get(input.decisionId), receipt);
  assert.equal(await store.get("missing"), null);
  console.log("ok  accepted vote produces one durable, verifiable receipt");
} finally {
  await rm(root, { recursive: true, force: true });
}
