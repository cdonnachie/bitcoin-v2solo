const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const port = Number(process.env.PORT || 8080);
const publicDirectory = path.join(__dirname, "public");
const bitaxeHosts = (process.env.DASHBOARD_BITAXE_HOSTS || "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
// Bitcoin Core's default RPC port and cookie location for each supported chain.
const chains = {
  mainnet: { rpcPort: 8332, cookieFile: "/data/.cookie" },
  testnet4: { rpcPort: 48332, cookieFile: "/data/testnet4/.cookie" },
  regtest: { rpcPort: 18443, cookieFile: "/data/regtest/.cookie" },
};
const networkName = process.env.DASHBOARD_NETWORK || "mainnet";
const chain = chains[networkName];
if (!chain) throw new Error(`Unsupported DASHBOARD_NETWORK: ${networkName}`);
const shareSnapshots = new Map();
const shareEvents = [];

function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(options, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Response was not valid JSON"));
        }
      });
    });

    request.setTimeout(5_000, () => request.destroy(new Error("Request timed out")));
    request.on("error", reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

async function bitcoinRpc(method, params = []) {
  const cookie = (await fs.readFile(chain.cookieFile, "utf8")).trim();
  const authorization = Buffer.from(cookie).toString("base64");
  const response = await requestJson(
    {
      host: "bitcoin-node",
      port: chain.rpcPort,
      path: "/",
      method: "POST",
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/json",
      },
    },
    { jsonrpc: "1.0", id: "dashboard", method, params },
  );

  if (response.error) throw new Error(response.error.message);
  return response.result;
}

function bitaxeStatus(host) {
  return requestJson({ host, port: 80, path: "/api/system/info", method: "GET" })
    .then((info) => ({
      host,
      online: true,
      info: {
        model: `Bitaxe ${info.boardVersion || ""}`.trim(),
        asicModel: info.ASICModel,
        hashRate: info.hashRate,
        temp: info.temp,
        sharesAccepted: info.sharesAccepted,
        sharesRejected: info.sharesRejected,
        sharesPending: info.sharesPending,
        bestDiff: info.bestDiff,
        bestSessionDiff: info.bestSessionDiff,
        errorPercentage: info.errorPercentage,
        frequency: info.frequency,
        coreVoltage: info.coreVoltage,
      },
    }))
    .catch((error) => ({ host, online: false, error: error.message }));
}

function recordShareEvent(channel, type, count) {
  shareEvents.unshift({
    channelId: channel.channel_id,
    user: channel.user_identity || "unknown worker",
    type,
    count,
    timestamp: new Date().toISOString(),
  });
  shareEvents.length = Math.min(shareEvents.length, 30);
}

async function shareActivity() {
  const clients = await requestJson({ host: "pool", port: 9090, path: "/api/v1/clients?limit=100", method: "GET" });
  const channelResponses = await Promise.all(clients.items.map(async (client) => {
    const channels = await requestJson({
      host: "pool",
      port: 9090,
      path: `/api/v1/clients/${client.client_id}/channels?limit=100`,
      method: "GET",
    });
    return [...channels.extended_channels, ...channels.standard_channels];
  }));
  const channels = channelResponses.flat();
  const activeKeys = new Set();
  let accepted = 0;
  let rejected = 0;

  for (const channel of channels) {
    const key = `${channel.channel_id}:${channel.user_identity}`;
    const previous = shareSnapshots.get(key);
    const acceptedNow = Number(channel.shares_accepted || 0);
    const rejectedNow = Number(channel.shares_rejected || 0);
    accepted += acceptedNow;
    rejected += rejectedNow;
    activeKeys.add(key);

    if (previous) {
      if (acceptedNow > previous.accepted) recordShareEvent(channel, "accepted", acceptedNow - previous.accepted);
      if (rejectedNow > previous.rejected) recordShareEvent(channel, "rejected", rejectedNow - previous.rejected);
    }
    shareSnapshots.set(key, { accepted: acceptedNow, rejected: rejectedNow });
  }

  for (const key of shareSnapshots.keys()) {
    if (!activeKeys.has(key)) shareSnapshots.delete(key);
  }

  return { accepted, rejected, channels, events: shareEvents };
}

