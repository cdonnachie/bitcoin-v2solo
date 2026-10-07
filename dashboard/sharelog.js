// Follows the pool's log file for individual shares. Each valid share is logged with its hash;
// its actual difficulty is the difficulty-1 target divided by that hash. Rejected shares are
// logged with an error code.
const fs = require("node:fs");

const DIFFICULTY_1_TARGET = 0xffffn << 208n;
const VALID = /^(\S+)\s+INFO .*SubmitShares\w*: valid share \| downstream_id: (\d+), channel_id: (\d+), sequence_number: (\d+), share_hash: ([0-9a-f]{64}), share_work: ([0-9.]+)/;
const REJECTED = /^(\S+)\s+\w+ .*SubmitSharesError: downstream_id: (\d+), channel_id: (\d+), sequence_number: (\d+), error_code: ([\w-]+)/;
const POLL_MS = 2000;
// Once fully read past this size the file is emptied. The pool opens it in append mode, so
// its next lines land at the new end of the file rather than leaving a gap.
const MAX_BYTES = 50 * 1024 * 1024;

function shareDifficulty(hashHex) {
  const hash = BigInt(`0x${hashHex}`);
  return hash ? Number((DIFFICULTY_1_TARGET * 1000n) / hash) / 1000 : 0;
}

function parseLine(line) {
  let match = VALID.exec(line);
  if (match) {
    return {
      ts: Date.parse(match[1]),
      client: Number(match[2]),
      channel: Number(match[3]),
      sequence: Number(match[4]),
      hash: match[5],
      target: Number(match[6]),
      difficulty: shareDifficulty(match[5]),
      accepted: true,
    };
  }
  match = REJECTED.exec(line);
  if (match) {
    return {
      ts: Date.parse(match[1]),
      client: Number(match[2]),
      channel: Number(match[3]),
      sequence: Number(match[4]),
      reason: match[5],
      accepted: false,
    };
  }
  return null;
}

// position: { get() -> { inode, offset } | null, set({ inode, offset }) } persists progress, so
// a dashboard restart neither skips nor re-reads shares.
function followShareLog(file, position, onShares) {
  let busy = false;

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat) return;
      let { inode, offset } = position.get() || { inode: stat.ino, offset: 0 };
      // A new file, or one emptied since the last read, starts again from the beginning.
      if (inode !== stat.ino || stat.size < offset) {
        inode = stat.ino;
        offset = 0;
      }
      if (stat.size > offset) {
        const handle = await fs.promises.open(file, "r");
        try {
          const length = Math.min(stat.size - offset, 8 * 1024 * 1024);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          // Advance only past complete lines; a line still being written is read next time.
          const end = buffer.lastIndexOf(10, bytesRead - 1);
          if (end >= 0) {
            const shares = buffer.subarray(0, end).toString("utf8").split("\n").map(parseLine).filter(Boolean);
            offset += end + 1;
            if (shares.length) onShares(shares);
          }
        } finally {
          await handle.close();
        }
      }
      if (offset >= MAX_BYTES) {
        const latest = await fs.promises.stat(file);
        if (latest.size === offset) {
          await fs.promises.truncate(file, 0);
          offset = 0;
        }
      }
      position.set({ inode, offset });
    } catch (error) {
      console.error(`Share log: ${error.message}`);
    } finally {
      busy = false;
    }
  }

  poll();
  return setInterval(poll, POLL_MS);
}

module.exports = { followShareLog, parseLine, shareDifficulty };
