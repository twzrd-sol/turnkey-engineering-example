#!/usr/bin/env node
/** Typed operational CLI. No command runs merely by importing this module. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Turnkey, type TurnkeyApiClient } from "@turnkey/sdk-server";
import {
  createMemorySpendLedger,
  createSeededDecisionSigner,
  evaluateIntent,
  type SpendPolicy,
} from "twzrd-x402-gate";

import {
  DEFAULT_MAX_PRIORITY_FEE_LAMPORTS,
  type EvaluatePaymentFn,
} from "./decide.js";
import {
  createSellerIntelligence,
  describeSellerIntel,
  parseSellerIntelMode,
} from "./intelligence.js";
import { attestTurnkeyGuard } from "./quorum.js";
import { createMandateServer } from "./mandate-server.js";
import { FileMandateStore } from "./mandate-store.js";
import { FileVetoReceiptStore } from "./receipt.js";
import { createHeliusResolveOwner, createRpcResolveOwner } from "./resolve-owner.js";
import { setupTurnkeyGuard } from "./setup-turnkey.js";
import { createTurnkeyApprover } from "./turnkey-approver.js";
import { runCosignerWorker } from "./worker.js";

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`missing required env: ${names.join(" | ")}`);
}

function turnkeyCredentials(organizationId: string) {
  return {
    organizationId,
    apiBaseUrl: process.env.TURNKEY_API_BASE_URL,
    apiPublicKey: requiredEnv("TURNKEY_API_PUBLIC_KEY", "TURNKEY_PUBLIC"),
    apiPrivateKey: requiredEnv("TURNKEY_API_PRIVATE_KEY", "TURNKEY_PRIVATE"),
  };
}

function createTurnkeyClient(
  cfg: ReturnType<typeof turnkeyCredentials>,
): TurnkeyApiClient {
  return new Turnkey({
    apiBaseUrl: cfg.apiBaseUrl ?? "https://api.turnkey.com",
    apiPublicKey: cfg.apiPublicKey,
    apiPrivateKey: cfg.apiPrivateKey,
    defaultOrganizationId: cfg.organizationId,
  }).apiClient();
}

async function attestConfiguredGuard(
  client: TurnkeyApiClient,
  organizationId: string,
) {
  return attestTurnkeyGuard(
    client,
    organizationId,
    expectedGuardUsername(),
  );
}

function expectedGuardUsername(): string {
  return process.env.TWZRD_GUARD_USERNAME?.trim() || "twzrd-guard";
}

function parseInterval(value: string | undefined): number {
  const interval = Number(value ?? "3000");
  if (!Number.isFinite(interval) || interval < 100) {
    throw new Error("TWZRD_INTERVAL_MS must be a finite number >= 100");
  }
  return interval;
}

function parseLamportCap(value: string | undefined): string {
  const cap = value?.trim() || DEFAULT_MAX_PRIORITY_FEE_LAMPORTS;
  if (!/^\d+$/.test(cap)) {
    throw new Error("TWZRD_MAX_PRIORITY_FEE_LAMPORTS must be a nonnegative integer");
  }
  return cap;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4042");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TWZRD_COSIGN_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function assertMainnetRpc(rpcUrl: string): void {
  if (/\b(devnet|testnet)\b/i.test(rpcUrl)) {
    throw new Error("cosigner worker requires a Solana mainnet RPC URL");
  }
}

/** Read-only credential, organization, and 2-of-3 hot/veto/recovery check. */
export async function runPreflight(): Promise<void> {
  const organizationId = requiredEnv("TURNKEY_ORGANIZATION_ID");
  const cfg = turnkeyCredentials(organizationId);
  const client = createTurnkeyClient(cfg);
  const attestation = await attestConfiguredGuard(client, organizationId);
  const pending = await client.getActivities({
    organizationId,
    filterByStatus: ["ACTIVITY_STATUS_CONSENSUS_NEEDED"],
    filterByType: [
      "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
      "ACTIVITY_TYPE_SIGN_TRANSACTION",
    ],
    paginationOptions: { limit: "100" },
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        ...attestation,
        pendingSignActivitiesFirstPage: pending.activities.length,
      },
      null,
      2,
    ),
  );
}

