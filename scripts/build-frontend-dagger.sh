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
  apps/web packages/contracts scripts tests docs/licenses \
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
contracts="lamplit-contracts-$revision.tar.gz"
for file in "$archive" "$contracts"; do
  if [ -e "$file" ]; then
    echo "Refusing to overwrite $file" >&2
    exit 1
  fi
done
mkdir -p "$root/.scratch"
output=$(mktemp -d "$root/.scratch/lamplit-build.XXXXXX")
trap 'rm -rf "$output"' EXIT HUP INT TERM
(
  cd dagger
  "$dagger_bin" call build --source=.. --revision="$revision" export --path="$output"
)
after_revision=$(git rev-parse HEAD)
after_status=$(git status --porcelain --untracked-files=all)
if [ "$after_revision" != "$revision" ] || [ -n "$after_status" ]; then
  echo 'Source changed during the build; do not publish the archives' >&2
  exit 1
fi
check_ignored_sources
test -f "$output/$archive"
test -f "$output/$contracts"
node -e '
  const { execFileSync } = require("node:child_process");
  for (const [file, path] of [[process.argv[1], "manifest.json"], [process.argv[2], "package/lamplit-source.json"]]) {
    const manifest = JSON.parse(execFileSync("tar", ["-xOzf", file, path], { encoding: "utf8" }));
    if (manifest.revision !== process.argv[3]) throw new Error("Archive revision does not match Git HEAD");
  }
' "$output/$archive" "$output/$contracts" "$revision"
# Hard links fail if a destination appeared concurrently; never overwrite it.
ln "$output/$archive" "$archive"
ln "$output/$contracts" "$contracts"
sha256sum "$archive" "$contracts"
printf '%s\n' "$root/$archive" "$root/$contracts"
