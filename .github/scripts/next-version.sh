#!/usr/bin/env bash
# Works out the version of the next release: the fork's newest release in
# main's history, bumped by the most that anything merged since calls for.
# Run it on an up-to-date main before tagging. It changes nothing.
#
#   .github/scripts/next-version.sh
#
# It counts the `semver:` label of each pull request merged since the release
# (the automatic review sets it, and a committer corrects it), and the SST
# release merged since then, if any: a new SST minor is a minor, a new SST
# patch a patch. A pull request without the label, or a commit pushed straight
# to main, isn't counted: they're listed, to check by hand.
#
# Once .github/release-notes/<version>.md is written, run it again: it lists
# the pull requests merged since the release that the notes don't link.
#
# REF      what would be released (default HEAD)
# GH_REPO  the repo to read pull requests from (default sst-community/sst)
set -euo pipefail

REF="${REF:-HEAD}"
GH_REPO="${GH_REPO:-sst-community/sst}"
export GH_REPO

# SST's tags are kept under upstream/: plain v* tags are the fork's releases.
git fetch --quiet --no-tags https://github.com/anomalyco/sst.git '+refs/tags/v*:refs/tags/upstream/v*'

newest() {
  git tag --merged "$1" --list "$2" --sort=-version:refname |
    grep -E '^(upstream/)?v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true
}
rank() { case "$1" in major) echo 3 ;; minor) echo 2 ;; patch) echo 1 ;; *) echo 0 ;; esac; }

release=$(newest "$REF" 'v*')
if [ -z "$release" ]; then
  echo "No fork release in the history of $REF." >&2
  exit 1
fi
if [ -z "$(git rev-list -n 1 "$release..$REF")" ]; then
  echo "Nothing is on $REF since $release."
  exit 0
fi

level=none
bump() { if [ "$(rank "$1")" -gt "$(rank "$level")" ]; then level=$1; fi; }

# The SST release merged since.
then_sst=$(newest "$release" 'upstream/v*')
now_sst=$(newest "$REF" 'upstream/v*')
echo "Last release: $release, built on SST ${then_sst#upstream/v}"
if [ "$then_sst" = "$now_sst" ]; then
  echo "SST: no newer release merged since"
else
  IFS=. read -r a b _ <<<"${then_sst#upstream/v}"
  IFS=. read -r x y _ <<<"${now_sst#upstream/v}"
  if [ "$a" != "$x" ]; then sst=major; elif [ "$b" != "$y" ]; then sst=minor; else sst=patch; fi
  echo "SST: ${now_sst#upstream/v} merged since, a $sst release"
  bump "$sst"
fi

# Pull requests merged since the release. The search is by day, so the
# history decides which came after it.
since=$(git log -1 --format=%cs "$release^{commit}")
prs=$(gh pr list --base main --state merged --search "merged:>=$since" --limit 200 \
  --json number,title,labels,mergeCommit \
  --jq '.[] | [.number, (.mergeCommit.oid // ""), ([.labels[].name | select(startswith("semver: ")) | ltrimstr("semver: ")] | first // ""), .title] | map(tostring) | join("\u001f")')
echo
echo "Pull requests merged since $release:"
listed=false
merged=""
# Fields are split on the unit separator: tabs would collapse an empty label.
while IFS=$'\x1f' read -r number oid semver title; do
  [ -n "$number" ] || continue
  if ! git cat-file -e "$oid^{commit}" 2>/dev/null; then
    echo "  ?      #$number $title (its merge isn't in this clone: pull main)"
    listed=true
    continue
  fi
  git merge-base --is-ancestor "$oid" "$release" && continue
  git merge-base --is-ancestor "$oid" "$REF" || continue
  listed=true
  merged+="$number"$'\x1f'"$title"$'\n'
  if [ -n "$semver" ]; then
    printf '  %-6s #%s %s\n' "$semver" "$number" "$title"
    bump "$semver"
  else
    echo "  -      #$number $title (no semver label, not counted)"
  fi
done <<<"$prs"
[ "$listed" = true ] || echo "  none"

# Commits pushed straight to main. A pull request lands as a merge commit or
# as a squashed commit whose title ends in (#123).
direct=$(git log --first-parent --no-merges --format='%h %s' "$release..$REF" | grep -Ev '\(#[0-9]+\)$' || true)
if [ -n "$direct" ]; then
  echo
  echo "Pushed straight to main since $release (no label, not counted):"
  echo "$direct" | sed 's/^/  /'
fi

# Anything released is at least a patch.
[ "$level" != none ] || level=patch
IFS=. read -r a b c <<<"${release#v}"
case "$level" in
  major) next="v$((a + 1)).0.0" ;;
  minor) next="v$a.$((b + 1)).0" ;;
  patch) next="v$a.$b.$((c + 1))" ;;
esac
echo
echo "Next version: $next ($level)"
if [ "$level" = major ]; then
  echo "A breaking change is in. main doesn't take breaking changes for now: sort that out before releasing."
fi

# The release notes are written by hand, so check that they link every pull
# request in the release, as [#123] or a link to its page.
notes=".github/release-notes/$next.md"
echo
if [ ! -f "$notes" ]; then
  echo "Write $notes, then run this again to check that it links every pull request."
  exit 0
fi
missing=""
while IFS=$'\x1f' read -r number title; do
  [ -n "$number" ] || continue
  if ! grep -Eq "\[#$number\]|sst-community/sst/pull/$number([^0-9]|$)" "$notes"; then
    missing+="  #$number $title"$'\n'
  fi
done <<<"$merged"
if [ -n "$missing" ]; then
  echo "$notes doesn't link these pull requests. Add them, or leave out what users don't need to know:"
  printf '%s' "$missing"
else
  echo "$notes links every pull request merged since $release."
fi
