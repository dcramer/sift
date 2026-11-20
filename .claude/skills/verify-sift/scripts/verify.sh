#!/usr/bin/env bash
# Drives one disposable sift dashboard. Everything for a run lives in <dir>:
#   home/       the sift home (seeded, synthetic)     removed by `down`
#   evidence/   screenshots, snapshots, query output   kept by `down`
#   pid port cookie dashboard.log google.json (the fake Google, tests/google.ts: every mailbox, its mail, labels and filters, and what was sent)
# Usage: verify.sh up <dir> [--bare | --on | --chatgpt | --inbox] [--listing] | doctor <dir> | ab <dir> <agent-browser args...> | sql <dir> <query> | down <dir>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
AB_VERSION=0.39.2
cmd="${1:-}"
dir="${2:-}"
[ -n "$cmd" ] && [ -n "$dir" ] || { echo "usage: verify.sh up|doctor|ab|sql|down <dir> [...]" >&2; exit 2; }
dir="$(mkdir -p "$dir" && cd "$dir" && pwd)"
session="verify-sift-$(basename "$dir")"

# Chrome's own sandbox needs unprivileged user namespaces, which Ubuntu's AppArmor refuses here. The page is synthetic and local.
ab() { npx -y "agent-browser@$AB_VERSION" --session "$session" --args --no-sandbox "$@"; }

doctor() {
  local pid port cookie session_json
  pid="$(cat "$dir/pid" 2>/dev/null)" || { echo "doctor: no instance in $dir (run up)"; return 1; }
  port="$(cat "$dir/port")"
  cookie="$(cat "$dir/cookie")"
  kill -0 "$pid" 2>/dev/null || { echo "doctor: pid $pid is not running; see $dir/dashboard.log"; return 1; }
  # Only this home's key signed the cookie, so a signed-in answer proves the port is this run's instance.
  session_json="$(curl -sf -H "cookie: sift_session=$cookie" "http://127.0.0.1:$port/api/session")" || { echo "doctor: nothing answering on $port"; return 1; }
  case "$session_json" in
    *'"email":"me@example.org"'*) ;;
    *) echo "doctor: port $port is not this run's sift (or the cookie no longer signs in): $session_json"; return 1 ;;
  esac
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/suggestions")" = 401 ] || { echo "doctor: /api/ answers without a session"; return 1; }
  echo "ok  pid $pid  http://127.0.0.1:$port  home $dir/home  build $(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet HEAD -- src web/src || echo '+changes')"
}

case "$cmd" in
  up)
    [ ! -e "$dir/home" ] || { echo "up: $dir/home exists. Use a new directory per run." >&2; exit 1; }
    mkdir -p "$dir/evidence"
    variant='' listing=''
    for flag in "${@:3}"; do
      case "$flag" in
        --listing) listing=--listing ;;
        --bare | --on | --chatgpt | --inbox) variant="$flag" ;;
        *) echo "up: unknown option $flag" >&2; exit 2 ;;
      esac
    done
    node --disable-warning=ExperimentalWarning "$ROOT/.claude/skills/verify-sift/scripts/seed.ts" "$dir/home" "$dir/google.json" $variant > "$dir/cookie"
    port="$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
    echo "$port" > "$dir/port"
    # The real app on this home, as `sift run` starts it, with the fake Google and a stand-in model (stand-ins.ts says
    # what they answer) and no minute's tick, on a build of the code as it is now: Next.js's cache makes that seconds.
    cd "$ROOT"
    pnpm -s build:web > "$dir/build.log" 2>&1 || { tail -20 "$dir/build.log" >&2; exit 1; }
    nohup node --disable-warning=ExperimentalWarning "$ROOT/.claude/skills/verify-sift/scripts/serve.ts" "$dir/home" "$port" "$dir/google.json" $listing > "$dir/dashboard.log" 2>&1 &
    echo $! > "$dir/pid"
    for _ in $(seq 1 240); do
      grep -q 'Sift is running on the seeded home' "$dir/dashboard.log" 2>/dev/null && break
      kill -0 "$(cat "$dir/pid")" 2>/dev/null || { cat "$dir/dashboard.log" >&2; exit 1; }
      sleep 0.5
    done
    doctor
    ab cookies set sift_session "$(cat "$dir/cookie")" --url "http://127.0.0.1:$port" --httpOnly > /dev/null
    echo "browser session $session signed in as me@example.org"
    ;;
  doctor) doctor ;;
  ab) shift 2; ab "$@" ;;
  sql)
    # The running dashboard holds the database (PGlite is one process's alone), so read a copy of it.
    copy="$(mktemp -d)"
    cp -r "$dir/home/database/." "$copy"
    (cd "$ROOT" && node --input-type=module -e '
      import { PGlite } from "@electric-sql/pglite";
      const db = new PGlite(process.argv[1]);
      try {
        console.log(JSON.stringify((await db.query(process.argv[2])).rows, null, 1));
      } catch (e) {
        // An uncaught PGlite error prints its whole minified bundle before the message.
        console.error(`sql: ${e.message}${e.hint ? ` (${e.hint})` : ""}`);
        process.exitCode = 1;
      } finally {
        await db.close();
      }
    ' "$copy" "$3")
    rm -r -- "$copy"
    ;;
  down)
    ab close > /dev/null 2>&1 || true
    if [ -f "$dir/pid" ]; then
      pid="$(cat "$dir/pid")"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
    fi
    rm -rf "$dir/home" "$dir/pid" "$dir/port" "$dir/cookie" "$dir/google.json"
    echo "stopped; evidence kept in $dir/evidence"
    ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
