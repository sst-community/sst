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

# The fork numbers its own releases. Merging SST's release bumps the fork's
# newest release in this history by as much as SST's release moved: a new SST
# minor is a minor, a new SST patch a patch. Pull requests merged since the
# fork's release can call for more; next-version.sh counts both.
IFS=. read -r major minor patch <<< "$version"
IFS=. read -r merged_major merged_minor _ <<< "${merged#upstream/v}"
if [ -z "$merged" ] || [ "$major" != "$merged_major" ]; then
  level=major
elif [ "$minor" != "$merged_minor" ]; then
  level=minor
else
  level=patch
fi
release=$(git tag --merged "$BASE" --list 'v*' --sort=-version:refname \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)
if [ -n "$release" ]; then
  IFS=. read -r a b c <<< "${release#v}"
  case "$level" in
    major) next="v$((a + 1)).0.0" ;;
    minor) next="v$a.$((b + 1)).0" ;;
    patch) next="v$a.$b.$((c + 1))" ;;
  esac
else
  next="$tag"
fi

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
  if [ -n "$release" ]; then
    echo "- **Next fork version:** \`$next\` at least: SST $tag is a $level release, so the fork's \`$release\` gets a $level bump. \`.github/scripts/next-version.sh\` also counts the pull requests merged since \`$release\`."
  else
    echo "- **Next fork version:** \`$next\`. The fork has no release in this history yet."
  fi
  if [ "$level" = major ]; then
    echo "- **SST $tag is a new major version**, with breaking changes. \`main\` doesn't take breaking changes for now, so decide how to take it before merging."
  fi
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
  echo "Run \`.github/scripts/next-version.sh\` on \`main\` for the version, \`$next\` or higher. Write \`.github/release-notes/<version>.md\`, naming SST $tag as the upstream version it includes, then push the tag."
  echo
  echo "To skip this release, close this issue. It isn't opened again until SST releases a newer version."
} > "$BODY_FILE"

output "tag=$tag"
output "title=Upstream release $tag"
