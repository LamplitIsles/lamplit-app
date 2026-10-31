import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(
  new URL("../scripts/build-frontend-dagger.sh", import.meta.url),
);
const sha = "a".repeat(40);

test("the shared entry verifies the revision and source before exporting one archive", () => {
  const root = mkdtempSync(join(tmpdir(), "frontend-dagger-entry-"));
  try {
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "dagger"));
    writeFileSync(
      join(root, "bin/git"),
      `#!/bin/sh
case "$1 $2" in
  'rev-parse --show-toplevel') printf '%s\\n' "$FAKE_ROOT" ;;
  'rev-parse HEAD') printf '%s\\n' "$FAKE_SHA" ;;
  'status --porcelain')
    if [ -n "$FAKE_CHANGED" ] && [ -f "$FAKE_ROOT/lamplit-app-$FAKE_SHA.tar.gz" ]; then echo changed; else printf '%s' "$FAKE_DIRTY"; fi ;;
  'ls-files --others') printf '%s' "$FAKE_IGNORED" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(root, "bin/dagger"),
      `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_ROOT/call"
printf '{"revision":"%s"}\\n' "\${FAKE_ARTIFACT_SHA:-$FAKE_SHA}" > "$FAKE_ROOT/manifest.json"
tar -czf "$FAKE_ROOT/lamplit-app-$FAKE_SHA.tar.gz" -C "$FAKE_ROOT" manifest.json
`,
      { mode: 0o755 },
    );
    const env = {
      PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_ROOT: root,
      FAKE_SHA: sha,
      CI_COMMIT_SHA: sha,
      _EXPERIMENTAL_DAGGER_RUNNER_HOST: "tcp://example.invalid:1234",
    };
    const run = (extra = {}) =>
      spawnSync("sh", [entry], {
        cwd: root,
        env: { ...env, ...extra },
        encoding: "utf8",
      });
    assert.notEqual(run({ CI_COMMIT_SHA: "b".repeat(40) }).status, 0);
    assert.notEqual(run({ FAKE_DIRTY: " M file" }).status, 0);
    assert.notEqual(run({ FAKE_IGNORED: "apps/web/secret" }).status, 0);
    assert.equal(run().status, 0);
    assert.deepEqual(
      readFileSync(join(root, "call"), "utf8").trim().split("\n"),
      [
        "call",
        "build",
        "--source=..",
        `--revision=${sha}`,
        "export",
        `--path=../lamplit-app-${sha}.tar.gz`,
      ],
    );
    assert.notEqual(run().status, 0, "existing output must not be overwritten");
    rmSync(join(root, `lamplit-app-${sha}.tar.gz`));
    assert.notEqual(
      run({ FAKE_ARTIFACT_SHA: "b".repeat(40) }).status,
      0,
      "archive revision must match Git HEAD",
    );
    rmSync(join(root, `lamplit-app-${sha}.tar.gz`));
    assert.notEqual(
      run({ FAKE_CHANGED: "1" }).status,
      0,
      "source changes must prevent success",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
