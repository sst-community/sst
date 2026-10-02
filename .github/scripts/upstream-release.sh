#!/usr/bin/env bash
# Finds the newest SST release that isn't merged into the fork, and writes an
# issue body saying what merging it involves. It reads the repo and changes
# nothing in it. Used by .github/workflows/upstream.yml.
#
# To try it in a full clone, pretending main is at an older upstream release:
#
#   BASE=upstream/v4.17.0 .github/scripts/upstream-release.sh && cat upstream-release.md
#
# BASE       what to compare against (default HEAD)
# BODY_FILE  where the issue body goes (default upstream-release.md)
#
# Prints `tag=` and `title=` lines, also to $GITHUB_OUTPUT when it's set. `tag`
# is empty when there's nothing to merge.
set -euo pipefail

UPSTREAM="anomalyco/sst"
BASE="${BASE:-HEAD}"
BODY_FILE="${BODY_FILE:-upstream-release.md}"

output() {
  echo "$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1" >> "$GITHUB_OUTPUT"; fi
}

# Upstream's tags are kept under upstream/, as in a maintainer's clone: plain
# v* tags are the fork's own releases.
git fetch --quiet --no-tags "https://github.com/$UPSTREAM.git" '+refs/tags/v*:refs/tags/upstream/v*'

# Releases only, no pre-releases.
releases() {
  git tag --list 'upstream/v*' --sort=version:refname "$@" \
    | grep -E '^upstream/v[0-9]+\.[0-9]+\.[0-9]+$' || true
}

latest=$(releases | tail -n 1)
if [ -z "$latest" ]; then
  echo "No upstream release tags found." >&2
  exit 1
fi

if git merge-base --is-ancestor "$latest" "$BASE"; then
  echo "Up to date: SST ${latest#upstream/} is merged."
  output "tag="
  exit 0
fi

tag="${latest#upstream/}"
version="${tag#v}"

# Every release after the newest one that is merged.
merged=$(releases --merged "$BASE" | tail -n 1)
if [ -n "$merged" ]; then
  unmerged=$(releases | awk -v merged="$merged" 'found { print } $0 == merged { found = 1 }')
else
  unmerged=$(releases)
fi

commits=$(git rev-list --count "$BASE..$latest")

# A merge in memory: nothing is checked out or committed.
status=0
merge=$(git merge-tree --write-tree --name-only --no-messages "$BASE" "$latest") || status=$?
case "$status" in
  0) conflicts="" ;;
  1) conflicts=$(printf '%s\n' "$merge" | tail -n +2) ;;
  *) echo "git merge-tree failed." >&2; exit "$status" ;;
esac

# The fork's version: the next free patch number in upstream's major.minor line.
IFS=. read -r major minor patch <<< "$version"
last=$(git tag --list "v$major.$minor.*" \
  | grep -E "^v$major\.$minor\.[0-9]+$" \
  | sed "s/^v$major\.$minor\.//" | sort -n | tail -n 1 || true)
if [ -n "$last" ] && [ "$last" -ge "$patch" ]; then patch=$((last + 1)); fi
next="v$major.$minor.$patch"

{
  echo "SST released [$tag](https://github.com/$UPSTREAM/releases/tag/$tag), and it isn't merged into \`main\` yet."
  echo
  echo "- **Releases to merge:** $(echo "$unmerged" | sed "s|^upstream/\(.*\)$|[\1](https://github.com/$UPSTREAM/releases/tag/\1)|" | paste -sd, - | sed 's/,/, /g')"
  echo "- **Commits:** $commits"
  if [ -z "$conflicts" ]; then
    echo "- **Conflicts:** none. It merges cleanly."
  else
    count=$(echo "$conflicts" | wc -l | tr -d ' ')
    if [ "$count" = 1 ]; then files="1 file"; else files="$count files"; fi
    echo "- **Conflicts:** $files, listed below."
  fi
  echo "- **Next fork version:** \`$next\`, the next free patch number in the $major.$minor line."
  if [ -n "$conflicts" ]; then
    echo
    echo "### Conflicting files"
    echo
    echo "$conflicts" | sed 's/^/- `/; s/$/`/'
  fi
  echo
  echo "### Merge it"
  echo
  echo '```bash'
  echo "git fetch upstream"
  echo "git switch main"
  echo "git merge upstream/$tag"
  echo '```'
  echo
  echo "Use a merge commit. Don't rebase or squash: \`main\` is shared history."
  echo
  echo "### Release it"
  echo
  echo "Write \`.github/release-notes/$next.md\`, naming SST $tag as the upstream version it includes, then push the \`$next\` tag."
  echo
  echo "To skip this release, close this issue. It isn't opened again until SST releases a newer version."
} > "$BODY_FILE"

output "tag=$tag"
output "title=Upstream release $tag"
