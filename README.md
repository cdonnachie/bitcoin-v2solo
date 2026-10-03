# Bitcoin V2 Solo Pool

This stack runs an IPC-capable Bitcoin Core node plus an SRI Stratum V2 solo
pool for Bitaxe miners.

## Node data location

Bitcoin Core data lives in the Docker volume `bitcoin-v2solo-data`, inside
Docker Desktop's Linux disk image. Do not bind-mount a Windows folder instead:
Docker Desktop's Windows file sharing is slow for Bitcoin Core's databases and
does not reliably make their writes durable. An earlier bind-mounted node lost
its block index and chainstate on a restart.

To keep the node on `G:`, move Docker Desktop's disk image there once:
Docker Desktop → Settings → Resources → Advanced → Disk image location →
`G:\DockerDesktop`, then Apply & restart. This moves every container and
volume, and all of them are stopped while it copies.

Then start the node:

```powershell
Copy-Item .env.example .env
docker compose up --build -d bitcoin-node
docker compose logs -f bitcoin-node
```

The volume will contain the full blockchain, chainstate, peer data, and the
Unix IPC socket consumed by the Stratum V2 pool. Do not place wallet files
there; this configuration starts Bitcoin Core with `-disablewallet=1` because
the pool pays a solved block's coinbase directly to your address.

Compose gives Bitcoin Core up to 10 minutes to shut down cleanly. Stop it with
`docker compose stop bitcoin-node` rather than killing the container.

Bitcoin Core runs with automatic pruning enabled by default, retaining about
20 GB of recent block files plus chainstate and metadata. This remains fully
compatible with the Stratum V2 pool. A pruned node cannot serve historical
blocks or use `txindex`; disabling pruning later requires re-downloading the
blockchain.

Docker binds RPC to this PC only on port `8332`; do not expose it to the LAN.
Port `8333` accepts normal Bitcoin P2P peers.

## LAN-only access

The pool (`3333`) and dashboard (`8080`) listen on this PC's LAN address,
`10.0.0.185`. A bind address only chooses the listening interface; it does not
limit who may connect. To refuse anything outside `10.0.0.0/24`, add this
Windows Firewall rule once from an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Bitcoin V2 Solo: LAN only" `
	-Direction Inbound -Action Block -Protocol TCP `
	-LocalAddress 10.0.0.185 -LocalPort 3333,3334,3335,8080 `
	-RemoteAddress 0.0.0.0-9.255.255.255,10.0.1.0-255.255.255.255
```

Block rules override Docker Desktop's own allow rules, so this holds even if
port forwarding is later opened on the router.

## Pool setup

Before starting the pool, set `POOL_PAYOUT_ADDRESS` in `.env` to your mainnet
Bitcoin address and create its unique SV2 authority keys:

```powershell
New-Item -ItemType Directory -Force G:\bitcoin-v2solo\secrets
docker compose --profile tools run --rm sv2-keygen |
	Set-Content G:\bitcoin-v2solo\secrets\pool.env
```

The pool can run while Bitcoin Core syncs, but do not start the Bitaxes until
`initialblockdownload` is `false`:

```powershell
docker compose --profile pool up -d pool
docker compose logs -f pool
```

In AxeOS, create an SV2 pool entry with host `10.0.0.185`, port `3333`, and the
authority public key from `G:\bitcoin-v2solo\secrets\pool.env`. Set the miner
username to your payout address, optionally followed by `.bitaxe-1` or
`.bitaxe-2`. The username payout address takes precedence for solo rewards.

Do not run `sv2-keygen` again after configuring AxeOS. Generating new authority
keys changes the public key trusted by every miner; rotate it only when you
intend to update both Bitaxes.

## Mining dashboard

The dashboard is LAN-only and reports real Bitcoin Core synchronization, pool
channels and hashrate, plus configured Bitaxe status. Add the two Bitaxe IP
addresses to `DASHBOARD_BITAXE_HOSTS` in `.env`, separated by a comma, then run:

```powershell
docker compose --profile dashboard up -d dashboard
```

Open `http://10.0.0.185:8080` from a device on your private network.

For access from anywhere on your tailnet, the dashboard also listens on
`127.0.0.1:8080`, and Tailscale Serve publishes that over HTTPS (tailnet only):

```powershell
tailscale serve --bg 8080
tailscale serve status
```

This persists across reboots. Turn it off with `tailscale serve --https=443 off`.

To value the next block reward, the dashboard fetches the BTC price from
`https://mempool.space/api/v1/prices` once an hour; this is its only request
outside your network. Set `DASHBOARD_FIAT` in `.env` to choose the currency
(USD, EUR, GBP, CAD, CHF, AUD or JPY).

## testnet4 trial

`compose.testnet4.yaml` runs a separate testnet4 node and pool to prove the
whole path (template, share, block submission, broadcast, payout) before relying
on mainnet. It is its own Compose project with its own volume, so it cannot
affect the mainnet stack. testnet4 permits a minimum-difficulty block after 20
minutes without one, so a single Bitaxe can find real blocks.

Set `TESTNET4_PAYOUT_ADDRESS` in `.env` to a `tb1` address, then start it:

```powershell
docker compose -f compose.testnet4.yaml up -d bitcoin-node
docker compose -f compose.testnet4.yaml --profile pool up -d pool
```

Wait until the node's `initialblockdownload` is `false`:

```powershell
docker exec bitcoin-v2solo-testnet4-node bitcoin-cli -testnet4 -datadir=/data getblockchaininfo
```

Then point one Bitaxe at host `10.0.0.185`, port `3334`, with the same authority
public key as mainnet and the `tb1` payout address as its username. Watch for a
found block with:

```powershell
docker logs -f bitcoin-v2solo-testnet4-pool
```

Confirm the block on mempool.space/testnet4: it should be in the chain, pay the
`tb1` address, and carry the `Bitcoin V2 Solo testnet4` coinbase signature.
Afterwards, point the Bitaxe back at port `3333` with its mainnet username.

## regtest smoke test

`compose.regtest.yaml` runs a private regtest chain on port `3335`. Nearly every
share is a block, so within seconds it shows whether the pool, the Bitaxe and the
payout work together. It has no peers, so it cannot prove that the network would
accept a block; use the testnet4 trial for that.

A fresh regtest node stays in initial block download until it has one block.
Create a wallet, mine that block, then set `REGTEST_PAYOUT_ADDRESS`:

```powershell
docker compose -f compose.regtest.yaml up -d bitcoin-node
docker exec bitcoin-v2solo-regtest-node bitcoin-cli -regtest -datadir=/data -named createwallet wallet_name=regtest-payout load_on_startup=true
docker exec bitcoin-v2solo-regtest-node bitcoin-cli -regtest -datadir=/data -rpcwallet=regtest-payout getnewaddress
docker exec bitcoin-v2solo-regtest-node bitcoin-cli -regtest -datadir=/data generatetoaddress 1 <bcrt1 address>
docker compose -f compose.regtest.yaml --profile pool up -d pool
```

Point a Bitaxe at host `10.0.0.185`, port `3335`, with the mainnet authority
public key and the `bcrt1` address as its username. Check that blocks pay it:

```powershell
docker exec bitcoin-v2solo-regtest-node bitcoin-cli -regtest -datadir=/data getblockchaininfo
docker exec bitcoin-v2solo-regtest-node bitcoin-cli -regtest -datadir=/data -rpcwallet=regtest-payout getbalances
```

Coinbase rewards stay "immature" for 100 blocks, which shows they reached the
wallet.
