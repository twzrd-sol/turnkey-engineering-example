/**
 * Live-shaped seller intelligence against a local mock of the TWZRD intel HTTP
 * API. Exercises the real gate HTTP client and real policy evaluator with mock
 * Turnkey votes. No public network, no funds, no signing.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createMemorySpendLedger, createSeededDecisionSigner, evaluateIntent } from "twzrd-x402-gate";

import { createMockTurnkeyApprover } from "../src/approver.js";
import { createSellerIntelligence, parseSellerIntelMode } from "../src/intelligence.js";
import type { EvaluatePaymentFn } from "../src/decide.js";
import { processPendingActivity } from "../src/worker.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mainnet-transfers.json", import.meta.url), "utf8"));
const WALLET = "EKLwbUquEHL5LZFi7L3BmNybpBRF5kCPmbJHmXYkvshK";
const OWNER = "MerchantOwnerWa11etAAAAAAAAAAAAAAAAAAAAAAA";
const signer = createSeededDecisionSigner(randomBytes(32).toString("hex"));

// mode parsing
assert.equal(parseSellerIntelMode(undefined), "live");
assert.equal(parseSellerIntelMode("live"), "live");
assert.equal(parseSellerIntelMode("off"), "off");
assert.throws(() => parseSellerIntelMode("maybe"), /TWZRD_SELLER_INTEL/);
assert.equal(createSellerIntelligence({ mode: "off" }), undefined);
console.log("ok  TWZRD_SELLER_INTEL parses live/off and off yields no provider");

type Card = { decision?: "allow" | "warn" | "block"; trust_score?: number; can_spend?: boolean; caveats?: string[] };
type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: unknown };

function startMock(card: Card, merchant: { wash_flagged?: boolean } | number): Promise<{ server: Server; base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      if (req.method === "POST" && req.url === "/v1/intel/preflight") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ preflight_id: 4242, readiness_card: { seller_wallet: OWNER, ...card } }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/v1/intel/merchant_card/")) {
        if (typeof merchant === "number") { res.statusCode = merchant; res.end("{}"); return; }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ wallet: OWNER, ...merchant }));
        return;
      }
      res.statusCode = 404; res.end("{}");
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    ok({ server, base: `http://127.0.0.1:${port}`, seen });
  }));
}

async function runWorkerOnce(base: string) {
  const observations: unknown[] = [];
  const intelligence = createSellerIntelligence({ mode: "live", intelBase: base, runId: "test-run", onObservation: (o) => observations.push(o) });
  assert.ok(intelligence);
  const evaluate: EvaluatePaymentFn = async (intent) => {
    const r = await evaluateIntent(intent, { signer, ledger: createMemorySpendLedger(), policy: { maxAmountUsd: "100", refuseWashFlagged: true }, intelligence });
    return { decision: r.decision, reasonCodes: r.reasonCodes };
  };
  const approver = createMockTurnkeyApprover();
  const result = await processPendingActivity({
    id: "seller-intel", fingerprint: "offline-fixture", status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    intent: { signTransactionIntentV2: { unsignedTransaction: Buffer.from(fixture.clean_usdc.raw_b64, "base64").toString("hex"), signWith: WALLET } },
  }, { expectedSigner: WALLET, evaluate, resolveOwner: () => OWNER, approver });
  return { result, approver, observations: observations as Array<Record<string, unknown>> };
}

const scenarios: Array<{ name: string; card: Card; merchant: { wash_flagged?: boolean } | number; action: string; reasons: string[]; approved: boolean }> = [
  { name: "seller with evidence and decision=allow is approved", card: { decision: "allow", trust_score: 82, can_spend: true, caveats: ["trust_score_basis:corpus_teaser_v1:provider_reputation_v1"] }, merchant: { wash_flagged: false }, action: "APPROVE_ACTIVITY", reasons: ["ALLOW"], approved: true },
  { name: "never-seen seller (free-tier warn) is refused, not signed", card: { decision: "warn", trust_score: 45, can_spend: false, caveats: ["trust_score_basis:corpus_teaser_v1:insufficient_free_evidence"] }, merchant: { wash_flagged: false }, action: "REJECT_ACTIVITY", reasons: ["INTEL_WARN", "TWZRD_POLICY_WARN_REFUSED"], approved: true },
  { name: "decision=block seller is refused", card: { decision: "block", trust_score: 5 }, merchant: { wash_flagged: false }, action: "REJECT_ACTIVITY", reasons: ["INTEL_BLOCK"], approved: false },
  { name: "allow card but merchant_card wash_flagged=true is refused", card: { decision: "allow", trust_score: 82 }, merchant: { wash_flagged: true }, action: "REJECT_ACTIVITY", reasons: ["WASH_FLAGGED"], approved: false },
  // Gate 0.9.9 made the wash lookup fail-closed; 0.9.3 approved here (fail-open on the card).
  { name: "allow card but merchant_card unreachable (503) is refused (gate >= 0.9.9 fail-closed)", card: { decision: "allow", trust_score: 82 }, merchant: 503, action: "REJECT_ACTIVITY", reasons: ["INTEL_BLOCK"], approved: false },
];

for (const s of scenarios) {
  const mock = await startMock(s.card, s.merchant);
  try {
    const { result, approver, observations } = await runWorkerOnce(mock.base);
    assert.equal(result.decision.action, s.action, JSON.stringify(result.decision));
    assert.equal(approver.calls[0]?.action, s.action);
    for (const r of s.reasons) assert.ok(result.decision.reasonCodes.includes(r), `${r} in ${JSON.stringify(result.decision.reasonCodes)}`);
    const pre = mock.seen.find((x) => x.url === "/v1/intel/preflight");
    assert.ok(pre, "preflight was called");
    const body = pre.body as Record<string, unknown>;
    assert.equal(body.seller_wallet, OWNER, "preflight scores the resolved owner wallet, not the token account");
    assert.equal(body.price_usdc, 100);
    assert.equal(body.chain, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    assert.equal(pre.headers["x-twzrd-integration"], "twzrd-cosigner");
    assert.equal(pre.headers["x-twzrd-run-id"], "test-run");
    assert.ok(mock.seen.some((x) => x.url === `/v1/intel/merchant_card/${OWNER}`), "merchant_card wash check was called");
    assert.equal(observations.length, 1);
    assert.equal(observations[0].approved, s.approved);
    assert.equal(observations[0].preflightId, 4242);
    console.log(`ok  ${s.name}: ${result.decision.reasonCodes.join(",")}`);
  } finally {
    await new Promise((ok) => mock.server.close(() => ok(undefined)));
  }
}

// Outage: nothing listening. Even with TWZRD_FAIL_OPEN=1 in the environment the
// co-signer pins fail-closed and must REJECT.
{
  const probe = await startMock({}, 200 as never);
  const { port } = probe.server.address() as AddressInfo;
  await new Promise((ok) => probe.server.close(() => ok(undefined)));
  const prev = process.env.TWZRD_FAIL_OPEN;
  process.env.TWZRD_FAIL_OPEN = "1";
  const origWarn = console.warn; console.warn = () => {};
  try {
    const { result, approver, observations } = await runWorkerOnce(`http://127.0.0.1:${port}`);
    assert.equal(result.decision.action, "REJECT_ACTIVITY", JSON.stringify(result.decision));
    assert.equal(approver.calls[0]?.action, "REJECT_ACTIVITY");
    assert.ok(result.decision.reasonCodes.includes("INTEL_BLOCK"));
    assert.equal(observations[0].approved, false);
    assert.match(String(observations[0].reason), /fail_closed/);
    console.log(`ok  intelligence service unreachable refuses even with TWZRD_FAIL_OPEN=1: ${result.decision.reasonCodes.join(",")}`);
  } finally {
    console.warn = origWarn;
    if (prev === undefined) delete process.env.TWZRD_FAIL_OPEN; else process.env.TWZRD_FAIL_OPEN = prev;
  }
}
