#!/usr/bin/env bash
# Posts the automatic review on a pull request: one comment, updated on each
# run, the risk label, and a `review` status on the latest commit.
#
# Needs GH_TOKEN, GH_REPO, PR, SHA, OUT, MODEL and RUN_URL, and the files
# review-prepare.sh wrote in $OUT. $OUT/review.raw is opencode's output, used
# only when OPENCODE_OUTCOME is "success". DRY_RUN=1 prints instead of posting.
set -euo pipefail

marker="<!-- sst-community-review -->"
risk=$(cat "$OUT/risk")
failed=$(cat "$OUT/failed")

# The model's review, from its Summary heading on. Colors are stripped and
# mentions broken, so the text can't ping anyone. The model tags each finding
# [blocking] or [suggestion]; the verdict is worked out here from the tags,
# which varies less between runs than asking the model for one.
#
# A review without a Findings heading didn't finish: the model ran out of
# steps, and opencode had it write up its progress instead. That text is kept
# as notes, and nothing is read from it.
#
# The Version section gives the semver bump: patch, minor or major. It becomes
# the `semver:` label that next-version.sh counts. `main` doesn't take breaking
# changes for now, so a major fails the status.
review=""
notes=""
blocking=""
version=""
if [ "${OPENCODE_OUTCOME:-}" = success ] && [ -f "$OUT/review.raw" ]; then
  text=$(perl -CS -pe 's/\e\[[0-9;]*m//g; s/@(?=\w)/@\x{200B}/g' <"$OUT/review.raw" | head -c 50000)
  if grep -Eq '^#+ *Findings' <<<"$text"; then
    review=$(awk '/^#+ *Summary/{on=1} on' <<<"$text")
    [ -n "$review" ] || review=$text
    blocking=$(awk '/^#+ *Findings/{on=1; next} /^#/{on=0} on' <<<"$review" |
      grep -Eic '^[[:space:]]*([-*]|[0-9]+\.)[[:space:]]*[*_`]*\[blocking\]' || true)
    version=$(awk '/^#+ *Version/{on=1; next} /^#/{on=0} on' <<<"$review" |
      grep -Eiwo 'patch|minor|major' | head -n 1 | tr '[:upper:]' '[:lower:]' || true)
  else
    notes=$text
  fi
fi

if [ "$failed" -gt 0 ]; then
  state=failure
  description="$failed check(s) failed. See the review comment."
elif [ "$version" = major ]; then
  state=failure
  description="The review marks this as a breaking change, which main doesn't take for now."
elif [ -n "$blocking" ] && [ "$blocking" -gt 0 ]; then
  state=failure
  description="The review has $blocking blocking finding(s). See the review comment."
elif [ -n "$review" ]; then
  state=success
  description="Checks passed, and the review has no blocking findings."
elif [ "${OPENCODE_OUTCOME:-}" = success ]; then
  state=success
  description="Checks passed. The AI review didn't finish."
else
  state=success
  description="Checks passed. The AI review didn't run."
fi

{
  echo "$marker"
  echo "## Automatic review"
  echo
  if [ "$state" = failure ]; then
    echo "**Before a committer reviews this, please fix the ❌ checks and the \`[blocking]\` findings below**, or reply if you disagree. Pushing a fix runs this again."
    echo
    if [ "$version" = major ]; then
      echo "**This looks like a breaking change** (see Version below). \`main\` doesn't take breaking changes for now. If it isn't one, reply saying why, and a committer decides."
      echo
    fi
  fi
  echo "**Risk:** $(cat "$OUT/risk.md")"
  echo
  echo "**Checks**"
  echo
  cat "$OUT/checks.md"
  echo
  if [ -n "$review" ]; then
    echo "$review"
  elif [ "${OPENCODE_OUTCOME:-}" = success ]; then
    echo "_The AI review ran out of steps before it finished ([run]($RUN_URL)). The checks above still apply._"
    if [ -n "$(tr -d '[:space:]' <<<"$notes")" ]; then
      echo
      echo "<details><summary>What it wrote before it stopped</summary>"
      echo
      echo "$notes"
      echo
      echo "</details>"
    fi
  else
    echo "_The AI review didn't run this time ([run]($RUN_URL)). The checks above still apply._"
  fi
  echo
  echo "<sub>A first pass by [opencode](https://opencode.ai) with the free \`$MODEL\` model ([run]($RUN_URL)). It can be wrong. A committer still reviews and approves every pull request. Pushing, or editing the title or description, runs it again.</sub>"
} >"$OUT/comment.md"

if [ -n "${DRY_RUN:-}" ]; then
  echo "status: $state - $description"
  echo "label: risk: $risk"
  echo "label: semver: ${version:-(unchanged)}"
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

gh api -X POST "repos/$GH_REPO/statuses/$SHA" -f state="$state" -f context=review \
  -f description="$description" -f target_url="$RUN_URL" >/dev/null
