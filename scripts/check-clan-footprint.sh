#!/usr/bin/env bash
# Fails when the clan branch touches an upstream file outside the agreed budget
# (docs/plans/clan-storage.md section 12). Growth must be a deliberate edit of ALLOWED below.
#   scripts/check-clan-footprint.sh [BASE]
# Default BASE: the parent of the first commit that created the clan module, so it keeps working
# after the branch is rebased onto a newer upstream.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
first=$(git log --reverse --format=%H --diff-filter=A -- server/engine/src/engine/clan | sed -n 1p || true)
base=${1:-${first:+$(git rev-parse "$first^")}}
[ -n "$base" ] || { echo "no clan commits found; pass BASE" >&2; exit 2; }

# New clan-owned paths (anything under these is not an upstream touch point).
OWNED='^(server/engine/src/engine/clan/|server/engine/src/web/pages/Clan[^/]*\.ts$|server/content/scripts/clan/|server/webclient/src/bot/clan-[^/]*\.ts$|sdk/clan-[^/]*$|sdk/test/clan-[^/]*$|server/engine/test/clan-[^/]*$|server/engine/test/fixtures/clan-[^/]*$|docs/clans\.md$|scripts/check-clan-footprint\.sh$)'

ALLOWED=(
    server/engine/src/network/game/client/handler/IfButtonHandler.ts
    server/engine/src/network/game/client/handler/InvButtonHandler.ts
    server/engine/src/network/game/client/handler/ResumePCountDialogHandler.ts
    server/engine/src/network/game/client/handler/MessagePublicHandler.ts
    server/engine/src/engine/World.ts
    server/engine/src/web/index.ts
    server/engine/src/web/pages/hiscores.ts
    server/content/scripts/interface_bank/interfaces/bank_main.if
    server/content/pack/interface.pack
    server/content/pack/interface.order
    server/webclient/src/bot/StateCollector.ts
    # the clan tab icon, painted into the sidebar background (binary; source icon is clan-owned:
    # content/scripts/clan/sprites/clan_tab_icon.png, stamped by server/engine/test/clan-tab-icon.ts)
    server/content/sprites/back.png
    sdk/index.ts
    sdk/actions.ts
    sdk/formatter.ts
    # documentation and package wiring (no runtime code)
    server/PATCHES.md
    sdk/API.md
    package.json
)

fail=0
echo "Upstream files touched since ${base:0:9}:"
while IFS= read -r file; do
    [[ $file =~ $OWNED ]] && continue
    stat=$(git diff --shortstat "$base" HEAD -- "$file" | sed 's/^ *//')
    allowed=0
    for a in "${ALLOWED[@]}"; do [ "$a" = "$file" ] && allowed=1; done
    if [ "$allowed" = 1 ]; then
        echo "  ok    $file  ($stat)"
    else
        echo "  NEW   $file  ($stat)"
        fail=1
    fi
done < <(git diff --name-only "$base" HEAD)
if [ "$fail" = 1 ]; then
    echo "clan footprint grew beyond docs/plans/clan-storage.md section 12; move the code into a clan-owned file or update the budget deliberately." >&2
    exit 1
fi
echo "clan footprint within budget."
