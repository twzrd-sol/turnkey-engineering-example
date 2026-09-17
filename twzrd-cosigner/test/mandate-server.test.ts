import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMandateServer } from "../src/mandate-server.js";
import {
  FileMandateStore,
  decisionIdForUnsignedTransaction,
} from "../src/mandate-store.js";
import type { VetoReceipt } from "../src/receipt.js";

const decisionId = decisionIdForUnsignedTransaction("01020304");
const receipt = {
  schema: "twzrd.veto-receipt.v1",
  decision_id: decisionId,
  policy_id: "partner.v1",
  activity_id: "activity-1",
  fingerprint: "fp-1",
  action: "APPROVE_ACTIVITY",
  verdict: "allow",
  reason_codes: ["ALLOW"],
  voted_at: "2026-08-30T08:00:00.000Z",
  vote: { ok: true, dry_run: false },
  key_id: "test-key",
  signature: "signature",
} satisfies VetoReceipt;

const root = await mkdtemp(join(tmpdir(), "twzrd-mandate-server-"));
const server = createMandateServer({
  store: new FileMandateStore(root),
  policyId: "partner.v1",
  bearerToken: "test-secret",
  publicKeyPem: "test-public-key",
  receipts: { get: async (id) => (id === decisionId ? receipt : null) },
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/cosign`;
  const request = {
    rail: "solana:mainnet",
    recipient: "merchant",
    asset: "USDC",
    amount: "10",
    expiry: "2099-01-01T00:00:00Z",
    policy_id: "partner.v1",
    decision_id: decisionId,
  };
  const post = (value: unknown, token = "test-secret") =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(value),
    });

  assert.equal((await post(request, "wrong")).status, 401);
  const accepted = await post(request);
  assert.equal(accepted.status, 202);
  assert.deepEqual(Object.keys(await accepted.json()).sort(), [
    "decision_id",
    "ok",
    "state",
    "tuple_sha256",
  ]);
  assert.equal((await post(request)).status, 409);
  assert.equal(
    (await post({ ...request, policy_id: "unknown", decision_id: "different" })).status,
    404,
  );
  const get = (path: string, token = "test-secret") =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  assert.equal((await get(`/v1/receipts/${decisionId}`, "wrong")).status, 401);
  const received = await get(`/v1/receipts/${decisionId}`);
  assert.equal(received.status, 200);
  assert.deepEqual(await received.json(), receipt);
  const publicKey = await get("/v1/pubkey");
  assert.deepEqual(await publicKey.json(), { key: "test-public-key" });
  console.log("ok  mandate intake authenticates, binds policy, and refuses replay");
} finally {
  server.close();
  await once(server, "close");
  await rm(root, { recursive: true, force: true });
}
