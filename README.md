# Bitcoin V2 Solo Pool

A self-hosted solo mining stack for Stratum V2 miners such as the Bitaxe:

- **Bitcoin Core 30** with its IPC mining interface, supplying block templates;
- **SRI `pool_sv2`**, the Stratum V2 reference pool, paying each block to the miner's
  own address;
- a **dashboard**: sync status, next block reward and odds, per-worker hashrate,
  payouts, individual shares and their difficulty, with lifetime history.

Everything runs in Docker Compose. Linux is the intended host; see
[Docker Desktop](#docker-desktop-windows-and-macos) for Windows and macOS.

## Quick start

```bash
git clone <this repository> && cd bitcoin-v2solo
cp .env.example .env        # then edit it: addresses, payout address, signature
```

### 1. Node

```bash
docker compose up --build -d bitcoin-node
docker compose logs -f bitcoin-node
```

Bitcoin Core keeps its data in the Docker volume `bitcoin-v2solo-data`: blocks,
chainstate, peers and the Unix IPC socket the pool uses. It runs pruned by default
(`BITCOIN_PRUNE_MIB`, about 20 GB of recent blocks), which is fully compatible with the
pool; turning pruning off later means downloading the chain again. The wallet is
disabled: the pool pays a solved block's coinbase straight to the payout address.

Compose gives Core up to 10 minutes to shut down. Stop it with
`docker compose stop bitcoin-node`, never by killing the container, or its databases
can be corrupted.

RPC (`8332`) is bound to `127.0.0.1` on the host and reachable only by the other
containers. Port `8333` takes Bitcoin peers; forwarding it from the internet gets you
inbound peers and new blocks sooner.

### 2. Pool keys

The pool proves its identity to miners with an SV2 authority key pair. Create it once,
outside the repository:

```bash
docker compose --profile tools build sv2-keygen
mkdir -p /opt/secrets && chmod 700 /opt/secrets
docker compose --profile tools run --rm -T sv2-keygen > /opt/secrets/pool.env
chmod 600 /opt/secrets/pool.env
grep PUBLIC /opt/secrets/pool.env      # the public key miners are given
```

Back up `pool.env`. Do not generate new keys once miners are configured: a new key
pair changes the public key every miner trusts.

### 3. Pool

Start the pool once the node has finished its initial sync
(`initialblockdownload` is `false`):

```bash
docker exec bitcoin-v2solo-node bitcoin-cli -datadir=/data getblockchaininfo
docker compose --profile pool up -d pool
docker compose logs -f pool
```

In AxeOS, add an SV2 pool: host `POOL_BIND_ADDRESS` (or the public address that reaches
it), port `3333`, the authority public key, and Extended Channels. Use your payout
address as the username, optionally followed by a worker name:
`bc1q….bitaxe-1`.

#### Who gets paid

Each miner's username decides the payout of the blocks it finds, so other people can
mine here to their own address. `POOL_PAYOUT_ADDRESS` is only the pool's address.
Verified on regtest with real blocks for the first and last rows:

| Username | Block reward |
| --- | --- |
| `<address>` or `<address>.<worker>` | 100% to that address |
| `sri/solo/<address>/<worker>` | 100% to that address |
| `sri/donate/<percent>/<address>/<worker>` | `<percent>` to the pool, the rest to the address |
| `sri/donate/<worker>`, or no valid address (for example a typo) | 100% to `POOL_PAYOUT_ADDRESS` |

A mistyped address silently pays the pool, so check the dashboard's Pool Workers panel:
each worker shows the address its blocks pay, and anything paying the pool is
highlighted.

### 4. Dashboard

```bash
docker compose --profile pool --profile dashboard up -d dashboard
```

Open `http://<DASHBOARD_BIND_ADDRESS>:8080`. It also listens on `127.0.0.1:8080` for a
reverse proxy on the same host, or for `tailscale serve --bg 8080`.

#### Sign-in

The dashboard requires sign-in (it shows payout addresses and worker details):

1. On first start it prints a one-time setup code to its log:
   `docker logs bitcoin-v2solo-dashboard 2>&1 | grep 'setup code'`.
   Enter it with a new password (10+ characters) on the login page. Without the code,
   whoever reaches a fresh install first cannot claim it.
2. Sessions last 30 days and survive restarts. Five failed attempts from one address
   lock it out for 15 minutes.
3. **Passkeys** (Face ID, Windows Hello, phones, security keys) can be added under
   Security once the dashboard is opened over **HTTPS with a domain name**: behind a
   reverse proxy, Tailscale Serve (`https://<host>.ts.net`) or a tunnel. Browsers do not
   allow passkeys on plain HTTP or IP addresses; the password works everywhere.
4. Forgot the password: `docker exec bitcoin-v2solo-dashboard node reset-password.js`
   removes it and signs everyone out (passkeys are kept); the dashboard then prints a
   new setup code.

Behind your own reverse proxy, set `DASHBOARD_TRUST_PROXY=1` so the dashboard uses the
proxy's `X-Forwarded-*` headers for rate limiting and secure cookies, but only if
clients cannot reach port 8080 directly. `DASHBOARD_AUTH=off` disables sign-in; use it
only where nothing untrusted can reach the dashboard.

Set `DASHBOARD_BITAXE_HOSTS` to the miners' IP addresses if the dashboard can reach
them, for temperature, error rate and clock settings.

## Network exposure

| Port | Service | Expose? |
| --- | --- | --- |
| 3333 | SV2 pool | To your miners. It can be public: SV2 connections are encrypted and authenticated by the authority key. |
| 8333 | Bitcoin P2P | Public is fine and helps block propagation |
| 8080 | Dashboard | Requires sign-in. Best behind HTTPS (reverse proxy or Tailscale Serve), which also enables passkeys |
| 8332, 9090 | Core RPC, pool monitoring | Never; bound to `127.0.0.1` |

A bind address chooses the interface, not who may connect: use the host or router
firewall to limit access. Docker-published ports bypass the host's `INPUT` chain, so
put such rules in `DOCKER-USER` or in the firewall in front of the host.

## Dashboard data

The dashboard keeps a SQLite database in the `bitcoin-v2solo-dashboard-data` volume
(`/var/lib/dashboard/history.db`), so worker totals survive pool restarts, miner
reconnects and dashboard rebuilds:

- lifetime accepted and rejected shares, total work, all-time best share and blocks
  found for each worker (by username);
- per-minute share work and best share per worker, kept 90 days
  (`/api/history?hours=24`);
- individual shares with their actual difficulty, kept 7 days (`/api/shares`);
- connect events (90 days) and blocks found (kept forever).

Individual shares come from the pool's log: the pool writes it to `/logs/pool.log` in
the `bitcoin-v2solo-pool-logs` volume, and each valid share's hash gives its difficulty
(difficulty-1 target ÷ hash). The dashboard empties the file once it has read past
50 MB. Docker's own container logs are capped at 5 × 20 MB per service.

Back the database up with a consistent copy while the dashboard runs:

```bash
docker run --rm -v bitcoin-v2solo-dashboard-data:/v alpine sh -c \
  "apk add -q sqlite && sqlite3 /v/history.db '.backup /v/history-backup.db'"
```

To value the next block reward, the dashboard fetches the BTC price from
`https://mempool.space/api/v1/prices` once an hour; this is its only request outside
your network. `DASHBOARD_FIAT` chooses the currency.

## Updating

Dashboard-only changes:

```bash
git pull && docker compose --profile pool --profile dashboard up -d --build --no-deps dashboard
```

Use the full `up -d --build` only when a change touches the node or the pool (the
compose files or Dockerfiles); it restarts them.

### Upgrading the pool image

`compose.yaml` pins `stratumv2/pool_sv2` by digest, so nothing changes until you choose
to. Don't follow `:main` (development builds, several a day). Watch
https://github.com/stratum-mining/sv2-apps/releases, then check a candidate first:

```bash
scripts/check-pool-image.sh stratumv2/pool_sv2:v0.9.0
```

It verifies the log lines the dashboard parses and, running the candidate against the
regtest node, every monitoring API field the dashboard reads, using the image's own
OpenAPI spec. `dashboard/pool-api.js` is the only code that reads raw pool responses, so
a renamed field is fixed there. After the check passes, test block submission on regtest
(below), then put the printed digest in the compose files and restart the pool.

## Testing the mining path

### regtest smoke test

`compose.regtest.yaml` runs a private regtest chain with its own pool on port `3335`.
Nearly every share is a block, so within seconds it shows whether the pool, the miner
and the payout work together. It has no peers, so it cannot prove the network would
accept a block; use testnet4 for that.

A fresh regtest node stays in initial block download until it has one block. Create a
wallet, mine that block, then set `REGTEST_PAYOUT_ADDRESS`:

```bash
docker compose -f compose.regtest.yaml up -d bitcoin-node
alias rcli='docker exec bitcoin-v2solo-regtest-node bitcoin-cli -regtest -datadir=/data'
rcli -named createwallet wallet_name=regtest-payout load_on_startup=true
rcli -rpcwallet=regtest-payout getnewaddress
rcli generatetoaddress 1 <bcrt1 address>
docker compose -f compose.regtest.yaml --profile pool up -d pool
```

Point a miner at port `3335` with the same authority public key and a `bcrt1` address
as its username, then check that blocks pay it:

```bash
rcli getblockchaininfo
rcli scantxoutset start '["addr(<bcrt1 address>)"]'
```

### testnet4 trial

`compose.testnet4.yaml` runs a separate testnet4 node, pool (port `3334`) and dashboard
(port `8081`), its own Compose project with its own volumes. testnet4 allows a
minimum-difficulty block after 20 minutes without one, so a single Bitaxe can find real
blocks, though other miners race for the same windows. Set `TESTNET4_PAYOUT_ADDRESS` in
`.env` to a `tb1` address first.

```bash
docker compose -f compose.testnet4.yaml up -d bitcoin-node
docker exec bitcoin-v2solo-testnet4-node bitcoin-cli -testnet4 -datadir=/data getblockchaininfo
docker compose -f compose.testnet4.yaml --profile pool --profile dashboard up -d
```

Once synced, point a miner at port `3334` with a `tb1` address as its username. When the
pool logs `Block Found`, confirm on mempool.space/testnet4 that the block is in the
chain, pays that address and carries your `POOL_SIGNATURE` followed by `testnet4`.

## Docker Desktop (Windows and macOS)

The stack runs under Docker Desktop too, with two differences:

- Keep Bitcoin Core's data in the named volume, as configured. Do not bind-mount a host
  folder instead: Docker Desktop's file sharing is slow for Core's databases and does
  not reliably make their writes durable (a bind-mounted node here once lost its block
  index on restart). To put the data on another drive, move Docker Desktop's disk image
  (Settings → Resources → Advanced → Disk image location).
- On Windows, run the shell commands above from Git Bash or WSL; PowerShell can corrupt
  binary pipes. Limit access to the published ports with a Windows Firewall block rule
  for remote addresses outside your LAN; block rules override Docker Desktop's own
  allow rules.

## License

MIT; see [LICENSE](LICENSE).
