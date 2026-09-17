/**
 * Prints the exact child-org request used by setupTurnkeyGuard. No API calls.
 *
 *   TURNKEY_PAYER_API_PUBLIC_KEY=... TWZRD_APPROVER_PUBLIC_KEY=... \
 *   TURNKEY_RECOVERY_API_PUBLIC_KEY=... npm run setup-print
 */
import { buildTurnkeyGuardSubOrganization } from "../src/setup-turnkey.js";

// Set only by `npm run pilot-smoke` (package.json) and the CI step of the
// same name (.github/workflows/ci.yml). That path must exit 0 with no real
// Turnkey credentials -- it is a toolchain/CI-parity check, not enrollment --
// so missing keys are substituted with well-known placeholders below instead
// of failing. Every substitution is called out on stderr so a pilot-smoke
// pass never reads as proof of a real topology. `npm run setup-print` run
// directly (the operator's on-the-call check) never sets this flag and keeps
// failing hard on missing config via the throw a few lines down.
const PILOT_SMOKE_OFFLINE = process.env.TWZRD_PILOT_SMOKE_OFFLINE === "1";
const OFFLINE_PLACEHOLDERS: Record<string, string> = {
  TURNKEY_PAYER_API_PUBLIC_KEY:
    "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  TWZRD_APPROVER_PUBLIC_KEY:
    "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  TURNKEY_RECOVERY_API_PUBLIC_KEY:
    "02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
};

const placeholdersUsed: string[] = [];
function resolveKey(argv: string | undefined, envName: string): string | undefined {
  const provided = argv ?? process.env[envName];
  if (provided) return provided;
  if (!PILOT_SMOKE_OFFLINE) return undefined;
  placeholdersUsed.push(envName);
  return OFFLINE_PLACEHOLDERS[envName];
}

const payerKey = resolveKey(process.argv[2], "TURNKEY_PAYER_API_PUBLIC_KEY");
const guardKey = resolveKey(process.argv[3], "TWZRD_APPROVER_PUBLIC_KEY");
const recoveryKey = resolveKey(process.argv[4], "TURNKEY_RECOVERY_API_PUBLIC_KEY");
if (!payerKey || !guardKey || !recoveryKey) {
  throw new Error(
    "set TURNKEY_PAYER_API_PUBLIC_KEY, TWZRD_APPROVER_PUBLIC_KEY, and TURNKEY_RECOVERY_API_PUBLIC_KEY (compressed P-256 hex)",
  );
}

if (placeholdersUsed.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n*** OFFLINE PILOT-SMOKE -- PLACEHOLDER KEYS, NOT A REAL TOPOLOGY PROOF ***\n" +
      `Substituted dummy P-256 public keys because these were not set: ${placeholdersUsed.join(", ")}.\n` +
      "This only proves the script runs end-to-end offline (CI parity). It does NOT\n" +
      "prove the real enrollment topology -- re-run with real values for that.\n",
  );
}
const request = buildTurnkeyGuardSubOrganization({
  parentOrganizationId:
    process.env.TURNKEY_PARENT_ORGANIZATION_ID ?? "<PARENT_ORGANIZATION_ID>",
  payerApiPublicKey: payerKey,
  twzrdApiPublicKey: guardKey,
  recoveryApiPublicKey: recoveryKey,
});

// eslint-disable-next-line no-console
console.log(`# TWZRD cosigner - Turnkey enrollment request

This creates a fresh child organization. Its three root users are customer hot
(payer), TWZRD veto (twzrd-guard), and customer recovery (payer-recovery).
rootQuorumThreshold=2: normal spend is hot + TWZRD; break-glass is hot +
recovery; TWZRD cannot move funds alone. A policy on an existing root signer
is not equivalent and is intentionally not emitted.

The recovery private key must never be available to the agent runtime (paper,
HSM, or a person's safe). Do not commit any private key.

Request body for createSubOrganization:

${JSON.stringify(request, null, 2)}

Dry-run:
  npm run dry-run

Live mutation requires the explicit TWZRD_ENABLE_TURNKEY_SETUP=1 CLI gate.
`);
