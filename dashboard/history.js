// Persistent mining history in SQLite: lifetime worker totals that survive pool restarts,
// reconnects and dashboard rebuilds, per-minute samples for charts, and connect/block events.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DAY_MS = 24 * 3600_000;
const RETENTION_MS = 90 * DAY_MS;
// The pool's start time drifts by a second or two between samples; within this window it is
// the same pool process.
const SAME_POOL_RUN_SECS = 30;
// After a longer sampling gap the share delta covers many minutes, so it is kept in the
// lifetime totals but left out of the per-minute series rather than drawn as a spike.
const MAX_SAMPLE_GAP_MS = 2 * 60_000;

function openHistory(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workers (
      identity TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_share INTEGER,
      accepted INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      work REAL NOT NULL DEFAULT 0,
      best_diff REAL NOT NULL DEFAULT 0,
      blocks INTEGER NOT NULL DEFAULT 0
    );
    -- Last counters seen for each pool channel, so only new shares are added to the totals.
    CREATE TABLE IF NOT EXISTS channels (
      key TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      accepted INTEGER NOT NULL,
      rejected INTEGER NOT NULL,
      work REAL NOT NULL,
      blocks INTEGER NOT NULL,
      seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS minutes (
      minute INTEGER NOT NULL,
      identity TEXT NOT NULL,
      accepted INTEGER NOT NULL,
      rejected INTEGER NOT NULL,
      work REAL NOT NULL,
      PRIMARY KEY (minute, identity)
    );
    CREATE TABLE IF NOT EXISTS events (
      ts INTEGER NOT NULL,
      identity TEXT NOT NULL,
      type TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS events_by_time ON events (ts);
  `);

  const q = {
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
    getChannel: db.prepare("SELECT * FROM channels WHERE key = ?"),
    putChannel: db.prepare(`
      INSERT INTO channels (key, identity, accepted, rejected, work, blocks, seen) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET accepted = excluded.accepted, rejected = excluded.rejected,
        work = excluded.work, blocks = excluded.blocks, seen = excluded.seen`),
    addWorker: db.prepare(`
      INSERT INTO workers (identity, first_seen, last_share, accepted, rejected, work, best_diff, blocks)
      VALUES (:identity, :now, :lastShare, :accepted, :rejected, :work, :best, :blocks)
      ON CONFLICT (identity) DO UPDATE SET
        last_share = COALESCE(excluded.last_share, workers.last_share),
        accepted = workers.accepted + excluded.accepted,
        rejected = workers.rejected + excluded.rejected,
        work = workers.work + excluded.work,
        best_diff = MAX(workers.best_diff, excluded.best_diff),
        blocks = workers.blocks + excluded.blocks`),
    addMinute: db.prepare(`
      INSERT INTO minutes (minute, identity, accepted, rejected, work) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (minute, identity) DO UPDATE SET accepted = minutes.accepted + excluded.accepted,
        rejected = minutes.rejected + excluded.rejected, work = minutes.work + excluded.work`),
    addEvent: db.prepare("INSERT INTO events (ts, identity, type, detail) VALUES (?, ?, ?, ?)"),
    worker: db.prepare("SELECT * FROM workers WHERE identity = ?"),
    connectsSince: db.prepare("SELECT COUNT(*) AS n FROM events WHERE identity = ? AND type = 'connect' AND ts >= ?"),
    totals: db.prepare(`
      SELECT COALESCE(MAX(best_diff), 0) AS best, COALESCE(SUM(blocks), 0) AS blocks,
        COALESCE(SUM(accepted), 0) AS accepted, COALESCE(SUM(rejected), 0) AS rejected, MIN(first_seen) AS since
      FROM workers`),
    blocks: db.prepare("SELECT ts, identity, detail FROM events WHERE type = 'block' ORDER BY ts DESC"),
    history: db.prepare(`
      SELECT (minute / :bucket) * :bucket AS bucket, identity,
        SUM(accepted) AS accepted, SUM(rejected) AS rejected, SUM(work) AS work
      FROM minutes WHERE minute >= :since GROUP BY bucket, identity ORDER BY bucket`),
    purgeMinutes: db.prepare("DELETE FROM minutes WHERE minute < ?"),
    purgeConnects: db.prepare("DELETE FROM events WHERE type = 'connect' AND ts < ?"),
    purgeChannels: db.prepare("DELETE FROM channels WHERE seen < ?"),
  };

  // Channel ids restart when the pool restarts, so channel keys include the pool's start time.
  function poolRun(uptimeSecs, now) {
    const start = Math.round(now / 1000 - uptimeSecs);
    const known = Number(q.getMeta.get("pool_start")?.value);
    if (Number.isFinite(known) && Math.abs(start - known) <= SAME_POOL_RUN_SECS) return known;
    q.setMeta.run("pool_start", String(start));
    return start;
  }

  function record(channels, uptimeSecs, now) {
    const run = poolRun(uptimeSecs, now);
    const minute = Math.floor(now / 60_000) * 60_000;
    db.exec("BEGIN");
    try {
      for (const channel of channels) {
        const identity = String(channel.user_identity || "");
        const key = `${run}:${channel.client_id}:${channel.channel_id}`;
        const current = {
          accepted: Number(channel.shares_accepted) || 0,
          rejected: Number(channel.shares_rejected) || 0,
          work: Number(channel.share_work_sum) || 0,
          blocks: Number(channel.blocks_found) || 0,
        };
        const previous = q.getChannel.get(key);
        // A channel not seen before counts from zero; afterwards only the increase is added.
        const base = previous && current.work >= previous.work && current.accepted >= previous.accepted
          ? previous
          : { accepted: 0, rejected: 0, work: 0, blocks: 0 };
        const delta = {
          accepted: current.accepted - base.accepted,
          rejected: current.rejected - base.rejected,
          work: current.work - base.work,
          blocks: current.blocks - base.blocks,
        };
        const shares = delta.accepted + delta.rejected;

        if (!previous) q.addEvent.run(now, identity, "connect", `client ${channel.client_id}`);
        q.addWorker.run({
          identity,
          now,
          lastShare: shares > 0 ? now : null,
          accepted: delta.accepted,
          rejected: delta.rejected,
          work: delta.work,
          best: Number(channel.best_diff) || 0,
          blocks: delta.blocks,
        });
        if (previous && now - previous.seen <= MAX_SAMPLE_GAP_MS && (shares > 0 || delta.work > 0)) {
          q.addMinute.run(minute, identity, delta.accepted, delta.rejected, delta.work);
        }
        if (delta.blocks > 0) {
          q.addEvent.run(now, identity, "block", JSON.stringify({ count: delta.blocks, address: channel.payout?.address || null }));
        }
        q.putChannel.run(key, identity, current.accepted, current.rejected, current.work, current.blocks, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function worker(identity, now) {
    const row = q.worker.get(identity);
    return row ? { ...row, connects24h: q.connectsSince.get(identity, now - DAY_MS).n } : null;
  }

  function summary() {
    return {
      ...q.totals.get(),
      blockEvents: q.blocks.all().map((event) => ({ ...event, detail: JSON.parse(event.detail || "{}") })),
    };
  }

  // Hashrate per worker per bucket: each unit of share difficulty represents 2^32 hashes.
  function history(hours, now) {
    const bucketMs = hours <= 24 ? 60_000 : hours <= 168 ? 10 * 60_000 : 3600_000;
    return {
      bucketMs,
      rows: q.history.all({ bucket: bucketMs, since: now - hours * 3600_000 }).map((row) => ({
        ...row,
        hashrate: (row.work * 2 ** 32) / (bucketMs / 1000),
      })),
    };
  }

  // Blocks found are kept forever; samples and connect events for 90 days.
  function purge(now) {
    q.purgeMinutes.run(now - RETENTION_MS);
    q.purgeConnects.run(now - RETENTION_MS);
    q.purgeChannels.run(now - 7 * DAY_MS);
  }

  return { record, worker, summary, history, purge };
}

module.exports = { openHistory };
