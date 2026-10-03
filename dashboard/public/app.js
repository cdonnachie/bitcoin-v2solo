const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function byId(id) {
  return document.getElementById(id);
}

function duration(seconds) {
  const units = [[86400, "d"], [3600, "h"], [60, "m"]];
  for (const [size, label] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${label}`;
  }
  return `${Math.floor(seconds)}s`;
}

function hashrate(value) {
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s"];
  let index = 0;
  let rate = Math.max(0, Number(value) || 0);
  while (rate >= 1000 && index < units.length - 1) {
    rate /= 1000;
    index += 1;
  }
  return `${formatter.format(rate)} ${units[index]}`;
}

function difficulty(value) {
  const units = ["", "K", "M", "G", "T", "P", "E"];
  let index = 0;
  let amount = Math.max(0, Number(value) || 0);
  while (amount >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index += 1;
  }
  return `${formatter.format(amount)}${units[index]}`;
}

// Difficulty 1 corresponds to this target; a share's difficulty is that divided by its target.
const DIFFICULTY_1_TARGET = 0xffffn << 208n;

function targetDifficulty(targetHex) {
  const target = BigInt(`0x${targetHex}`);
  return target ? Number(DIFFICULTY_1_TARGET * 1000n / target) / 1000 : 0;
}

function percent(value) {
  if (value >= 1) return `${formatter.format(value * 100)}%`;
  return `${(value * 100).toPrecision(3)}%`;
}

function bytes(value) {
  return `${formatter.format((Number(value) || 0) / 1_000_000_000)} GB`;
}

function text(id, value) {
  byId(id).textContent = value;
}

function renderMiners(bitaxes) {
  const miners = byId("miners");
  text("miner-count", `${bitaxes.length} configured`);
  if (!bitaxes.length) return;

  miners.replaceChildren(...bitaxes.map((miner) => {
    const card = document.createElement("article");
    card.className = `miner ${miner.online ? "online" : "offline"}`;
    const info = miner.info || {};
    // AxeOS reports hashRate in GH/s; hashrate() expects H/s.
    const rate = (info.hashRate || info.hashrate || 0) * 1e9;
    const temperature = info.temp || info.temperature || "--";
    const accepted = formatter.format(Number(info.sharesAccepted || 0));
    const rejected = formatter.format(Number(info.sharesRejected || 0));
    const pending = formatter.format(Number(info.sharesPending || 0));
    card.innerHTML = `
      <div class="miner-top"><strong>${miner.host}</strong><span>${miner.online ? "ONLINE" : "OFFLINE"}</span></div>
      <div class="miner-rate">${miner.online ? hashrate(rate) : "Unavailable"}</div>
      <div class="miner-meta"><span>${info.model || info.asicModel || "Bitaxe"}</span><span>${miner.online ? `${temperature} C` : miner.error}</span></div>
      ${miner.online ? `<div class="miner-shares"><span>A ${accepted}</span><span>R ${rejected}</span><span>P ${pending}</span></div>` : ""}
      ${miner.online ? `<div class="miner-best"><span>Best ${difficulty(info.bestSessionDiff)} session</span><span>${difficulty(info.bestDiff)} all-time</span></div>` : ""}
      ${miner.online ? `<div class="miner-best"><span>Errors ${formatter.format(Number(info.errorPercentage) || 0)}%</span><span>${info.frequency ?? "--"} MHz @ ${info.coreVoltage ?? "--"} mV</span></div>` : ""}`;
    return card;
  }));
}

function shortAddress(address) {
  return address && address.length > 20 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address || "--";
}

function payoutLabel(payout) {
  if (!payout) return ["--", ""];
  if (payout.mode === "miner") return [`Pays ${shortAddress(payout.address)}`, "100% to miner"];
  if (payout.mode === "split") return [`Pays ${shortAddress(payout.address)}`, `${payout.minerPercent}% miner · ${payout.poolPercent}% pool`];
  if (payout.mode === "pool") return [`Pays pool ${shortAddress(payout.address)}`, payout.reason];
  return ["Rejected", payout.reason];
}

function renderWorkers(channels) {
  text("worker-count", `${channels.length} channel${channels.length === 1 ? "" : "s"}`);
  const workers = byId("workers");
  if (!channels.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No miners are connected to this pool.";
    workers.replaceChildren(empty);
    return;
  }

  workers.replaceChildren(...channels.map((channel) => {
    const row = document.createElement("div");
    const payout = channel.payout || {};
    row.className = `worker-row ${payout.mode || ""}`;
    const user = String(channel.user_identity || "");
    const worker = user.includes(".") ? user.slice(user.lastIndexOf(".") + 1) : user.split("/").pop() || `channel ${channel.channel_id}`;
    const [pays, detail] = payoutLabel(channel.payout);
    const cells = [
      ["strong", worker, user],
      ["span", pays, payout.address || ""],
      ["span", detail, ""],
      ["span", hashrate(channel.nominal_hashrate), ""],
      ["span", `A ${formatter.format(channel.shares_accepted || 0)} · R ${formatter.format(channel.shares_rejected || 0)}`, ""],
      ["span", `Best ${difficulty(channel.best_diff)}`, ""],
    ].map(([tag, value, title]) => {
      const cell = document.createElement(tag);
      cell.textContent = value;
      if (title) cell.title = title;
      return cell;
    });
    row.replaceChildren(...cells);
    return row;
  }));
}

function renderShareEvents(shares) {
  text("shares-accepted", formatter.format(shares.accepted));
  text("shares-rejected", formatter.format(shares.rejected));
  const ledger = byId("share-events");
  if (!shares.events.length) return;

  ledger.replaceChildren(...shares.events.map((event) => {
    const row = document.createElement("div");
    row.className = `share-row ${event.type}`;
    // Show the worker suffix of "address.worker"; the full identity is in the tooltip.
    const user = String(event.user || "");
    const worker = user.includes(".") ? user.slice(user.lastIndexOf(".") + 1) : user || `channel ${event.channelId}`;
    const cells = [
      ["span", new Date(event.timestamp).toLocaleTimeString()],
      ["strong", event.type.toUpperCase()],
      ["span", worker],
      ["span", `${event.count} share${event.count === 1 ? "" : "s"}`],
    ].map(([tag, value]) => {
      const cell = document.createElement(tag);
      cell.textContent = value;
      return cell;
    });
    cells[2].title = user;
    row.replaceChildren(...cells);
    return row;
  }));
}

function expectedTime(seconds) {
  const year = 365.25 * 86400;
  if (seconds >= year) return `${difficulty(seconds / year)} years`;
  return seconds < 1 ? "<1s" : duration(seconds);
}

// A block takes difficulty * 2^32 hashes on average, so at a steady hashrate the
// chance of at least one block in a day is 1 - e^(-day / expected time).
function blockOdds(target, rate) {
  if (!target || !rate) return "Connect miners to see block odds";
  const expectedSeconds = (target * 2 ** 32) / rate;
  const perDay = -Math.expm1(-86400 / expectedSeconds);
  const daily = perDay >= 0.5 ? `${percent(perDay)} per day` : `1 in ${difficulty(1 / perDay)} per day`;
  return `${daily} · expect ${expectedTime(expectedSeconds)} at ${hashrate(rate)}`;
}

function btc(sats) {
  return (Number(sats) / 1e8).toFixed(8).replace(/\.?0+$/, "");
}

function money(value, currency) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${formatter.format(value)} ${currency}`;
  }
}

