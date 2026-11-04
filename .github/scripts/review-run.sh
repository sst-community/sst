#!/usr/bin/env bash
# Runs the review with opencode and writes it to $OUT/review.raw. Exits 0 when
# a review was written, 1 when no model gave one.
#
# Each attempt first asks the model for one word, with a 25-second limit, so a
# model that doesn't answer costs seconds, not the step's timeout, and each
# review gets 5 minutes at most. The free models are tried with
# OPENCODE_API_KEY first, which has the project's own quota, and then without a
# key. A review counts only when it has the Summary and Version
# sections. A review that contains the key is dropped, so the key can't reach
# the comment.
#
# Needs OUT, OPENCODE and OPENCODE_CONFIG. REVIEW_OPENCODE_API_KEY is optional.
# Writes the model that wrote the review to $GITHUB_ENV as MODEL.
set -uo pipefail

key="${REVIEW_OPENCODE_API_KEY:-}"
deadline=$(($(date +%s) + ${REVIEW_BUDGET:-1080}))
attempts=(
  "opencode/deepseek-v4.1-flash-free key"
  "opencode/glm-5.3-flash-free key"
  "opencode/beam-free key"
  "opencode/deepseek-v4.1-flash-free none"
)

# Runs opencode with a time limit. opencode never sees REVIEW_OPENCODE_API_KEY,
# and sees OPENCODE_API_KEY only on an attempt that uses the key. The key isn't
# put on a command line.
oc() {
  local seconds=$1
  shift
  (
    unset REVIEW_OPENCODE_API_KEY OPENCODE_API_KEY
    [ "$auth" = key ] && export OPENCODE_API_KEY="$key"
    exec timeout "$seconds" npx -y "$OPENCODE" run --pure "$@" </dev/null
  )
}

for attempt in "${attempts[@]}"; do
  model=${attempt% *}
  auth=${attempt#* }
  [ "$auth" = key ] && [ -z "$key" ] && continue
  left=$((deadline - $(date +%s)))
  [ "$left" -gt 60 ] || break

  echo "::group::$model ($([ "$auth" = key ] && echo "with the key" || echo "without a key"))"
  if ! oc 25 --model "$model" "Reply with the single word: pong" 2>/dev/null | grep -qi pong; then
    echo "No answer within 25 seconds."
    echo "::endgroup::"
    continue
  fi

  limit=$((left < 300 ? left : 300))
  oc "$limit" --agent review --model "$model" -f "$OUT/pr.md" -f "$OUT/pr.diff" \
    -- "$(cat .github/review/prompt.md)" >"$OUT/review.try" 2>/dev/null
  status=$?

  if [ -n "$key" ] && grep -qF -- "$key" "$OUT/review.try"; then
    echo "The review contains the key, so it was dropped."
    rm -f "$OUT/review.try"
    echo "::endgroup::"
    exit 1
  fi
  if [ "$status" -eq 0 ] && grep -q '^### Summary' "$OUT/review.try" && grep -q '^### Version' "$OUT/review.try"; then
    mv "$OUT/review.try" "$OUT/review.raw"
    echo "MODEL=$model" >>"${GITHUB_ENV:-/dev/null}"
    echo "Review written."
    echo "::endgroup::"
    exit 0
  fi
  echo "No usable review (exit $status)."
  rm -f "$OUT/review.try"
  echo "::endgroup::"
done
exit 1
