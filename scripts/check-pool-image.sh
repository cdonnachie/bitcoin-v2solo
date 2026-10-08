#!/usr/bin/env bash
# Checks a candidate pool_sv2 image against everything the dashboard depends on, before
# switching compose.yaml to it:
#   1. the log lines dashboard/sharelog.js parses (share hashes, rejected shares);
#   2. every monitoring API field dashboard/pool-api.js reads, using the image's own
#      OpenAPI spec, served by the candidate while it runs against the regtest node.
# It does not test block submission; for that, point a miner at the regtest pool (README).
#
# Usage: scripts/check-pool-image.sh stratumv2/pool_sv2:<tag>|stratumv2/pool_sv2@sha256:<digest>
set -euo pipefail

image=${1:?usage: $0 <pool image>}
cd "$(dirname "$0")/.."
export POOL_IMAGE=$image
# Interpolation needs a regtest payout address; no blocks are mined during the check.
export REGTEST_PAYOUT_ADDRESS=${REGTEST_PAYOUT_ADDRESS:-bcrt1qtv3skpksr6eu54n3t6584txga4h56cpnhceuph}
compose=(docker compose -f compose.regtest.yaml --profile pool)
container=pool-image-check
failures=0
pass() { echo "  PASS $1"; }
fail() { echo "  FAIL $1"; failures=$((failures + 1)); }

echo "Pulling $image"
docker pull -q "$image" >/dev/null
digest=$(docker image inspect "$image" --format '{{index .RepoDigests 0}}')
echo "  $(docker run --rm --entrypoint /app/pool_sv2 "$image" --version) — $digest"

echo "Log lines parsed by dashboard/sharelog.js"
for marker in "valid share | downstream_id: " ", channel_id: " ", sequence_number: " ", share_hash: " \
  ", share_work: " "SubmitSharesError: downstream_id: " ", error_code: "; do
  if docker run --rm --entrypoint sh "$image" -c "grep -aqF -- '$marker' /app/pool_sv2"; then
    pass "contains \"$marker\""
  else
    fail "missing \"$marker\" — the share log format changed; update dashboard/sharelog.js"
  fi
done

# compose.yaml starts the pool with --log-file so the dashboard can read the log.
if docker run --rm --entrypoint /app/pool_sv2 "$image" --help 2>&1 | grep -qF -- "--log-file"; then
  pass "supports --log-file"
else
  fail "no --log-file option — the pool entrypoint in compose.yaml needs another way to write its log"
fi

echo "Monitoring API fields read by dashboard/pool-api.js"
node_was_running=$(docker ps -q --filter name=bitcoin-v2solo-regtest-node)
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  [ -n "$node_was_running" ] || "${compose[@]}" stop bitcoin-node >/dev/null 2>&1 || true
}
trap cleanup EXIT
"${compose[@]}" up -d bitcoin-node >/dev/null 2>&1
for _ in $(seq 1 30); do
  docker exec bitcoin-v2solo-regtest-node test -S /data/regtest/node.sock 2>/dev/null && break
  sleep 2
done
"${compose[@]}" run -d --rm --no-deps --name "$container" pool >/dev/null 2>&1

if docker run --rm --network "container:$container" -v "$PWD/dashboard:/dashboard:ro" node:22-alpine node -e '
  const { checkContract, normalizeGlobal } = require("/dashboard/pool-api.js");
  const get = async (path) => (await fetch(`http://127.0.0.1:9090${path}`)).json();
  (async () => {
    let spec;
    for (let i = 0; i < 30 && !spec; i++) {
      spec = await get("/api-docs/openapi.json").catch(() => null);
      if (!spec) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!spec) { console.log("  the candidate pool never served its monitoring API"); process.exit(1); }
    const problems = checkContract(spec);
    for (const problem of problems) console.log(`  FIELD ${problem}`);
    const global = normalizeGlobal(await get("/api/v1/global"));
    console.log(`  live /api/v1/global normalizes to ${JSON.stringify(global)}`);
    process.exit(problems.length ? 1 : 0);
  })();
'; then
  pass "all fields present with the expected types"
else
  fail "monitoring API differs — map the changes in dashboard/pool-api.js"
  docker logs "$container" 2>&1 | tail -5 | sed 's/^/    /'
fi

if [ "$failures" -eq 0 ]; then
  echo "OK: safe for the dashboard. Next, test block submission on regtest, then set"
  echo "    image: $digest"
  echo "in compose.yaml (and compose.testnet4.yaml, compose.regtest.yaml)."
else
  echo "NOT READY: $failures check(s) failed."
  exit 1
fi