function fiatText(reward, price) {
  if (!reward) return " ";
  if (!price) return "BTC price unavailable";
  const value = (reward.coinbaseValue / 1e8) * price.value;
  const updated = new Date(price.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `≈ ${money(value, price.currency)} ${price.currency} at ${money(price.value, price.currency)}/BTC · ${price.source}, ${updated}`;
}

function renderReward(reward, price) {
  text("reward-fiat", fiatText(reward, price));
  text("reward-total", reward ? `${btc(reward.coinbaseValue)} BTC` : "--");
  text("reward-subsidy", reward ? `${btc(reward.subsidy)} BTC` : "--");
  text("reward-fees", reward ? `${btc(reward.fees)} BTC` : "--");
  text("reward-transactions", reward ? formatter.format(reward.transactions) : "--");
  text("reward-height", reward ? formatter.format(reward.height) : "--");
}

function renderTarget(mining, blockchain, channels, chain) {
  const best = Math.max(0, ...channels.map((channel) => Number(channel.best_diff) || 0));
  const target = Number(mining?.next?.difficulty ?? mining?.difficulty) || 0;
  const shareTargets = channels.map((channel) => targetDifficulty(channel.target_hex)).filter(Boolean);
  text("best-share", channels.length ? difficulty(best) : "--");
  text("block-target", target ? difficulty(target) : "--");
  text("best-progress", target && channels.length ? percent(best / target) : "--");
  text("share-difficulty", shareTargets.length ? difficulty(Math.min(...shareTargets)) : "--");

  let detail = mining?.next ? `next block, height ${formatter.format(mining.next.height)}` : "next block difficulty";
  if (chain === "testnet4" && blockchain.time) {
    // testnet4 allows a difficulty-1 block once 20 minutes pass without one.
    const minutes = Math.max(0, Math.floor((Date.now() / 1000 - blockchain.time) / 60));
    detail = `${minutes}m since last block; drops to 1 at 20m`;
  }
  text("block-target-detail", detail);
}

function render(status) {
  const blockchain = status.blockchain || { verificationprogress: 0, initialblockdownload: true, blocks: 0, headers: 0, size_on_disk: 0, difficulty: 0 };
  const network = status.network || { connections: 0, networkactive: false };
  const pool = status.pool || { sv2_clients: { total_clients: 0, total_channels: 0, total_hashrate: 0 }, uptime_secs: 0 };
  const shares = status.shares || { accepted: 0, rejected: 0, events: [] };
  const { bitaxes, updatedAt } = status;
  if (status.chain && status.chain !== "mainnet") {
    const chain = status.chain.toUpperCase();
    text("chain-label", `PRIVATE STRATUM V2 POOL · ${chain}`);
    document.title = `Solo Mining Console (${chain})`;
  }
  const sync = Math.min(1, Number(blockchain.verificationprogress) || 0);
  const syncing = blockchain.initialblockdownload;
  text("sync-percent", `${(sync * 100).toFixed(3)}%`);
  text("sync-detail", syncing ? "Initial block download in progress" : "Fully synchronized and ready to mine");
  byId("sync-progress").style.width = `${Math.max(sync * 100, 0.4)}%`;
  text("pool-clients", pool.sv2_clients.total_clients);
  text("pool-channels", `${pool.sv2_clients.total_channels} channels`);
  text("pool-hashrate", hashrate(pool.sv2_clients.total_hashrate));
  text("core-peers", network.connections);
  text("core-network", network.networkactive ? "P2P active" : "P2P disabled");
  text("pool-uptime", duration(pool.uptime_secs));
  text("block-height", formatter.format(blockchain.blocks));
  text("header-height", formatter.format(blockchain.headers));
  text("disk-usage", bytes(blockchain.size_on_disk));
  text("difficulty", formatter.format(blockchain.difficulty));
  text("updated-at", `Updated ${new Date(updatedAt).toLocaleTimeString()}`);
  renderTarget(status.mining, blockchain, shares.channels || [], status.chain);
  renderReward(status.reward, status.price);
  const target = Number(status.mining?.next?.difficulty ?? status.mining?.difficulty) || 0;
  text("reward-odds", blockOdds(target, Number(pool.sv2_clients.total_hashrate) || 0));
  renderShareEvents(shares);
  renderWorkers(shares.channels || []);
  renderMiners(bitaxes);
  return status.errors || [];
}

async function refresh() {
  const button = byId("refresh");
  button.disabled = true;
  try {
    const response = await fetch("/api/status");
    if (!response.ok) throw new Error("Dashboard API is unavailable");
    const errors = render(await response.json());
    byId("connection-dot").className = errors.length ? "status-dot" : "status-dot healthy";
    text("connection-label", errors.length ? "Partial data" : "Live");
  } catch (error) {
    byId("connection-dot").className = "status-dot failed";
    text("connection-label", error.message);
  } finally {
    button.disabled = false;
  }
}

byId("refresh").addEventListener("click", refresh);
refresh();
setInterval(refresh, 10_000);