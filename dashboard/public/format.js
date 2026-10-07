// Formatting helpers shared by the console (app.js) and the worker page (worker.js).

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
  const amount = value * 100;
  if (amount >= 1 || amount === 0) return `${formatter.format(amount)}%`;
  // Fixed notation with three significant digits, e.g. 0.000000131% rather than 1.31e-7%.
  const decimals = Math.min(20, Math.max(2, 2 - Math.floor(Math.log10(amount))));
  return `${amount.toFixed(decimals)}%`;
}

function bytes(value) {
  return `${formatter.format((Number(value) || 0) / 1_000_000_000)} GB`;
}

function text(id, value) {
  byId(id).textContent = value;
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
