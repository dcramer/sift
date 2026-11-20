#!/usr/bin/env bash
# SessionStart hook: when what users see has changed on main since verify-sift was last audited, tell
# the session to offer pstack's maintain-verification-skill. Speaks at most once a day per machine,
# and says nothing otherwise. Reads local refs only: no fetch, so it never slows a session down.
#
#   maintain-check.sh                 the hook
#   maintain-check.sh --audited <sha> record that a maintenance pass covered main up to <sha>
#
# State: ~/.cache/sift-verify-maint/ (last-audited, suggested-on).
set -euo pipefail

STATE="$HOME/.cache/sift-verify-maint"
SKILL=.claude/skills/verify-sift
# What a user meets, and what the seed imports. The skill's own changes are not drift: a merged maintenance PR would ask again.
WATCH=(app web/src public src/dashboard src/cli src/store src/work src/sift tests/helpers.ts tests/google.ts)
mkdir -p "$STATE"
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

if [ "${1:-}" = --audited ]; then
  git rev-parse --verify -q "${2:?--audited needs a commit}^{commit}" > "$STATE/last-audited"
  exit 0
fi

today="$(date +%F)"
[ "$(cat "$STATE/suggested-on" 2>/dev/null)" = "$today" ] && exit 0
main="$(git rev-parse -q --verify origin/main || git rev-parse -q --verify main)" || exit 0
# Before any recorded pass, the skill was last audited when it was last changed.
last="$(cat "$STATE/last-audited" 2>/dev/null || git log -1 --format=%H "$main" -- "$SKILL")"
[ -n "$last" ] || exit 0
churn="$(git log --no-merges --format='- %h %s' "$last..$main" -- "${WATCH[@]}" | head -20)"
[ -n "$churn" ] || exit 0
echo "$today" > "$STATE/suggested-on"

# A SessionStart hook's stdout is added to the session's context.
echo "verify-sift may be out of date. These commits on main changed what dashboard users see since it was last audited (${last:0:7}):
$churn

In your first reply, say so in one line and offer to run the maintenance pass: /pstack:maintain-verification-skill on $SKILL, ideally in its own session so it does not hold up this one. Do not run it unless the user says yes, and do not raise it again in this session. When a pass ends clean or changed, record it with: $SKILL/scripts/maintain-check.sh --audited ${main:0:12}"
