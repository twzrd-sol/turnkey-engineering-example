import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileMandateStore,
  decisionIdForUnsignedTransaction,
} from "../src/mandate-store.js";
import { MandateRefusal, REFUSE } from "../src/mandate.js";

const root = await mkdtemp(join(tmpdir(), "twzrd-mandates-"));
const unsigned = "01020304";
const decisionId = decisionIdForUnsignedTransaction(unsigned);
const request = {
  rail: "solana:mainnet",
  recipient: "merchant",
  asset: "USDC",
  amount: "10",
  expiry: "2099-01-01T00:00:00Z",
  policy_id: "partner.v1",
  decision_id: decisionId,
};

try {
  const store = new FileMandateStore(root);
  await store.submit(request);
  assert.equal((await store.claim(decisionId, "activity-1"))?.amount, "10");
  assert.equal((await store.claim(decisionId, "activity-1"))?.amount, "10");
  await assert.rejects(
    () => store.claim(decisionId, "activity-2"),
    (error: unknown) =>
      error instanceof MandateRefusal && error.reason === REFUSE.DECISION_REPLAY,
  );
  await assert.rejects(
    () => store.submit(request),
    (error: unknown) =>
      error instanceof MandateRefusal && error.reason === REFUSE.DECISION_REPLAY,
  );
  assert.equal(await store.claim("missing", "activity-3"), null);
  assert.throws(() => decisionIdForUnsignedTransaction("not-hex"), /invalid_field/);
  console.log("ok  durable mandate is single-use and same-activity idempotent");
} finally {
  await rm(root, { recursive: true, force: true });
}