// Building a block template is real work for Core, so reuse the summary for 30 seconds,
// unless a new block has arrived since it was built.
let rewardCache = { at: 0, tip: null, value: null };

async function blockReward() {
  const tip = await bitcoinRpc("getbestblockhash");
  if (rewardCache.value && rewardCache.tip === tip && Date.now() - rewardCache.at < 30_000) return rewardCache.value;
  const template = await bitcoinRpc("getblocktemplate", [{ rules: ["segwit"] }]);
  const fees = template.transactions.reduce((sum, transaction) => sum + transaction.fee, 0);
  const value = {
    height: template.height,
    coinbaseValue: template.coinbasevalue,
    fees,
    subsidy: template.coinbasevalue - fees,
    transactions: template.transactions.length,
  };
  rewardCache = { at: Date.now(), tip: template.previousblockhash, value };
  return value;
}

// BTC price for valuing the block reward. Fetched hourly from mempool.space (no API key);
// on failure the last price is kept and the fetch is retried after 10 minutes.
const fiat = (process.env.DASHBOARD_FIAT || "USD").toUpperCase();
let price = null;
let priceNextFetch = 0;

async function refreshPrice() {
  if (Date.now() < priceNextFetch) return;
  priceNextFetch = Date.now() + 10 * 60_000;
  try {
    const response = await fetch("https://mempool.space/api/v1/prices", { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const prices = await response.json();
    if (!Number.isFinite(prices[fiat])) throw new Error(`no ${fiat} price in response`);
    price = { currency: fiat, value: prices[fiat], time: prices.time * 1000, source: "mempool.space" };
    priceNextFetch = Date.now() + 60 * 60_000;
  } catch (error) {
    console.warn(`BTC price fetch failed: ${error.message}`);
  }
}

refreshPrice();
setInterval(refreshPrice, 60_000);

// Sample share counters on a fixed timer, so each interval yields one event per
// channel no matter how many browsers are polling the dashboard.
let latestShares = { error: "Local SV2 share activity: waiting for first sample" };

async function sampleShares() {
  try {
    latestShares = { value: await shareActivity() };
  } catch (error) {
    latestShares = { error: `Local SV2 share activity: ${error.message}` };
  }
}

sampleShares();
setInterval(sampleShares, 10_000);

async function capture(name, operation) {
  try {
    return { value: await operation() };
  } catch (error) {
    return { error: `${name}: ${error.message}` };
  }
}

async function status() {
  const [blockchain, mining, reward, network, pool, health, bitaxes, shares] = await Promise.all([
    capture("Bitcoin Core blockchain", () => bitcoinRpc("getblockchaininfo")),
    capture("Bitcoin Core mining", () => bitcoinRpc("getmininginfo")),
    capture("Bitcoin Core block template", blockReward),
    capture("Bitcoin Core network", () => bitcoinRpc("getnetworkinfo")),
    capture("Pool statistics", () => requestJson({ host: "pool", port: 9090, path: "/api/v1/global", method: "GET" })),
    capture("Pool health", () => requestJson({ host: "pool", port: 9090, path: "/api/v1/health", method: "GET" })),
    capture("Bitaxe fleet", () => Promise.all(bitaxeHosts.map(bitaxeStatus))),
    latestShares,
  ]);

  const results = [blockchain, mining, reward, network, pool, health, bitaxes, shares];
  return {
    chain: networkName,
    blockchain: blockchain.value || null,
    network: network.value || null,
    mining: mining.value || null,
    reward: reward.value || null,
    price,
    pool: pool.value || null,
    health: health.value || null,
    bitaxes: bitaxes.value || [],
    shares: shares.value || { accepted: 0, rejected: 0, channels: [], events: [] },
    errors: results.flatMap((result) => result.error ? [result.error] : []),
    updatedAt: new Date().toISOString(),
  };
}

function contentType(file) {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/api/status") {
    const payload = await status();
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(payload));
    return;
  }

  const requestedPath = request.url === "/" ? "index.html" : request.url.slice(1);
  const safePath = path.normalize(requestedPath).replace(/^\.\.[/\\]/, "");
  const file = path.join(publicDirectory, safePath);

  try {
    const content = await fs.readFile(file);
    response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Mining dashboard (${networkName}) listening on port ${port}`);
});