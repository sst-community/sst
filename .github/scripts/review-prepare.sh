#!/usr/bin/env bash
# Collects a pull request for the automatic review and runs the checks that
# don't need a model: the risk label, the title, generated docs, versions, and
# whether the description says how the change was tested.
#
# Needs GH_TOKEN, GH_REPO, PR and OUT. Writes, in $OUT:
#   pr.md        title, description, files and check results, for the model
#   pr.diff      the change, cut at 100 KB
#   checks.md    the check results, for the comment
#   risk         low, medium or high
#   risk.md      why, for the comment
#   failed       how many checks failed
#   upstream.md  each SST pull request the description links, and its state
set -euo pipefail

mkdir -p "$OUT"
pr=$(gh api "repos/$GH_REPO/pulls/$PR")
title=$(jq -r .title <<<"$pr")
body=$(jq -r '.body // ""' <<<"$pr")
author=$(jq -r .user.login <<<"$pr")
files=$(gh api --paginate "repos/$GH_REPO/pulls/$PR/files")

# The diff, from each file's patch. GitHub leaves out the patch of a binary or
# very large file.
jq -r '.[] | "diff --git a/\(.previous_filename // .filename) b/\(.filename)\n\(.patch // "(no diff shown: binary or too large)")"' <<<"$files" >"$OUT/pr.full.diff"
head -c 100000 "$OUT/pr.full.diff" >"$OUT/pr.diff"
if [ "$(wc -c <"$OUT/pr.full.diff")" -gt 100000 ]; then
  printf '\n\n(The diff is cut here: it is over 100 KB.)\n' >>"$OUT/pr.diff"
fi
jq -r '.[].filename' <<<"$files" >"$OUT/files"

