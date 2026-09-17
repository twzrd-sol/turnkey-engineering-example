/** CLI safety invariants. Pure checks only; no environment or network calls. */
import assert from "node:assert/strict";

import { assertGuardQuorum } from "../src/quorum.js";

const USERS = [
  { userId: "payer-user", userName: "payer" },
  { userId: "guard-user", userName: "twzrd-guard" },
  { userId: "recovery-user", userName: "payer-recovery" },
];
const IDS = ["payer-user", "guard-user", "recovery-user"] as const;

assert.deepEqual(
  assertGuardQuorum(
    "child-org",
    { userId: "guard-user", username: "twzrd-guard" },
    { threshold: 2, userIds: [...IDS] },
    USERS,
  ),
  {
    organizationId: "child-org",
    guardUserId: "guard-user",
    guardUsername: "twzrd-guard",
    hotUserId: "payer-user",
    recoveryUserId: "recovery-user",
    rootQuorumThreshold: 2,
    rootQuorumUserIds: [...IDS],
  },
);
console.log("ok  CLI accepts guard membership in an exact 2-of-3 hot/veto/cold quorum");

assert.throws(
  () =>
    assertGuardQuorum(
      "child-org",
      { userId: "guard-user", username: "twzrd-guard" },
      { threshold: 1, userIds: [...IDS] },
      USERS,
    ),
  /expected root quorum threshold 2/,
);
assert.throws(
  () =>
    assertGuardQuorum(
      "child-org",
      { userId: "guard-user", username: "twzrd-guard" },
      { threshold: 2, userIds: ["payer-user", "other-user", "recovery-user"] },
      USERS,
    ),
  /guard credential is not a root quorum member/,
);
assert.throws(
  () =>
    assertGuardQuorum(
      "child-org",
      { userId: "guard-user", username: "twzrd-guard" },
      { threshold: 2, userIds: ["guard-user", "guard-user", "recovery-user"] },
      USERS,
    ),
  /three distinct root quorum members/,
);
assert.throws(
  () =>
    assertGuardQuorum(
      "child-org",
      { userId: "payer-user", username: "payer" },
      { threshold: 2, userIds: [...IDS] },
      USERS,
    ),
  /expected guard username twzrd-guard/,
);
assert.throws(
  () =>
    assertGuardQuorum(
      "child-org",
      { userId: "guard-user", username: "twzrd-guard" },
      { threshold: 2, userIds: ["payer-user", "guard-user"] },
      USERS,
    ),
  /three distinct root quorum members/,
);
assert.throws(
  () =>
    assertGuardQuorum(
      "child-org",
      { userId: "guard-user", username: "twzrd-guard" },
      {
        threshold: 2,
        userIds: [...IDS, "fourth-user"],
      },
      [...USERS, { userId: "fourth-user", userName: "other" }],
    ),
  /three distinct root quorum members/,
);
assert.throws(
  () =>
    assertGuardQuorum(
      "child-org",
      { userId: "guard-user", username: "twzrd-guard" },
      { threshold: 2, userIds: [...IDS] },
      USERS.filter((user) => user.userName !== "payer-recovery"),
    ),
  /missing from the organization user list|missing customer recovery/,
);
console.log("ok  CLI rejects threshold drift, missing recovery, or a missing TWZRD member");

console.log("cli.test.ts: all passed");
