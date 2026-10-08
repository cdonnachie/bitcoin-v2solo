// Page for one pool worker: live status from the pool, lifetime totals and history from the
// dashboard's database. The worker's username comes from ?id=.
const identity = new URLSearchParams(location.search).get("id") || "";
const name = workerLabel(identity);
text("worker-name", name);
document.title = `${name} · Pool Worker`;

function ago(timestamp) {
  return timestamp ? `${duration((Date.now() - timestamp) / 1000)} ago` : "never";
}

let workerColor = SERIES_COLORS[0];

function renderWorker(data) {
  const { lifetime, channel, payout, events, shares, workers } = data;
  // The worker keeps the color it has on the console's pool chart.
  const color = workerColorFor(workers, identity);
  if (color !== workerColor) {
    workerColor = color;
    drawShares();
    drawHistory();
  }
  if (shares?.length) byId("w-shares-list").replaceChildren(...shares.map((share) => shareRow(share, false)));
  // The full payout address, so the worker's owner can check it character by character.
  const [pays, split] = payoutLabel(payout);
  text("worker-payout", payout?.address ? `${payout.mode === "pool" ? "Pays pool" : "Pays"} ${payout.address} · ${split}` : `${pays} · ${split}`);

  // Online while the pool has an open channel and shares keep arriving.
  const lastShare = channel?.last_share_at ? Date.parse(channel.last_share_at) : lifetime.last_share;
  const quiet = lastShare ? (Date.now() - lastShare) / 1000 : Infinity;
  const state = !channel ? "Offline" : quiet > 300 ? "Stalled" : "Online";
  text("w-status", state);
  byId("w-status").className = `status-${state.toLowerCase()}`;
  text("w-status-detail", `last share ${ago(lastShare)}`);

  const measured = channel?.measured_hashrate;
  text("w-hashrate", channel ? hashrate(measured ?? channel.nominal_hashrate) : "--");
  text("w-hashrate-detail", channel
    ? measured != null ? `measured over ${duration(channel.measured_window_secs)}` : "pool estimate; measured after a minute"
    : "not connected");

  const total = lifetime.accepted + lifetime.rejected;
  text("w-shares", formatter.format(lifetime.accepted));
  text("w-shares-detail", `${formatter.format(lifetime.rejected)} rejected (${total ? percent(lifetime.rejected / total) : "0%"})`);
  text("w-best", difficulty(Math.max(lifetime.best_diff, channel?.best_diff || 0)));
  text("w-best-detail", channel ? `all time · ${difficulty(channel.best_diff)} this connection` : "all time");
  text("w-blocks", formatter.format(lifetime.blocks));
  text("w-connects", formatter.format(lifetime.connects24h));
  text("w-first", new Date(lifetime.first_seen).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }));
  text("w-first-detail", ago(lifetime.first_seen));
  text("w-share-diff", channel?.target_hex ? difficulty(targetDifficulty(channel.target_hex)) : "--");

  text("w-event-count", `${events.length} recent`);
  const list = byId("w-events");
  if (!events.length) return;
  list.replaceChildren(...events.map((event) => {
    const row = document.createElement("div");
    row.className = `share-row event-row ${event.type === "block" ? "accepted" : ""}`;
    const cells = [
      ["span", new Date(event.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })],
      ["strong", event.type === "block" ? "BLOCK FOUND" : "CONNECTED"],
      ["span", event.type === "block" ? `pays ${shortAddress(event.detail?.address)}` : String(event.detail || "")],
      ["span", ago(event.ts)],
    ].map(([tag, value]) => Object.assign(document.createElement(tag), { textContent: value }));
    row.replaceChildren(...cells);
    return row;
  }));
}

async function refresh() {
  try {
    const response = await apiFetch(`/api/worker?id=${encodeURIComponent(identity)}`);
    if (response.status === 404) throw new Error("Unknown worker");
    if (!response.ok) throw new Error("Dashboard API is unavailable");
    renderWorker(await response.json());
    byId("connection-dot").className = "status-dot healthy";
    text("connection-label", "Live");
  } catch (error) {
    byId("connection-dot").className = "status-dot failed";
    text("connection-label", error.message);
  }
}

let historyHours = 24;
let historyData = null;

function drawHistory() {
  if (!historyData) return;
  const end = Date.now();
  const { series, buckets } = chartData(historyData, identity);
  renderTimeChart(byId("history-chart"), {
    series,
    buckets,
    bucketMs: historyData.bucketMs,
    start: end - historyHours * 3600_000,
    end,
    stacked: false,
    format: hashrate,
  });
}

async function loadHistory() {
  try {
    const response = await apiFetch(`/api/history?hours=${historyHours}&worker=${encodeURIComponent(identity)}`);
    if (!response.ok) return;
    historyData = await response.json();
    drawHistory();
  } catch {
    // Keep the last chart; the next refresh retries.
  }
}

for (const button of byId("history-range").querySelectorAll("button")) {
  button.addEventListener("click", () => {
    historyHours = Number(button.dataset.hours);
    for (const other of byId("history-range").querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === button));
    loadHistory();
  });
}

// Individual shares on a log scale, reloaded every minute.
let sharesHours = 24;
let sharesData = null;

function drawShares() {
  if (!sharesData) return;
  const end = Date.now();
  renderShareScatter(byId("shares-chart"), { shares: sharesData, start: end - sharesHours * 3600_000, end, color: workerColor, format: difficulty });
}

async function loadShares() {
  try {
    const response = await apiFetch(`/api/shares?hours=${sharesHours}&worker=${encodeURIComponent(identity)}`);
    if (!response.ok) return;
    sharesData = (await response.json()).shares;
    drawShares();
  } catch {
    // Keep the last chart; the next refresh retries.
  }
}

for (const button of byId("shares-range").querySelectorAll("button")) {
  button.addEventListener("click", () => {
    sharesHours = Number(button.dataset.hours);
    for (const other of byId("shares-range").querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === button));
    loadShares();
  });
}

responsiveChart(byId("shares-chart"), drawShares);
loadShares();
setInterval(loadShares, 60_000);

responsiveChart(byId("history-chart"), drawHistory);
refresh();
loadHistory();
setInterval(refresh, 10_000);
setInterval(loadHistory, 60_000);

// Hide the Security link when sign-in is turned off (DASHBOARD_AUTH=off).
fetch("/api/auth/state").then((response) => response.json()).then((state) => {
  if (state.disabled) byId("security-link").hidden = true;
}).catch(() => {});
