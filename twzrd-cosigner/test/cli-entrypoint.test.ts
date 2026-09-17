/**
 * Regression for the npm/npx .bin symlink bug fixed in ../src/cli.ts
 * (see the comment there for the root cause). Spawns the actual built
 * dist/cli.js both directly and through a real symlink, mirroring exactly
 * how npm/npx invoke a package's bin entry.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SPAWN_TIMEOUT_MS = 10_000;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");

if (!existsSync(CLI)) {
  console.log("skip  cli-entrypoint.test.ts: dist/cli.js not built (run `npm run build` first)");
  process.exit(0);
}

const direct = spawnSync("node", [CLI], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
assert.match(
  direct.stderr,
  /usage: twzrd-cosigner/,
  "direct `node dist/cli.js` must run main() and print usage",
);
console.log("ok  direct invocation runs main()");

const scratch = mkdtempSync(join(tmpdir(), "twzrd-cosigner-bin-"));
try {
  const binLink = join(scratch, "twzrd-cosigner");
  symlinkSync(CLI, binLink);

  const viaSymlink = spawnSync("node", [binLink], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  assert.match(
    viaSymlink.stderr,
    /usage: twzrd-cosigner/,
    "invocation through an npm/npx-style .bin symlink must ALSO run main(), " +
      "not silently exit 0 with no output",
  );
  console.log("ok  symlinked invocation (the real npm/npx path) runs main()");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("cli-entrypoint.test.ts: all passed");
