/**
 * Turnkey enrollment tests. Isolated child org: payer hot, TWZRD veto,
 * payer-recovery cold; root threshold 2. No live API calls or keys.
 */
import assert from "node:assert/strict";

import {
  setupTurnkeyGuard,
  type TurnkeyAdminClient,
} from "../src/setup-turnkey.js";

const PAYER_KEY = `02${"11".repeat(32)}`;
const GUARD_KEY = `02${"22".repeat(32)}`;
const RECOVERY_KEY = `02${"33".repeat(32)}`;

/* Creates the proven two-party child quorum atomically with its Solana wallet. */
{
  let submitted: unknown;
  const client: TurnkeyAdminClient = {
    async createSubOrganization(input) {
      submitted = input;
      return {
        activity: {
          id: "create-sub-org-activity",
          status: "ACTIVITY_STATUS_COMPLETED",
        },
        subOrganizationId: "sub-org-123",
        rootUserIds: ["payer-user", "guard-user", "recovery-user"],
        wallet: { walletId: "wallet-123", addresses: ["GuardedSolanaAddress"] },
      };
    },
  };

  const result = await setupTurnkeyGuard(client, {
    parentOrganizationId: "parent-org",
    payerApiPublicKey: PAYER_KEY,
    twzrdApiPublicKey: GUARD_KEY,
    recoveryApiPublicKey: RECOVERY_KEY,
  });

  assert.deepEqual(submitted, {
    organizationId: "parent-org",
    subOrganizationName: "TWZRD guarded payer",
    rootUsers: [
      {
        userName: "payer",
        apiKeys: [
          {
            apiKeyName: "payer-key",
            publicKey: PAYER_KEY,
            curveType: "API_KEY_CURVE_P256",
          },
        ],
        authenticators: [],
        oauthProviders: [],
      },
      {
        userName: "twzrd-guard",
        apiKeys: [
          {
            apiKeyName: "twzrd-guard-key",
            publicKey: GUARD_KEY,
            curveType: "API_KEY_CURVE_P256",
          },
        ],
        authenticators: [],
        oauthProviders: [],
      },
      {
        userName: "payer-recovery",
        apiKeys: [
          {
            apiKeyName: "payer-recovery-key",
            publicKey: RECOVERY_KEY,
            curveType: "API_KEY_CURVE_P256",
          },
        ],
        authenticators: [],
        oauthProviders: [],
      },
    ],
    rootQuorumThreshold: 2,
    wallet: {
      walletName: "TWZRD guarded Solana wallet",
      accounts: [
        {
          curve: "CURVE_ED25519",
          pathFormat: "PATH_FORMAT_BIP32",
          path: "m/44'/501'/0'/0'",
          addressFormat: "ADDRESS_FORMAT_SOLANA",
        },
      ],
    },
    disableEmailRecovery: true,
    disableEmailAuth: true,
    disableSmsAuth: true,
    disableOtpEmailAuth: true,
  });
  assert.deepEqual(result, {
    subOrganizationId: "sub-org-123",
    rootUserIds: ["payer-user", "guard-user", "recovery-user"],
    walletId: "wallet-123",
    walletAddress: "GuardedSolanaAddress",
    rootQuorumThreshold: 2,
  });
  console.log("ok  setup creates isolated 2-of-3 hot + veto + recovery child quorum");
}

/* All three independent public keys are required before any mutation. */
{
  const client: TurnkeyAdminClient = {
    async createSubOrganization() {
      throw new Error("must not be called");
    },
  };
  await assert.rejects(
    () =>
      setupTurnkeyGuard(client, {
        payerApiPublicKey: "",
        twzrdApiPublicKey: GUARD_KEY,
        recoveryApiPublicKey: RECOVERY_KEY,
      }),
    /payerApiPublicKey/,
  );
  await assert.rejects(
    () =>
      setupTurnkeyGuard(client, {
        payerApiPublicKey: PAYER_KEY,
        twzrdApiPublicKey: "",
        recoveryApiPublicKey: RECOVERY_KEY,
      }),
    /twzrdApiPublicKey/,
  );
  await assert.rejects(
    () =>
      setupTurnkeyGuard(client, {
        payerApiPublicKey: PAYER_KEY,
        twzrdApiPublicKey: GUARD_KEY,
        recoveryApiPublicKey: "",
      }),
    /recoveryApiPublicKey/,
  );
  console.log("ok  setup rejects missing payer, guard, or recovery key before mutation");
}