/** Run live voting. This command never broadcasts a Solana transaction itself. */
export async function runWorker(): Promise<void> {
  if (process.env.TWZRD_ENABLE_LIVE_VOTING !== "1") {
    throw new Error("set TWZRD_ENABLE_LIVE_VOTING=1 to enable Turnkey votes");
  }

  const organizationId = requiredEnv("TURNKEY_ORGANIZATION_ID");
  const expectedSigner = requiredEnv("TURNKEY_WALLET_ADDRESS");
  const policyId = requiredEnv("TWZRD_POLICY_ID");
  const signer = createSeededDecisionSigner(requiredEnv("TWZRD_DECISION_SECRET"));
  const mandateStore = new FileMandateStore(
    resolve(process.env.TWZRD_MANDATE_DIR?.trim() || "data/mandates"),
  );
  const receiptStore = new FileVetoReceiptStore(
    resolve(process.env.TWZRD_RECEIPT_DIR?.trim() || "data/receipts"),
    signer,
  );
  const mandateServer = createMandateServer({
    store: mandateStore,
    receipts: receiptStore,
    policyId,
    bearerToken: requiredEnv("TWZRD_COSIGN_TOKEN"),
    publicKeyPem: signer.publicKeyPem,
  });
  const ledger = createMemorySpendLedger();
  const maxAmountUsd = process.env.TWZRD_MAX_AMOUNT_USD?.trim() || "50";
  const policy: SpendPolicy = { maxAmountUsd, refuseWashFlagged: true };
  const intelMode = parseSellerIntelMode(process.env.TWZRD_SELLER_INTEL);
  const intelligence = createSellerIntelligence({
    mode: intelMode,
    onObservation: (o) => {
      console.error(
        `[twzrd-cosigner] seller-intel ${o.decisionId} payTo=${o.payTo} usd=${o.amountUsd} -> ${o.approved ? "approved" : "refused"} verdict=${o.verdict} score=${o.score ?? "null"} wash=${o.washFlagged ?? "null"} ${o.reason}`,
      );
    },
  });
  const evaluate: EvaluatePaymentFn = async (intent) => {
    const decision = await evaluateIntent(intent, {
      signer,
      ledger,
      policy,
      ...(intelligence ? { intelligence } : {}),
    });
    return { decision: decision.decision, reasonCodes: decision.reasonCodes };
  };

  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  if (rpcUrl) assertMainnetRpc(rpcUrl);
  const resolveOwner = rpcUrl
    ? createRpcResolveOwner({ rpcUrl })
    : createHeliusResolveOwner({ apiKey: requiredEnv("HELIUS_API_KEY") });
  const client = createTurnkeyClient(turnkeyCredentials(organizationId));
  await attestConfiguredGuard(client, organizationId);
  const approver = createTurnkeyApprover({
    organizationId,
    client,
    expectedGuardUsername: expectedGuardUsername(),
  });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  const host = process.env.TWZRD_COSIGN_HOST?.trim() || "127.0.0.1";
  const port = parsePort(process.env.TWZRD_COSIGN_PORT);
  await new Promise<void>((resolveListen, rejectListen) => {
    mandateServer.once("error", rejectListen);
    mandateServer.listen(port, host, () => {
      mandateServer.off("error", rejectListen);
      resolveListen();
    });
  });

  console.error(
    `[twzrd-cosigner] live voter + mandate intake started on ${host}:${port}; non-stable assets fail closed without a programmatic usdRate`,
  );
  console.error(`[twzrd-cosigner] ${describeSellerIntel(intelMode)}`);
  try {
    await runCosignerWorker({
      approver,
      expectedSigner,
      evaluate,
      resolveOwner,
      policyId,
      resolveCosign: (decisionId, activityId) =>
        mandateStore.claim(decisionId, activityId),
      maxPriorityFeeLamports: parseLamportCap(
        process.env.TWZRD_MAX_PRIORITY_FEE_LAMPORTS,
      ),
      intervalMs: parseInterval(process.env.TWZRD_INTERVAL_MS),
      signal: controller.signal,
      onDecision: (activity, decision) => {
        console.error(
          `[twzrd-cosigner] ${activity.id} -> ${decision.action} (${decision.verdict}) ${decision.reasonCodes.join(",")}`,
        );
      },
      onResult: async (activity, decision, stamp) => {
        if (!decision.decisionId || !decision.policyId || decision.action === "ABSTAIN") {
          return;
        }
        await receiptStore.record({
          decisionId: decision.decisionId,
          policyId: decision.policyId,
          activityId: activity.id,
          fingerprint: decision.fingerprint,
          action: decision.action,
          verdict: decision.verdict as "allow" | "deny",
          reasonCodes: decision.reasonCodes,
          stamp,
        });
      },
      onError: (activity, error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[twzrd-cosigner] ${activity.id} error: ${detail}`);
      },
      onPollError: (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[twzrd-cosigner] poll error; retrying: ${detail}`);
      },
    });
  } finally {
    await new Promise<void>((resolveClose) => mandateServer.close(() => resolveClose()));
  }
}

