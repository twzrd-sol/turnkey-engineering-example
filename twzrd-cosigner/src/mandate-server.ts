import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { MandateRefusal, REFUSE, parseCosignRequest } from "./mandate.js";
import type { MandateStore } from "./mandate-store.js";
import type { VetoReceipt } from "./receipt.js";

const MAX_BODY = 16 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const value = req.headers.authorization ?? "";
  const expected = `Bearer ${token}`;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw new MandateRefusal(REFUSE.INVALID_FIELD, "request");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new MandateRefusal(REFUSE.INVALID_FIELD, "request");
  }
}

export type MandateServerOptions = {
  store: MandateStore;
  policyId: string;
  bearerToken: string;
  receipts?: { get(decisionId: string): Promise<VetoReceipt | null> };
  publicKeyPem?: string;
  now?: () => number;
};

/** Authenticated mandate intake. The actual veto vote remains asynchronous. */
export function createMandateServer(options: MandateServerOptions) {
  return createServer(async (req, res) => {
    const receiptMatch = req.url?.match(/^\/v1\/receipts\/([0-9a-f]{64})$/);
    const knownGet =
      req.method === "GET" &&
      (req.url === "/v1/pubkey" || receiptMatch != null);
    if (knownGet) {
      if (!authorized(req, options.bearerToken)) {
        return json(res, 401, { ok: false, reason: "unauthorized" });
      }
      if (req.url === "/v1/pubkey") {
        return options.publicKeyPem
          ? json(res, 200, { key: options.publicKeyPem })
          : json(res, 404, { ok: false, reason: "not_found" });
      }
      try {
        const receipt = await options.receipts?.get(receiptMatch![1]!);
        return receipt
          ? json(res, 200, receipt)
          : json(res, 404, { ok: false, reason: "not_found" });
      } catch {
        return json(res, 503, { ok: false, reason: "signer_unavailable" });
      }
    }
    if (req.method !== "POST" || req.url !== "/v1/cosign") {
      return json(res, 404, { ok: false, reason: "not_found" });
    }
    if (!authorized(req, options.bearerToken)) {
      return json(res, 401, { ok: false, reason: "unauthorized" });
    }
    try {
      const request = parseCosignRequest(await body(req));
      if (request.policy_id !== options.policyId) {
        throw new MandateRefusal(REFUSE.POLICY_NOT_FOUND, "policy_id");
      }
      const stored = await options.store.submit(request, options.now?.());
      const tupleSha256 = createHash("sha256")
        .update(JSON.stringify(stored))
        .digest("hex");
      return json(res, 202, {
        ok: true,
        state: "pending",
        decision_id: stored.decision_id,
        tuple_sha256: tupleSha256,
      });
    } catch (error) {
      if (error instanceof MandateRefusal) {
        const status =
          error.reason === REFUSE.DECISION_REPLAY
            ? 409
            : error.reason === REFUSE.POLICY_NOT_FOUND
              ? 404
              : 422;
        return json(res, status, {
          ok: false,
          reason: error.reason,
          ...(error.field ? { field: error.field } : {}),
        });
      }
      return json(res, 503, { ok: false, reason: "signer_unavailable" });
    }
  });
}
