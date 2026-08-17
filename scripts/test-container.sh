#!/usr/bin/env bash
#
# The container suite. Brings up the service and a fixture origin, runs the
# behavioural and security tests against the running service over HTTP, and
# tears down.
#
# The network-isolation check only means anything where the other containers
# actually exist, so it runs on the VPS and reports as skipped elsewhere.
set -euo pipefail

cd "$(dirname "$0")/.."

# A separate project, so `down -v` below cannot reach the production volume —
# which holds the persistent browser profile and the real cache.
COMPOSE="docker compose -p pagefetch-test -f compose.yml -f compose.test.yml"
# The limiter wants the opposite of what the general suite wants: the general
# suite makes far more than twenty requests to one fixture host and must not be
# rate limited, while this stack exists to be rate limited. So it gets its own.
LIMITS="docker compose -p pagefetch-limits -f compose.yml -f compose.test.yml -f compose.limits.yml"
NEIGHBOUR="${PAGEFETCH_NEIGHBOUR_CONTAINER:-tnl-dashboard-postgres-1}"
NEIGHBOUR_PORT="${PAGEFETCH_NEIGHBOUR_PORT:-5432}"

if [[ ! -f .env ]]; then
  echo "no .env — copy .env.example, and put a real token in it" >&2
  exit 1
fi

# -v so every run starts from a cold cache and a cold profile. Scoped to the
# pagefetch-test project by the -p above.
cleanup() {
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
  $LIMITS down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building"
$COMPOSE build >/dev/null

echo "==> starting"
$COMPOSE up -d

echo "==> waiting for health"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8790/health >/dev/null || { echo "service never became healthy"; $COMPOSE logs pagefetch; exit 1; }

# ---------------------------------------------------------------------------
# Network isolation. Verified by ATTEMPTING A CONNECTION, not by reading the
# compose file — the compose file is the claim, this is the evidence.
# ---------------------------------------------------------------------------
echo "==> network isolation"
if docker inspect "$NEIGHBOUR" >/dev/null 2>&1; then
  NEIGHBOUR_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$NEIGHBOUR" | awk '{print $1}')
  echo "    target: $NEIGHBOUR at $NEIGHBOUR_IP:$NEIGHBOUR_PORT"

  if $COMPOSE exec -T pagefetch node -e "
    const net = require('net');
    const s = net.connect($NEIGHBOUR_PORT, '$NEIGHBOUR_IP');
    s.setTimeout(5000);
    s.on('connect', () => { console.error('REACHABLE'); process.exit(0) });
    s.on('timeout', () => process.exit(1));
    s.on('error',   () => process.exit(1));
  "; then
    echo "    FAIL: pagefetch can reach $NEIGHBOUR. It must have no route to the dashboard network." >&2
    exit 1
  else
    echo "    pass: $NEIGHBOUR is unreachable from inside pagefetch"
  fi
else
  echo "    SKIPPED: no container named $NEIGHBOUR on this host (expected off the VPS)"
fi

# ---------------------------------------------------------------------------
# The behavioural suite, at the transport boundary.
# ---------------------------------------------------------------------------
npm run build >/dev/null
set -a; source .env; set +a
export PAGEFETCH_URL="http://127.0.0.1:8790"

# Every behavioural test runs against BOTH transports, because the whole point
# of one handler is that semantics do not diverge. Unquoted globs on purpose:
# the shell expands them, which works on Node 20 and Node 22+ alike.
for TRANSPORT in fetch mcp; do
  echo "==> behavioural suite (/$TRANSPORT)"
  # shellcheck disable=SC2086
  PAGEFETCH_TRANSPORT="$TRANSPORT" node --test dist/test/container/*.test.js
done

echo "==> MCP protocol suite"
# shellcheck disable=SC2086
node --test dist/test/mcp/*.test.js

# ---------------------------------------------------------------------------
# The cache must outlive the process. Restarting is the only honest way to
# check that, so it happens here rather than inside the suite.
# ---------------------------------------------------------------------------
echo "==> cache survives a restart"
CACHE_URL="http://fixture:3000/plain?restart-check"

fetch_once() {
  curl -sS -X POST http://127.0.0.1:8790/fetch \
    -H "Authorization: Bearer $PAGEFETCH_TOKEN" \
    -H "content-type: application/json" \
    -d "{\"tool\":\"fetch_page\",\"arguments\":{\"url\":\"$CACHE_URL\"}}"
}

fetch_once >/dev/null
$COMPOSE restart pagefetch >/dev/null
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1; then break; fi
  sleep 1
done

AFTER=$(fetch_once)
if echo "$AFTER" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("from_cache") is True else 1)'; then
  echo "    pass: served from cache after a restart"
else
  echo "    FAIL: the cache did not survive a restart" >&2
  echo "$AFTER" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# The politeness caps, at their real values, in their own stack.
# ---------------------------------------------------------------------------
echo "==> limiter suite (real caps)"
$COMPOSE down -v --remove-orphans >/dev/null 2>&1
$LIMITS up -d >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8790/health >/dev/null || { echo "limiter stack never became healthy"; $LIMITS logs pagefetch; exit 1; }

# shellcheck disable=SC2086
PAGEFETCH_URL="http://127.0.0.1:8790" node --test dist/test/limiter/*.test.js

# ---------------------------------------------------------------------------
# Disabling a domain is deliberately a decision a person has to undo, so there
# has to be a way for a person to undo it.
# ---------------------------------------------------------------------------
echo "==> operator re-enable"
$LIMITS exec -T pagefetch node dist/src/cli.js status | sed 's/^/    /'
$LIMITS exec -T pagefetch node dist/src/cli.js enable disable-fixture | sed 's/^/    /'

REENABLED=$(curl -sS -X POST http://127.0.0.1:8790/fetch \
  -H "Authorization: Bearer $PAGEFETCH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"tool":"fetch_page","arguments":{"url":"http://disable-fixture:3000/plain?re-enabled"}}')

if echo "$REENABLED" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("code") == "ok" else 1)'; then
  echo "    pass: a re-enabled domain is fetchable again"
else
  echo "    FAIL: the domain was still refused after being re-enabled" >&2
  echo "$REENABLED" >&2
  exit 1
fi

echo
echo "all container tests passed"