/* Never accept the same credential on any two quorum members. */
{
  const client: TurnkeyAdminClient = {
    async createSubOrganization() {
      throw new Error("must not be called");
    },
  };
  await assert.rejects(
    () =>
      setupTurnkeyGuard(client, {
        payerApiPublicKey: PAYER_KEY,
        twzrdApiPublicKey: PAYER_KEY,
        recoveryApiPublicKey: RECOVERY_KEY,
      }),
    /independent/,
  );
  await assert.rejects(
    () =>
      setupTurnkeyGuard(client, {
        payerApiPublicKey: PAYER_KEY,
        twzrdApiPublicKey: GUARD_KEY,
        recoveryApiPublicKey: PAYER_KEY,
      }),
    /independent/,
  );
  console.log("ok  setup rejects a shared payer/guard/recovery credential");
}

/* Public keys are compressed P-256 hex and equality is case-insensitive. */
{
  const mixedCaseKey = `03${"ab".repeat(32)}`;
  const client: TurnkeyAdminClient = {
    async createSubOrganization() {
      throw new Error("must not be called");
    },
  };
  await assert.rejects(
    () =>
      setupTurnkeyGuard(client, {
        payerApiPublicKey: mixedCaseKey,
        twzrdApiPublicKey: mixedCaseKey.toUpperCase(),
        recoveryApiPublicKey: RECOVERY_KEY,
      }),
    /independent/,
  );
  await assert.rejects(
    () =>
      setupTurnkeyGuard(client, {
        payerApiPublicKey: "not-a-p256-key",
        twzrdApiPublicKey: GUARD_KEY,
        recoveryApiPublicKey: RECOVERY_KEY,
      }),
    /compressed P-256/,
  );
  console.log("ok  setup validates and normalizes compressed P-256 keys");
}

/* A completed response must contain three distinct child root IDs. */
{
  const client: TurnkeyAdminClient = {
    async createSubOrganization() {
      return {
        activity: {
          id: "create-sub-org-activity",
          status: "ACTIVITY_STATUS_COMPLETED",
        },
        subOrganizationId: "sub-org-123",
        rootUserIds: ["same-user", "same-user", "other-user"],
        wallet: { walletId: "wallet-123", addresses: ["GuardedSolanaAddress"] },
      };
    },
  };
  await assert.rejects(
    () =>
      setupTurnkeyGuard(client, {
        payerApiPublicKey: PAYER_KEY,
        twzrdApiPublicKey: GUARD_KEY,
        recoveryApiPublicKey: RECOVERY_KEY,
      }),
    /three distinct child root users/,
  );
  console.log("ok  setup rejects duplicate returned child root IDs");
}

/* A parent-quorum response is surfaced as pending with its activity identity. */
{
  const client: TurnkeyAdminClient = {
    async createSubOrganization() {
      return {
        activity: {
          id: "pending-parent-approval",
          status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
        },
      };
    },
  };
  await assert.rejects(
    () =>
      setupTurnkeyGuard(client, {
        payerApiPublicKey: PAYER_KEY,
        twzrdApiPublicKey: GUARD_KEY,
        recoveryApiPublicKey: RECOVERY_KEY,
      }),
    /pending-parent-approval.*CONSENSUS_NEEDED.*pending/,
  );
  console.log("ok  setup surfaces a pending parent-quorum activity");
}

console.log("setup-turnkey.test.ts: all passed");
