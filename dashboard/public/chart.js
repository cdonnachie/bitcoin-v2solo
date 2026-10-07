// Dependency-free SVG time charts: a stacked area (pool hashrate by worker) and a single line
// (one worker), with gridlines, a crosshair tooltip, a legend and a table view.

// Categorical slots in fixed order, validated for the dark panel surface #172019 with the
// dataviz skill's validate_palette.js (all checks pass; worst adjacent CVD ΔE 8.4).
const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const SURFACE = "#172019";
const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function niceStep(max, count) {
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((step) => step >= raw);
}

function timeTicks(start, end) {
  const hour = 3600_000;
  const steps = [hour, 2 * hour, 3 * hour, 4 * hour, 6 * hour, 12 * hour, 24 * hour, 2 * 24 * hour, 7 * 24 * hour];
  const step = steps.find((candidate) => (end - start) / candidate <= 7) || steps.at(-1);
  // Align ticks to local midnight so daily ticks land on dates.
  const midnight = new Date(start);
  midnight.setHours(0, 0, 0, 0);
  const ticks = [];
  for (let t = midnight.getTime(); t <= end; t += step) if (t >= start) ticks.push(t);
  return { ticks, daily: step >= 24 * hour };
}

function timeLabel(t, daily) {
  const date = new Date(t);
  return daily
    ? date.toLocaleDateString([], { month: "short", day: "numeric" })
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// series: [{ id, label, color }]; buckets: [{ start, values: { [id]: number } }] sorted by start.
function renderTimeChart(container, { series, buckets, bucketMs, start, end, stacked, format }) {
  container.replaceChildren();
  container.classList.add("chart");
  if (!buckets.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No history yet. Charts fill in as the dashboard records shares.";
    container.append(empty);
    return;
  }

  if (series.length > 1) {
    const legend = document.createElement("div");
    legend.className = "chart-legend";
    for (const item of series) {
      const entry = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.background = item.color;
      entry.append(swatch, item.label);
      legend.append(entry);
    }
    container.append(legend);
  }

  const width = Math.max(320, container.clientWidth);
  const height = 240;
  const margin = { top: 12, right: 12, bottom: 28, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  // Cumulative tops per bucket for stacking; plain values for a single line.
  const rows = buckets.map((bucket) => {
    let total = 0;
    const tops = {};
    for (const item of series) {
      total = (stacked ? total : 0) + (bucket.values[item.id] || 0);
      tops[item.id] = total;
    }
    return { ...bucket, tops, total: stacked ? total : Math.max(0, ...Object.values(tops)) };
  });
  const step = niceStep(Math.max(...rows.map((row) => row.total), 1) * 1.05, 4);
  const yMax = Math.ceil((Math.max(...rows.map((row) => row.total), 1) * 1.05) / step) * step;
  // Points sit at bucket midpoints, clamped to now so the bucket in progress stays in the plot.
  const x = (t) => margin.left + ((Math.min(t + bucketMs / 2, end) - start) / (end - start)) * plotWidth;
  const y = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;

  const chart = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img" });
  chart.setAttribute("aria-label", stacked ? "Pool hashrate by worker over time" : "Hashrate over time");

  // Recessive hairline grid with clean y ticks; one stronger baseline.
  for (let value = 0; value <= yMax + step / 2; value += step) {
    chart.append(svg("line", { x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value), class: value === 0 ? "chart-baseline" : "chart-grid" }));
    const label = svg("text", { x: margin.left - 8, y: y(value) + 4, class: "chart-axis", "text-anchor": "end" });
    label.textContent = format(value);
    chart.append(label);
  }
  const { ticks, daily } = timeTicks(start, end);
  for (const t of ticks) {
    const tx = margin.left + ((t - start) / (end - start)) * plotWidth;
    const label = svg("text", { x: tx, y: height - 8, class: "chart-axis", "text-anchor": "middle" });
    label.textContent = timeLabel(t, daily);
    chart.append(label);
  }

  // Split into contiguous runs: a missing bucket (dashboard not sampling) is drawn as a gap.
  const runs = [];
  for (const row of rows) {
    const run = runs.at(-1);
    if (run && row.start - run.at(-1).start <= bucketMs) run.push(row);
    else runs.push([row]);
  }

  series.forEach((item, index) => {
    for (const run of runs) {
      const upper = run.map((row) => `${x(row.start)},${y(row.tops[item.id])}`);
      if (stacked) {
        const below = index ? series[index - 1].id : null;
        const lower = run.map((row) => `${x(row.start)},${y(below ? row.tops[below] : 0)}`).reverse();
        chart.append(svg("polygon", { points: [...upper, ...lower].join(" "), fill: item.color, class: "chart-area" }));
        // A 2px surface-colored edge separates each band from the one above it.
        chart.append(svg("polyline", { points: upper.join(" "), stroke: SURFACE, class: "chart-gap" }));
      } else {
        chart.append(svg("polyline", { points: upper.join(" "), stroke: item.color, class: "chart-line" }));
      }
    }
  });

  // Crosshair, markers and tooltip follow the nearest bucket.
  const crosshair = svg("line", { y1: margin.top, y2: margin.top + plotHeight, class: "chart-crosshair", visibility: "hidden" });
  const markers = series.map((item) => svg("circle", { r: 4, fill: item.color, stroke: SURFACE, "stroke-width": 2, visibility: "hidden" }));
  chart.append(crosshair, ...markers);
  const hit = svg("rect", { x: margin.left, y: margin.top, width: plotWidth, height: plotHeight, fill: "transparent" });
  chart.append(hit);
  container.append(chart);

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;
  container.append(tooltip);

  const hide = () => {
    tooltip.hidden = true;
    crosshair.setAttribute("visibility", "hidden");
    for (const marker of markers) marker.setAttribute("visibility", "hidden");
  };
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("pointermove", (event) => {
    const bounds = chart.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    const row = rows.reduce((best, candidate) => (Math.abs(x(candidate.start) - px) < Math.abs(x(best.start) - px) ? candidate : best));
    const cx = x(row.start);
    crosshair.setAttribute("x1", cx);
    crosshair.setAttribute("x2", cx);
    crosshair.setAttribute("visibility", "visible");
    series.forEach((item, index) => {
      markers[index].setAttribute("cx", cx);
      markers[index].setAttribute("cy", y(row.tops[item.id]));
      markers[index].setAttribute("visibility", "visible");
    });

    const heading = document.createElement("strong");
    heading.textContent = `${timeLabel(row.start, false)} – ${timeLabel(row.start + bucketMs, false)}${daily ? `, ${timeLabel(row.start, true)}` : ""}`;
    const lines = [...series].reverse().map((item) => {
      const line = document.createElement("div");
      const swatch = document.createElement("i");
      swatch.style.background = item.color;
      line.append(swatch, `${item.label} `, Object.assign(document.createElement("b"), { textContent: format(row.values[item.id] || 0) }));
      return line;
    });
    if (stacked && series.length > 1) {
      const total = document.createElement("div");
      total.className = "chart-tooltip-total";
      total.append("Total ", Object.assign(document.createElement("b"), { textContent: format(row.total) }));
      lines.push(total);
    }
    tooltip.replaceChildren(heading, ...lines);
    tooltip.hidden = false;
    const left = Math.min(cx + 14, width - tooltip.offsetWidth - 4);
    tooltip.style.left = `${left < cx && cx - tooltip.offsetWidth - 14 > 0 ? cx - tooltip.offsetWidth - 14 : left}px`;
    tooltip.style.top = `${margin.top + (series.length > 1 ? 28 : 0)}px`;
  });

  // Table view of the same data, newest first.
  const details = document.createElement("details");
  details.className = "chart-table";
  const summary = document.createElement("summary");
  summary.textContent = "Show as table";
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const label of ["Period", ...series.map((item) => item.label), ...(stacked && series.length > 1 ? ["Total"] : [])]) {
    head.append(Object.assign(document.createElement("th"), { textContent: label }));
  }
  const body = table.createTBody();
  for (const row of [...rows].reverse()) {
    const tr = body.insertRow();
    tr.insertCell().textContent = new Date(row.start).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    for (const item of series) tr.insertCell().textContent = format(row.values[item.id] || 0);
    if (stacked && series.length > 1) tr.insertCell().textContent = format(row.total);
  }
  details.append(summary, table);
  container.append(details);
}