/** Create the isolated 2-of-3 child organization and its Solana wallet. */
export async function runSetup(): Promise<void> {
  if (process.env.TWZRD_ENABLE_TURNKEY_SETUP !== "1") {
    throw new Error("set TWZRD_ENABLE_TURNKEY_SETUP=1 to create a Turnkey child org");
  }
  const parentOrganizationId = requiredEnv(
    "TURNKEY_PARENT_ORGANIZATION_ID",
    "TURNKEY_ORGANIZATION_ID",
  );
  const cfg = turnkeyCredentials(parentOrganizationId);
  const client = createTurnkeyClient(cfg);
  const created = await setupTurnkeyGuard(client, {
    parentOrganizationId,
    payerApiPublicKey: requiredEnv("TURNKEY_PAYER_API_PUBLIC_KEY"),
    twzrdApiPublicKey: requiredEnv("TWZRD_APPROVER_PUBLIC_KEY"),
    recoveryApiPublicKey: requiredEnv("TURNKEY_RECOVERY_API_PUBLIC_KEY"),
  });
  console.log(JSON.stringify(created, null, 2));
}

export async function main(command = process.argv[2]): Promise<void> {
  if (command === "preflight") return runPreflight();
  if (command === "worker") return runWorker();
  if (command === "setup-turnkey") return runSetup();
  throw new Error("usage: twzrd-cosigner <preflight|worker|setup-turnkey>");
}

// 2026-09-02 fix: `resolve()` alone does not follow symlinks, but Node's ESM
// loader resolves symlinks by default (no --preserve-symlinks) when it sets
// import.meta.url for the entry module. When this file runs via an npm/npx
// .bin symlink -- the only way anyone installs this package -- the two sides
// of this comparison were never equal: `resolve(process.argv[1])` stayed the
// symlink path while `import.meta.url` was the real, resolved path. main()
// silently never ran; the CLI exited 0 with no output on every real install.
// realpathSync() resolves the symlink so both sides compare the same path.
// Wrapped: this file's header promises "no command runs merely by importing
// this module," so a future caller importing it with an unresolvable
// argv[1] (a bundler's virtual FS, a faked entry point) must fall through to
// "not the entry module," not throw ENOENT/ELOOP out of a top-level guard.
let invokedPath: string | undefined;
try {
  invokedPath = process.argv[1]
    ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href
    : undefined;
} catch {
  invokedPath = undefined;
}
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
