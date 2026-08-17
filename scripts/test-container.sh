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
NEIGHBOUR="${PAGEFETCH_NEIGHBOUR_CONTAINER:-tnl-dashboard-postgres-1}"
NEIGHBOUR_PORT="${PAGEFETCH_NEIGHBOUR_PORT:-5432}"

if [[ ! -f .env ]]; then
  echo "no .env — copy .env.example, and put a real token in it" >&2
  exit 1
fi

# -v so every run starts from a cold cache and a cold profile. Scoped to the
# pagefetch-test project by the -p above.
cleanup() { $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true; }
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
echo "==> behavioural suite"
npm run build >/dev/null
set -a; source .env; set +a
# Unquoted on purpose: the shell expands it. Node 20 cannot glob, Node 22+ can,
# and this works the same on both.
# shellcheck disable=SC2086
PAGEFETCH_URL="http://127.0.0.1:8790" node --test dist/test/container/*.test.js

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

echo
echo "all container tests passed"
