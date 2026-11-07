#!/usr/bin/env bash
# Runs the review with opencode and writes it to $OUT/review.raw. Exits 0 when
# a review was written, 1 when no model gave one.
#
# Each attempt first asks the model for one word, with a 25-second limit, so a
# model that doesn't answer costs seconds, not the step's timeout. The free
# models are tried first, with OPENCODE_API_KEY, which has the project's own
# quota, and each gets 7 minutes for the review. The last attempt is a model
# of the key's OpenCode Go plan, which costs money, so it runs only when no
# free model wrote a review, and 8 minutes are kept for it. Without the key,
# the free models are tried without one. A review counts only when it has the
# Summary and Version sections. A review that contains the key is dropped, so
# the key can't reach the comment.
#
# Needs OUT, OPENCODE and OPENCODE_CONFIG. REVIEW_OPENCODE_API_KEY is optional.
# Writes the model that wrote the review to $GITHUB_ENV as MODEL.
set -uo pipefail

key="${REVIEW_OPENCODE_API_KEY:-}"
deadline=$(($(date +%s) + ${REVIEW_BUDGET:-1080}))
paid="opencode-go/glm-5.3-flash"
free=(
  opencode/glm-5.3-flash-free
  opencode/iceman-free
  opencode/beam-free
)
if [ -n "$key" ]; then
  auth=key
  attempts=("${free[@]}" "$paid")
  reserve=480
else
  auth=none
  attempts=("${free[@]}")
  reserve=0
fi

# Runs opencode with a time limit. opencode never sees REVIEW_OPENCODE_API_KEY,
# and sees OPENCODE_API_KEY only when there is a key. The key isn't put on a
# command line.
oc() {
  local seconds=$1
  shift
  (
    unset REVIEW_OPENCODE_API_KEY OPENCODE_API_KEY
    [ "$auth" = key ] && export OPENCODE_API_KEY="$key"
    exec timeout "$seconds" npx -y "$OPENCODE" run --pure "$@" </dev/null
  )
}

for model in "${attempts[@]}"; do
  left=$((deadline - $(date +%s)))
  if [ "$model" = "$paid" ]; then
    limit=$left
  else
    left=$((left - reserve))
    limit=$((left < 420 ? left : 420))
  fi
  [ "$limit" -gt 60 ] || continue

  echo "::group::$model ($([ "$auth" = key ] && echo "with the key" || echo "without a key"))"
  if ! oc 25 --model "$model" "Reply with the single word: pong" 2>/dev/null | grep -qi pong; then
    echo "No answer within 25 seconds."
    echo "::endgroup::"
    continue
  fi

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
