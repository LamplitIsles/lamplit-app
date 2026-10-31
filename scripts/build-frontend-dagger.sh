#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"
revision=$(git rev-parse HEAD)
case "$revision" in
  *[!0-9a-f]*|'') echo 'Invalid Git revision' >&2; exit 1 ;;
esac
test "${#revision}" -eq 40
if [ -n "${CI_COMMIT_SHA:-}" ] && [ "$revision" != "$CI_COMMIT_SHA" ]; then
  echo 'Git HEAD does not match CI_COMMIT_SHA' >&2
  exit 1
fi
status=$(git status --porcelain --untracked-files=all)
if [ -n "$status" ]; then
  echo 'Build requires a clean working tree' >&2
  exit 1
fi
# Dagger does not apply .gitignore to its Directory argument. Refuse any
# additional ignored files in projected directories, apart from paths the
# module explicitly excludes.
check_ignored_sources() {
  ignored_sources=$(git ls-files --others --ignored --exclude-standard -- \
  apps/web packages/contracts docs/licenses \
  ':(exclude)**/node_modules/**' ':(exclude)**/build/**' \
  ':(exclude)**/dist/**' ':(exclude)apps/web/src/lib/paraglide/**' \
  ':(exclude)apps/web/project.inlang/**')
  if [ -n "$ignored_sources" ]; then
    echo 'Unexpected ignored files in projected source directories' >&2
    exit 1
  fi
}
check_ignored_sources
: "${_EXPERIMENTAL_DAGGER_RUNNER_HOST:?Set an approved existing Dagger engine connection}"
dagger_bin=${DAGGER_BIN:-dagger}
archive="lamplit-app-$revision.tar.gz"
if [ -e "$archive" ]; then
  echo "Refusing to overwrite $archive" >&2
  exit 1
fi
(
  cd dagger
  "$dagger_bin" call build --source=.. --revision="$revision" export --path="../$archive"
)
after_revision=$(git rev-parse HEAD)
after_status=$(git status --porcelain --untracked-files=all -- . ":(exclude)$archive")
if [ "$after_revision" != "$revision" ] || [ -n "$after_status" ]; then
  echo 'Source changed during the build; do not publish the archive' >&2
  exit 1
fi
check_ignored_sources
test -f "$archive"
node -e '
  const { execFileSync } = require("node:child_process");
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", process.argv[1], "manifest.json"], { encoding: "utf8" }));
  if (manifest.revision !== process.argv[2]) throw new Error("Archive revision does not match Git HEAD");
' "$archive" "$revision"
printf '%s\n' "$root/$archive"
