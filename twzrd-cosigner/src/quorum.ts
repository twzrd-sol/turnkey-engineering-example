/** Read-only attestation for the supported Turnkey guard topology. */
import type { TurnkeyApiClient } from "@turnkey/sdk-server";

import {
  GUARD_USERNAME,
  HOT_USERNAME,
  RECOVERY_USERNAME,
} from "./setup-turnkey.js";

type WhoamiInput = Parameters<TurnkeyApiClient["getWhoami"]>[0];
type WhoamiResponse = Awaited<ReturnType<TurnkeyApiClient["getWhoami"]>>;
type ConfigInput = Parameters<TurnkeyApiClient["getOrganizationConfigs"]>[0];
type ConfigResponse = Awaited<
  ReturnType<TurnkeyApiClient["getOrganizationConfigs"]>
>;
type UsersInput = Parameters<TurnkeyApiClient["getUsers"]>[0];
type UsersResponse = Awaited<ReturnType<TurnkeyApiClient["getUsers"]>>;
type RootQuorum = NonNullable<ConfigResponse["configs"]["quorum"]>;

export type TurnkeyQuorumClient = {
  getWhoami(
    input: WhoamiInput,
  ): Promise<Pick<WhoamiResponse, "organizationId" | "userId" | "username">>;
  getOrganizationConfigs(
    input: ConfigInput,
  ): Promise<{ configs: { quorum?: RootQuorum } }>;
  getUsers(
    input: UsersInput,
  ): Promise<{ users: Array<Pick<UsersResponse["users"][number], "userId" | "userName">> }>;
};

export type GuardQuorumAttestation = {
  organizationId: string;
  guardUserId: string;
  guardUsername: string;
  hotUserId: string;
  recoveryUserId: string;
  rootQuorumThreshold: 2;
  rootQuorumUserIds: string[];
};

export type QuorumUser = { userId: string; userName: string };

/** Pure fail-closed validation of hot + veto + recovery at threshold 2. */
export function assertGuardQuorum(
  organizationId: string,
  guard: { userId: string; username: string },
  quorum: { threshold: number; userIds: string[] } | undefined,
  users: QuorumUser[],
  expectedGuardUsername = GUARD_USERNAME,
): GuardQuorumAttestation {
  if (guard.username !== expectedGuardUsername) {
    throw new Error(
      `expected guard username ${expectedGuardUsername}; authenticated as ${guard.username}`,
    );
  }
  if (quorum?.threshold !== 2) {
    throw new Error(
      `expected root quorum threshold 2 for ${organizationId}; got ${quorum?.threshold ?? "missing"}`,
    );
  }
  if (quorum.userIds.length !== 3 || new Set(quorum.userIds).size !== 3) {
    throw new Error(
      `expected three distinct root quorum members for ${organizationId}`,
    );
  }
  if (!quorum.userIds.includes(guard.userId)) {
    throw new Error(
      `guard credential is not a root quorum member for ${organizationId}`,
    );
  }
  const nameById = new Map(users.map((user) => [user.userId, user.userName]));
  const names = quorum.userIds.map((id) => {
    const name = nameById.get(id);
    if (!name) {
      throw new Error(
        `root quorum member ${id} is missing from the organization user list`,
      );
    }
    return name;
  });
  if (new Set(names).size !== 3) {
    throw new Error(
      `expected three distinct root quorum identities for ${organizationId}`,
    );
  }
  if (!names.includes(HOT_USERNAME)) {
    throw new Error(`missing customer hot user ${HOT_USERNAME}`);
  }
  if (!names.includes(expectedGuardUsername)) {
    throw new Error(`missing TWZRD veto user ${expectedGuardUsername}`);
  }
  if (!names.includes(RECOVERY_USERNAME)) {
    throw new Error(`missing customer recovery user ${RECOVERY_USERNAME}`);
  }
  const idByName = new Map(
    quorum.userIds.map((id, i) => [names[i], id] as const),
  );
  return {
    organizationId,
    guardUserId: guard.userId,
    guardUsername: guard.username,
    hotUserId: idByName.get(HOT_USERNAME) as string,
    recoveryUserId: idByName.get(RECOVERY_USERNAME) as string,
    rootQuorumThreshold: 2,
    rootQuorumUserIds: [...quorum.userIds],
  };
}

/** Read Turnkey identity/config/users and attest hot + veto + recovery. */
export async function attestTurnkeyGuard(
  client: TurnkeyQuorumClient,
  organizationId: string,
  expectedGuardUsername = GUARD_USERNAME,
): Promise<GuardQuorumAttestation> {
  const [who, config, listed] = await Promise.all([
    client.getWhoami({ organizationId }),
    client.getOrganizationConfigs({ organizationId }),
    client.getUsers({ organizationId }),
  ]);
  if (who.organizationId !== organizationId) {
    throw new Error(
      `Turnkey authenticated organization ${who.organizationId} does not match ${organizationId}`,
    );
  }
  return assertGuardQuorum(
    organizationId,
    { userId: who.userId, username: who.username },
    config.configs.quorum,
    listed.users,
    expectedGuardUsername,
  );
}