// Re-render on resize so the chart always fits its panel.
function responsiveChart(container, draw) {
  let last = 0;
  new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - last) > 4) {
      last = container.clientWidth;
      draw();
    }
  }).observe(container);
}

function workerLabel(identity) {
  return identity.includes(".") ? identity.slice(identity.lastIndexOf(".") + 1) : identity.split("/").pop() || identity;
}

// Colors follow each worker's first-seen order, so a worker keeps its color as others come
// and go. Past eight workers the rest fold into "Other" rather than inventing new hues.
function workerColorFor(workers, identity) {
  const index = workers.indexOf(identity);
  return index >= 0 && index < SERIES_COLORS.length ? SERIES_COLORS[index] : "#7d8a82";
}

function chartData(history, only = null) {
  const workers = history.workers;
  const shown = only ? [only] : workers.length > SERIES_COLORS.length ? workers.slice(0, SERIES_COLORS.length - 1) : workers;
  const folded = new Set(only ? [] : workers.filter((identity) => !shown.includes(identity)));
  const series = shown.map((identity) => ({ id: identity, label: workerLabel(identity), color: workerColorFor(workers, identity) }));
  if (folded.size) series.push({ id: "other", label: `Other (${folded.size})`, color: "#7d8a82" });
  const buckets = history.buckets.map((bucket) => {
    const values = {};
    for (const [identity, worker] of Object.entries(bucket.workers)) {
      const key = folded.has(identity) ? "other" : identity;
      if (shown.includes(identity) || key === "other") values[key] = (values[key] || 0) + worker.hashrate;
    }
    return { start: bucket.start, values };
  });
  return { series, buckets };
}

