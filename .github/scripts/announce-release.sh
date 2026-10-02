#!/usr/bin/env bash
# Posts a release's notes to Discord through the webhook in DISCORD_WEBHOOK_URL.
# Used by .github/workflows/release.yml. To try it against a published release:
#
#   TAG=v4.17.2 GH_REPO=sst-community/sst DISCORD_WEBHOOK_URL=<url> .github/scripts/announce-release.sh
set -euo pipefail

if [ -z "${DISCORD_WEBHOOK_URL:-}" ]; then
  echo "::notice::DISCORD_WEBHOOK_URL isn't set, so the release wasn't announced on Discord."
  exit 0
fi

url="https://github.com/$GH_REPO/releases/tag/$TAG"

# Every release's notes end with the same install section. Leave it out.
notes=$(gh release view "$TAG" --json body --jq .body | sed '/^### Install$/,$d')

# A Discord message holds 2000 characters. Longer notes are cut at a line break,
# and the link under them has the rest. `flags: 4` stops the links unfurling.
payload=$(jq -n --arg tag "$TAG" --arg url "$url" --arg notes "$notes" '
  ($notes | sub("\\s+$"; "")) as $notes
  | (if ($notes | length) > 1700
     then ($notes[0:1700] | sub("\n[^\n]*$"; "")) + "\n…"
     else $notes
     end) as $body
  | {
      content: "## sst-community \($tag)\n\($body)\n\n[Release notes and downloads](\($url))",
      flags: 4,
      allowed_mentions: { parse: [] }
    }')

curl -fsS -X POST -H "Content-Type: application/json" -d "$payload" "$DISCORD_WEBHOOK_URL"