# Risk, from the paths: low for docs, medium for components and tests, high for
# the CLI, shared platform code, release and install files, dependencies and
# workflows. A pull request gets the highest of its files.
risk_of() {
  case "$1" in
    .github/*) echo high ;;
    examples/*) echo low ;;
    *package.json | *go.mod | *go.sum | *bun.lock | *bun.lockb | *package-lock.json | *pnpm-lock.yaml | *yarn.lock) echo high ;;
    *_test.go | *.test.ts | platform/test/*) echo medium ;;
    cmd/* | pkg/* | internal/*) echo high ;;
    platform/src/components/component.ts) echo high ;;
    platform/src/components/*) echo medium ;;
    platform/src/* | platform/functions/* | platform/support/* | platform/scripts/*) echo high ;;
    .goreleaser.yml | install | sdk/js/scripts/* | sdk/js/bin/*) echo high ;;
    sdk/*) echo medium ;;
    www/* | *.md | *.mdx | docs/*) echo low ;;
    *) echo medium ;;
  esac
}
rank() { case "$1" in high) echo 3 ;; medium) echo 2 ;; *) echo 1 ;; esac; }
risk=low
why=""
code=false
while IFS= read -r f; do
  r=$(risk_of "$f")
  if [ "$(rank "$r")" -gt "$(rank "$risk")" ]; then
    risk=$r
    why=$f
  fi
  case "$f" in
    examples/* | www/* | *.md | *.mdx | docs/* | *_test.go | *.test.ts | platform/test/*) ;;
    *) code=true ;;
  esac
done <"$OUT/files"
echo "$risk" >"$OUT/risk"
if [ -n "$why" ]; then
  echo "\`$why\`" >"$OUT/risk.md"
else
  echo "docs, Markdown and examples only" >"$OUT/risk.md"
fi

# A pull request that carries a fix from SST links its pull request there.
# Once SST merges it, the fix arrives with SST's next release, so the fork's
# copy may not be needed.
: >"$OUT/upstream.md"
for n in $(grep -Eo 'github\.com/anomalyco/sst/pull/[0-9]+' <<<"$body" | grep -Eo '[0-9]+$' | awk '!seen[$0]++' | head -n 5); do
  state=$(gh api "repos/anomalyco/sst/pulls/$n" \
    --jq 'if .merged_at then "🟣 merged on \(.merged_at[0:10]): it comes with the SST release that has it" elif .state == "closed" then "⚪ closed without merging" else "🟢 open" end' 2>/dev/null) || continue
  echo "[anomalyco/sst#$n](https://github.com/anomalyco/sst/pull/$n) $state" >>"$OUT/upstream.md"
done

failed=0
: >"$OUT/checks.md"
pass() { echo "- ✅ $1" >>"$OUT/checks.md"; }
fail() {
  echo "- ❌ $1" >>"$OUT/checks.md"
  failed=$((failed + 1))
}

# The title: the area, a colon, then what the change does.
if grep -Eq '^(feat|fix|chore|docs|refactor|test|tests|ci|build|perf|style|revert)(\([^)]*\))?!?:' <<<"$title"; then
  fail "**Title:** drop the conventional-commit prefix. Use the area, a colon, then what the change does, like \`Function: retain the shared dev bridge code object on delete\`."
elif ! grep -Eq '^[^: ][^:]*: [^ ]' <<<"$title"; then
  fail "**Title:** use the area, a colon, then what the change does, like \`Function: retain the shared dev bridge code object on delete\`."
elif grep -Eq '\.$' <<<"$title"; then
  fail "**Title:** drop the period at the end."
elif grep -Eq '#[0-9]+' <<<"$title"; then
  fail "**Title:** leave out the issue or pull request number. Link it in the description."
else
  pass "**Title** has the area and what the change does."
fi

# Generated docs: the reference pages come from doc comments.
generated=$(grep -E '^www/src/content/docs/docs/(component|reference)/' "$OUT/files" | grep -v '^www/src/content/docs/docs/reference/sdk.mdx$' || true)
if [ -n "$generated" ]; then
  fail "**Generated docs:** $(echo "$generated" | sed 's/.*/`&`/' | paste -sd, - | sed 's/,/, /g') are generated from the doc comments in \`platform/src\` and \`cmd/sst\`. Change the comment instead."
else
  pass "**Generated docs** aren't edited."
fi

# Versions: maintainers set them when they release.
versions=$(jq -r '.[] | select(.filename | test("(^|/)package\\.json$")) | select(.filename | startswith("examples/") | not) | select((.patch // "") | test("(?m)^[+-]\\s*\"version\":")) | .filename' <<<"$files")
if [ -n "$versions" ]; then
  fail "**Versions:** leave the \`version\` in $(echo "$versions" | sed 's/.*/`&`/' | paste -sd, - | sed 's/,/, /g') alone. Maintainers set it when they release."
else
  pass "**Versions** aren't changed."
fi

# Testing: a change to code says what was run.
if [ "$code" = true ]; then
  tested=$(awk 'tolower($0) ~ /^#+[[:space:]]*how it was tested/ {on=1; next} /^#/ {on=0} on' <<<"$body" |
    perl -0pe 's/<!--.*?-->//gs' | tr -d '[:space:]')
  if [ -z "$tested" ] && ! grep -Eiq 'test|ran |deploy|tried|verified' <<<"$body"; then
    fail "**Testing:** say in the description what you ran to check this change, such as an example app deployed, \`sst dev\`, or the tests."
  elif [ -z "$tested" ] && grep -Eiq '^#+[[:space:]]*How it was tested' <<<"$body"; then
    fail "**Testing:** fill in \"How it was tested\" in the description: what you ran to check this change."
  else
    pass "**Testing:** the description says how it was tested."
  fi
fi
echo "$failed" >"$OUT/failed"

{
  echo "# $title"
  echo
  echo "Author: $author"
  echo
  echo "## Description"
  echo
  echo "${body:-(empty)}"
  echo
  echo "## Changed files"
  echo
  jq -r '.[] | "- \(.status): \(.filename) (+\(.additions) -\(.deletions))"' <<<"$files"
  echo
  echo "## Automatic checks (already reported; don't repeat them)"
  echo
  cat "$OUT/checks.md"
} >"$OUT/pr.md"
