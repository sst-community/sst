#!/usr/bin/env bash
# Posts the automatic review on a pull request: one comment, updated on each
# run, the risk label, and a `review` status on the latest commit.
#
# Needs GH_TOKEN, GH_REPO, PR, SHA, OUT, MODEL and RUN_URL, and the files
# review-prepare.sh wrote in $OUT. $OUT/review.raw is opencode's output, used
# only when OPENCODE_OUTCOME is "success". Run it from the repo root.
# DRY_RUN=1 prints instead of posting.
set -euo pipefail

marker="<!-- sst-community-review -->"
risk=$(cat "$OUT/risk")

# review-comment.py reads the review and writes the comment, the status and
# the version.
python3 "$(dirname "$0")/review-comment.py"
state=$(cat "$OUT/state")
description=$(cat "$OUT/description")
version=$(cat "$OUT/version")
breaking=$(cat "$OUT/breaking")

if [ -n "${DRY_RUN:-}" ]; then
  echo "status: $state - $description"
  echo "label: risk: $risk"
  echo "label: semver: ${version:-(unchanged)}"
  echo "label: breaking: ${breaking:-(unchanged)}"
  echo "--- comment:"
  cat "$OUT/comment.md"
  exit 0
fi

# One comment per pull request, updated in place.
id=$(gh api --paginate "repos/$GH_REPO/issues/$PR/comments" \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" | head -1)
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$GH_REPO/issues/comments/$id" -F "body=@$OUT/comment.md" >/dev/null
else
  gh api -X POST "repos/$GH_REPO/issues/$PR/comments" -F "body=@$OUT/comment.md" >/dev/null
fi

# Exactly one risk label.
for other in low medium high; do
  [ "$other" = "$risk" ] && continue
  if gh api "repos/$GH_REPO/issues/$PR/labels" --jq '.[].name' | grep -qx "risk: $other"; then
    gh api -X DELETE "repos/$GH_REPO/issues/$PR/labels/risk:%20$other" >/dev/null
  fi
done
gh api -X POST "repos/$GH_REPO/issues/$PR/labels" -f "labels[]=risk: $risk" >/dev/null

# Exactly one semver label, when the review gave a version. Without one, the
# label from an earlier run, or a committer's, stays.
if [ -n "$version" ]; then
  for other in patch minor major; do
    [ "$other" = "$version" ] && continue
    if gh api "repos/$GH_REPO/issues/$PR/labels" --jq '.[].name' | grep -qx "semver: $other"; then
      gh api -X DELETE "repos/$GH_REPO/issues/$PR/labels/semver:%20$other" >/dev/null
    fi
  done
  gh api -X POST "repos/$GH_REPO/issues/$PR/labels" -f "labels[]=semver: $version" >/dev/null
fi

# The `breaking` label marks a change that alters what users need, such as a
# new minimum requirement, from the review's release note. next-version.sh
# puts these first in the release notes. A committer can set it by hand too;
# a run whose review has no release note leaves it as it was.
has_breaking=$(gh api "repos/$GH_REPO/issues/$PR/labels" --jq '.[].name' | grep -qx breaking && echo yes || echo no)
if [ "$breaking" = yes ] && [ "$has_breaking" = no ]; then
  gh api -X POST "repos/$GH_REPO/issues/$PR/labels" -f "labels[]=breaking" >/dev/null
elif [ "$breaking" = no ] && [ "$has_breaking" = yes ]; then
  gh api -X DELETE "repos/$GH_REPO/issues/$PR/labels/breaking" >/dev/null
fi

gh api -X POST "repos/$GH_REPO/statuses/$SHA" -f state="$state" -f context=review \
  -f description="$description" -f target_url="$RUN_URL" >/dev/null