// Share difficulty scatter: one dot per share on a log scale (difficulties span 1,000x and
// more), a line at the pool's share target and the best share marked and labelled.
function renderShareScatter(container, { shares, start, end, color, format }) {
  container.replaceChildren();
  container.classList.add("chart");
  if (!shares.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No shares recorded in this period yet.";
    container.append(empty);
    return;
  }

  // Thin large sets: keep every notable share (4x the target or more) and a stride of the rest.
  let points = shares;
  if (points.length > 6000) {
    const notable = points.filter((share) => share.difficulty >= share.target * 4);
    const rest = points.filter((share) => share.difficulty < share.target * 4);
    const stride = Math.ceil(rest.length / Math.max(1, 6000 - notable.length));
    points = [...notable, ...rest.filter((_, index) => index % stride === 0)].sort((a, b) => a.ts - b.ts);
  }

  const width = Math.max(320, container.clientWidth);
  const height = 260;
  const margin = { top: 16, right: 12, bottom: 28, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const best = shares.reduce((top, share) => (share.difficulty > top.difficulty ? share : top));
  const target = shares.at(-1).target;
  const low = 10 ** Math.floor(Math.log10(Math.min(target, ...points.map((share) => share.difficulty)) / 1.2));
  const high = 10 ** Math.ceil(Math.log10(best.difficulty * 1.2));
  const x = (t) => margin.left + ((t - start) / (end - start)) * plotWidth;
  const y = (d) => margin.top + plotHeight - ((Math.log10(d) - Math.log10(low)) / (Math.log10(high) - Math.log10(low))) * plotHeight;

  const chart = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img" });
  chart.setAttribute("aria-label", "Share difficulty over time");
  for (let value = low; value <= high * 1.001; value *= 10) {
    chart.append(svg("line", { x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value), class: value === low ? "chart-baseline" : "chart-grid" }));
    const label = svg("text", { x: margin.left - 8, y: y(value) + 4, class: "chart-axis", "text-anchor": "end" });
    label.textContent = format(value);
    chart.append(label);
  }
  const { ticks, daily } = timeTicks(start, end);
  for (const t of ticks) {
    const label = svg("text", { x: x(t), y: height - 8, class: "chart-axis", "text-anchor": "middle" });
    label.textContent = timeLabel(t, daily);
    chart.append(label);
  }

  // Reference line at the current share target, labelled at the right.
  chart.append(svg("line", { x1: margin.left, x2: width - margin.right, y1: y(target), y2: y(target), class: "chart-reference" }));
  const targetLabel = svg("text", { x: width - margin.right, y: y(target) - 5, class: "chart-axis", "text-anchor": "end" });
  targetLabel.textContent = `share target ${format(target)}`;
  chart.append(targetLabel);

  for (const share of points) chart.append(svg("circle", { cx: x(share.ts), cy: y(share.difficulty), r: 2, fill: color, class: "chart-dot" }));
  chart.append(svg("circle", { cx: x(best.ts), cy: y(best.difficulty), r: 5, fill: color, stroke: SURFACE, "stroke-width": 2 }));
  const bestLabel = svg("text", { x: x(best.ts), y: y(best.difficulty) - 10, class: "chart-label", "text-anchor": x(best.ts) > width - 120 ? "end" : "middle" });
  bestLabel.textContent = `best ${format(best.difficulty)}`;
  chart.append(bestLabel);

  const marker = svg("circle", { r: 5, fill: color, stroke: SURFACE, "stroke-width": 2, visibility: "hidden" });
  const hit = svg("rect", { x: margin.left, y: margin.top, width: plotWidth, height: plotHeight, fill: "transparent" });
  chart.append(marker, hit);
  container.append(chart);

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;
  container.append(tooltip);
  hit.addEventListener("pointerleave", () => {
    tooltip.hidden = true;
    marker.setAttribute("visibility", "hidden");
  });
  hit.addEventListener("pointermove", (event) => {
    const bounds = chart.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    const py = event.clientY - bounds.top;
    let nearest = points[0];
    let distance = Infinity;
    for (const share of points) {
      const d = (x(share.ts) - px) ** 2 + (y(share.difficulty) - py) ** 2;
      if (d < distance) {
        distance = d;
        nearest = share;
      }
    }
    marker.setAttribute("cx", x(nearest.ts));
    marker.setAttribute("cy", y(nearest.difficulty));
    marker.setAttribute("visibility", "visible");
    const heading = Object.assign(document.createElement("strong"), { textContent: new Date(nearest.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) });
    const line = (label, value) => {
      const row = document.createElement("div");
      row.append(label, Object.assign(document.createElement("b"), { textContent: value }));
      return row;
    };
    tooltip.replaceChildren(heading, line("Difficulty", format(nearest.difficulty)), line("× share target", `${(nearest.difficulty / nearest.target).toFixed(1)}×`));
    tooltip.hidden = false;
    const cx = x(nearest.ts);
    tooltip.style.left = `${cx + tooltip.offsetWidth + 18 > width ? cx - tooltip.offsetWidth - 14 : cx + 14}px`;
    tooltip.style.top = `${Math.max(0, y(nearest.difficulty) - 30)}px`;
  });

  // Table view: the highest shares in the period.
  const details = document.createElement("details");
  details.className = "chart-table";
  details.append(Object.assign(document.createElement("summary"), { textContent: "Show top shares as table" }));
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const label of ["Time", "Difficulty", "× share target"]) head.append(Object.assign(document.createElement("th"), { textContent: label }));
  const body = table.createTBody();
  for (const share of [...shares].sort((a, b) => b.difficulty - a.difficulty).slice(0, 20)) {
    const tr = body.insertRow();
    tr.insertCell().textContent = new Date(share.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    tr.insertCell().textContent = format(share.difficulty);
    tr.insertCell().textContent = `${(share.difficulty / share.target).toFixed(1)}×`;
  }
  details.append(table);
  container.append(details);
}
