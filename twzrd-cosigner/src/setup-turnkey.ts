/**
 * Create the isolated Turnkey topology: customer hot, TWZRD veto, and
 * customer recovery as the three child root users, with root threshold 2.
 * Normal spend is hot + TWZRD. Break-glass is hot + recovery. TWZRD cannot
 * move funds alone. This module only enrolls the topology; it never signs.
 *
 * Recovery credentials must never be available to the agent runtime.
 */
import type { TurnkeyApiClient } from "@turnkey/sdk-server";

type CreateSubOrganizationInput = Parameters<
  TurnkeyApiClient["createSubOrganization"]
>[0];
type CreateSubOrganizationResponse = Awaited<
  ReturnType<TurnkeyApiClient["createSubOrganization"]>
>;

/**
 * Narrow, SDK-derived enrollment port. The reduced response keeps offline
 * tests small while remaining structurally compatible with TurnkeyApiClient.
 */
export type TurnkeyAdminClient = {
  createSubOrganization(
    input: CreateSubOrganizationInput,
  ): Promise<
    {
      subOrganizationId?: CreateSubOrganizationResponse["subOrganizationId"];
      rootUserIds?: CreateSubOrganizationResponse["rootUserIds"];
      wallet?: CreateSubOrganizationResponse["wallet"];
      activity: Pick<
        CreateSubOrganizationResponse["activity"],
        "id" | "status"
      >;
    }
  >;
};

export const HOT_USERNAME = "payer";
export const GUARD_USERNAME = "twzrd-guard";
export const RECOVERY_USERNAME = "payer-recovery";

export type SetupTurnkeyGuardOptions = {
  parentOrganizationId?: string;
  payerApiPublicKey: string;
  twzrdApiPublicKey: string;
  recoveryApiPublicKey: string;
  subOrganizationName?: string;
  walletName?: string;
};

export type SetupTurnkeyGuardResult = {
  subOrganizationId: string;
  rootUserIds: string[];
  walletId: string;
  walletAddress: string;
  rootQuorumThreshold: 2;
};

const SOLANA_ACCOUNT = {
  curve: "CURVE_ED25519",
  pathFormat: "PATH_FORMAT_BIP32",
  path: "m/44'/501'/0'/0'",
  addressFormat: "ADDRESS_FORMAT_SOLANA",
} as const;

function requirePublicKey(name: string, value: string): string {
  const key = value.trim().toLowerCase();
  if (!/^(02|03)[0-9a-f]{64}$/.test(key)) {
    throw new Error(`${name} must be a compressed P-256 public key in hex`);
  }
  return key;
}

/** Build the exact SDK request without making a Turnkey API call. */
export function buildTurnkeyGuardSubOrganization(
  opts: SetupTurnkeyGuardOptions,
): CreateSubOrganizationInput {
  const payerApiPublicKey = requirePublicKey(
    "payerApiPublicKey",
    opts.payerApiPublicKey,
  );
  const twzrdApiPublicKey = requirePublicKey(
    "twzrdApiPublicKey",
    opts.twzrdApiPublicKey,
  );
  const recoveryApiPublicKey = requirePublicKey(
    "recoveryApiPublicKey",
    opts.recoveryApiPublicKey,
  );
  if (
    new Set([payerApiPublicKey, twzrdApiPublicKey, recoveryApiPublicKey])
      .size !== 3
  ) {
    throw new Error(
      "payer, TWZRD guard, and recovery require independent API keys",
    );
  }

  return {
    ...(opts.parentOrganizationId
      ? { organizationId: opts.parentOrganizationId }
      : {}),
    subOrganizationName: opts.subOrganizationName ?? "TWZRD guarded payer",
    rootUsers: [
      {
        userName: HOT_USERNAME,
        apiKeys: [
          {
            apiKeyName: "payer-key",
            publicKey: payerApiPublicKey,
            curveType: "API_KEY_CURVE_P256",
          },
        ],
        authenticators: [],
        oauthProviders: [],
      },
      {
        userName: GUARD_USERNAME,
        apiKeys: [
          {
            apiKeyName: "twzrd-guard-key",
            publicKey: twzrdApiPublicKey,
            curveType: "API_KEY_CURVE_P256",
          },
        ],
        authenticators: [],
        oauthProviders: [],
      },
      {
        userName: RECOVERY_USERNAME,
        apiKeys: [
          {
            apiKeyName: "payer-recovery-key",
            publicKey: recoveryApiPublicKey,
            curveType: "API_KEY_CURVE_P256",
          },
        ],
        authenticators: [],
        oauthProviders: [],
      },
    ],
    rootQuorumThreshold: 2,
    wallet: {
      walletName: opts.walletName ?? "TWZRD guarded Solana wallet",
      accounts: [SOLANA_ACCOUNT],
    },
    disableEmailRecovery: true,
    disableEmailAuth: true,
    disableSmsAuth: true,
    disableOtpEmailAuth: true,
  };
}

/** Create a fresh child organization and guarded Solana wallet atomically. */
export async function setupTurnkeyGuard(
  client: TurnkeyAdminClient,
  opts: SetupTurnkeyGuardOptions,
): Promise<SetupTurnkeyGuardResult> {
  const created = await client.createSubOrganization(
    buildTurnkeyGuardSubOrganization(opts),
  );
  const activityDetail = `${created.activity.id} (${created.activity.status})`;

  if (!created.subOrganizationId) {
    throw new Error(
      `Turnkey activity ${activityDetail} did not return a sub-organization ID; parent approval may still be pending`,
    );
  }
  if (
    created.rootUserIds?.length !== 3 ||
    new Set(created.rootUserIds).size !== 3
  ) {
    throw new Error(
      `Turnkey activity ${activityDetail} did not return three distinct child root users`,
    );
  }
  const walletAddress = created.wallet?.addresses[0];
  if (!created.wallet?.walletId || !walletAddress) {
    throw new Error(
      `Turnkey activity ${activityDetail} did not return the guarded Solana wallet`,
    );
  }

  return {
    subOrganizationId: created.subOrganizationId,
    rootUserIds: created.rootUserIds,
    walletId: created.wallet.walletId,
    walletAddress,
    rootQuorumThreshold: 2,
  };
}
