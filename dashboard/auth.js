// Dashboard sign-in: a password (always available) plus optional passkeys (WebAuthn), with
// sessions in SQLite so a dashboard restart does not sign everyone out.
//
// First run: until a password exists, the dashboard prints a one-time setup code to its log,
// and setting the password requires it, so whoever reaches a fresh install first cannot take it
// over. Passkeys need a secure context with a domain name (HTTPS, or http://localhost); each
// passkey is bound to the hostname it was registered on.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const SESSION_COOKIE = "sv2_session";
const SESSION_DAYS = 30;
const CHALLENGE_TTL_MS = 5 * 60_000;
// scrypt cost: 2^15 iterations of memory-hard hashing, about 32 MiB and ~100 ms per attempt.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD_LENGTH = 10;
// Failed sign-ins per client address before a 15-minute lockout.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptHash(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function checkPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
  return crypto.timingSafeEqual(key, expected);
}

function openAuth(file, { trustProxy = false, announce = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- Only a hash of each session token is stored, so a copy of the database cannot sign in.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      method TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL,
      transports TEXT,
      rp_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created INTEGER NOT NULL,
      last_used INTEGER
    );
  `);
  const q = {
    get: db.prepare("SELECT value FROM settings WHERE key = ?"),
    set: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
    unset: db.prepare("DELETE FROM settings WHERE key = ?"),
    addSession: db.prepare("INSERT INTO sessions (token_hash, created, expires, method) VALUES (?, ?, ?, ?)"),
    session: db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires > ?"),
    dropSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    dropSessions: db.prepare("DELETE FROM sessions"),
    purgeSessions: db.prepare("DELETE FROM sessions WHERE expires <= ?"),
    passkeys: db.prepare("SELECT * FROM passkeys ORDER BY created"),
    passkeysFor: db.prepare("SELECT * FROM passkeys WHERE rp_id = ?"),
    passkey: db.prepare("SELECT * FROM passkeys WHERE id = ?"),
    addPasskey: db.prepare("INSERT INTO passkeys (id, public_key, counter, transports, rp_id, name, created) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    usePasskey: db.prepare("UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?"),
    dropPasskey: db.prepare("DELETE FROM passkeys WHERE id = ?"),
  };

  const passwordHash = () => q.get.get("password")?.value || null;
  // A fresh code each start while no password is set; printed to the container log.
  let setupCode = null;
  function ensureSetupCode() {
    // Only the running dashboard issues codes; tools such as reset-password.js do not.
    if (!announce) return;
    if (passwordHash()) {
      setupCode = null;
      return;
    }
    if (!setupCode) {
      const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
      setupCode = `${raw.slice(0, 5)}-${raw.slice(5)}`;
      console.log(`Dashboard setup code: ${setupCode} (enter it to set the dashboard password)`);
    }
  }
  ensureSetupCode();

  // Rate limiting failed password and setup attempts per client address.
  const failures = new Map();
  function clientAddress(request) {
    const forwarded = trustProxy ? String(request.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
    return forwarded || request.socket.remoteAddress || "unknown";
  }
  function lockedOut(request) {
    const entry = failures.get(clientAddress(request));
    return Boolean(entry && entry.count >= MAX_FAILURES && Date.now() - entry.first < LOCKOUT_MS);
  }
  function recordFailure(request) {
    const key = clientAddress(request);
    const entry = failures.get(key);
    if (!entry || Date.now() - entry.first >= LOCKOUT_MS) failures.set(key, { count: 1, first: Date.now() });
    else entry.count += 1;
  }

  // The host the browser addressed: behind a trusted reverse proxy, X-Forwarded-Host.
  function requestHost(request) {
    const forwarded = trustProxy ? String(request.headers["x-forwarded-host"] || "").split(",")[0].trim() : "";
    return forwarded || String(request.headers.host || "");
  }

  // True when a browser request's Origin is this dashboard (or there is no Origin header).
  function sameOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === requestHost(request);
    } catch {
      return false;
    }
  }

  // The page is served over HTTPS when the request says so directly or, behind a trusted
  // reverse proxy, via X-Forwarded-Proto. Secure cookies and passkeys depend on it.
  function isSecure(request) {
    return Boolean(request.socket.encrypted) || (trustProxy && String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
  }

  // The page's origin as the browser reports it. Browsers send Origin on POSTs but not on a
  // page's own same-origin GETs, which carry Referer instead (Referrer-Policy: same-origin).
  function browserOrigin(request) {
    if (request.headers.origin) return request.headers.origin;
    try {
      return request.headers.referer ? new URL(request.headers.referer).origin : null;
    } catch {
      return null;
    }
  }

  // WebAuthn relying party for this request: the browser's own origin. Passkeys are offered only
  // in a secure context on a domain name (browsers refuse IP addresses as passkey domains).
  // Registration and sign-in themselves are POSTs, so they always use the Origin header.
  function relyingParty(request) {
    const origin = browserOrigin(request);
    if (!origin) return null;
    let url;
    try {
      url = new URL(origin);
    } catch {
      return null;
    }
    const hostname = url.hostname;
    const isLocalhost = hostname === "localhost";
    const isIp = /^[\d.]+$/.test(hostname) || hostname.includes(":");
    if (isIp || (url.protocol !== "https:" && !isLocalhost)) return null;
    // Same-origin requests only: the origin must be the host this request was sent to.
    if (url.host !== requestHost(request)) return null;
    return { rpID: hostname, origin: url.origin };
  }

  function cookies(request) {
    return Object.fromEntries(String(request.headers.cookie || "").split(";").map((part) => {
      const index = part.indexOf("=");
      return index < 0 ? [part.trim(), ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }));
  }

  function sessionFor(request) {
    const token = cookies(request)[SESSION_COOKIE];
    return token ? q.session.get(sha256(token), Date.now()) || null : null;
  }

  function startSession(request, response, method) {
    const token = randomToken();
    const now = Date.now();
    q.addSession.run(sha256(token), now, now + SESSION_DAYS * 86400_000, method);
    q.purgeSessions.run(now);
    const secure = isSecure(request) ? "; Secure" : "";
    response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  }

  function endSession(request, response) {
    const token = cookies(request)[SESSION_COOKIE];
    if (token) q.dropSession.run(sha256(token));
    response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  // Pending WebAuthn challenges, keyed by a random id the browser sends back.
  const challenges = new Map();
  function storeChallenge(value) {
    const id = randomToken();
    challenges.set(id, { ...value, expires: Date.now() + CHALLENGE_TTL_MS });
    for (const [key, entry] of challenges) if (entry.expires < Date.now()) challenges.delete(key);
    return id;
  }
  function takeChallenge(id) {
    const entry = challenges.get(id);
    challenges.delete(id);
    return entry && entry.expires > Date.now() ? entry : null;
  }

  async function readJson(request) {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 64 * 1024) throw new Error("Request too large");
    }
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      throw new Error(`Request body is not valid JSON (${body.length} bytes, content-length ${request.headers["content-length"] ?? "none"})`);
    }
  }

  function send(response, code, body) {
    response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  }

  // Handles /api/auth/*; returns true when it sent a response.
  async function handle(request, response, url) {
    if (!url.pathname.startsWith("/api/auth/")) return false;
    const route = `${request.method} ${url.pathname.slice("/api/auth".length)}`;
    const session = sessionFor(request);
    const rp = relyingParty(request);

    // Cross-site requests are refused outright; the session cookie is also SameSite=Strict.
    if (request.method !== "GET" && !sameOrigin(request)) return send(response, 403, { error: "Cross-origin request refused" }), true;

    try {
      switch (route) {
        case "GET /state": {
          ensureSetupCode();
          return send(response, 200, {
            configured: Boolean(passwordHash()),
            authenticated: Boolean(session),
            passkeysAvailable: Boolean(rp),
            passkeysForSite: rp ? q.passkeysFor.all(rp.rpID).length : 0,
          }), true;
        }

        case "POST /setup": {
          if (passwordHash()) return send(response, 409, { error: "A password is already set" }), true;
          if (lockedOut(request)) return send(response, 429, { error: "Too many attempts; try again in 15 minutes" }), true;
          const { code, password } = await readJson(request);
          ensureSetupCode();
          const given = String(code || "").trim().toUpperCase();
          const givenBytes = Buffer.from(given);
          if (!setupCode || givenBytes.length !== Buffer.byteLength(setupCode) || !crypto.timingSafeEqual(givenBytes, Buffer.from(setupCode))) {
            recordFailure(request);
            return send(response, 403, { error: "Setup code is incorrect; it is printed in the dashboard container's log" }), true;
          }
          if (String(password || "").length < MIN_PASSWORD_LENGTH) return send(response, 400, { error: `Use at least ${MIN_PASSWORD_LENGTH} characters` }), true;
          q.set.run("password", await hashPassword(String(password)));
          setupCode = null;
          startSession(request, response, "password");
          return send(response, 200, { ok: true }), true;
        }

        case "POST /login": {
          if (lockedOut(request)) return send(response, 429, { error: "Too many attempts; try again in 15 minutes" }), true;
          const { password } = await readJson(request);
          const stored = passwordHash();
          if (!stored || !(await checkPassword(String(password || ""), stored))) {
            recordFailure(request);
            return send(response, 401, { error: "Incorrect password" }), true;
          }
          failures.delete(clientAddress(request));
          startSession(request, response, "password");
          return send(response, 200, { ok: true }), true;
        }

        case "POST /logout":
          endSession(request, response);
          return send(response, 200, { ok: true }), true;

        case "POST /passkey/login/options": {
          if (!rp) return send(response, 400, { error: "Passkeys need HTTPS and a domain name" }), true;
          const options = await generateAuthenticationOptions({
            rpID: rp.rpID,
            userVerification: "preferred",
            allowCredentials: q.passkeysFor.all(rp.rpID).map((key) => ({ id: key.id, transports: key.transports ? JSON.parse(key.transports) : undefined })),
          });
          return send(response, 200, { options, challengeId: storeChallenge({ challenge: options.challenge, ...rp }) }), true;
        }

        case "POST /passkey/login/verify": {
          if (lockedOut(request)) return send(response, 429, { error: "Too many attempts; try again in 15 minutes" }), true;
          const { challengeId, credential } = await readJson(request);
          const pending = takeChallenge(challengeId);
          const key = credential?.id ? q.passkey.get(credential.id) : null;
          if (!pending || !key || key.rp_id !== pending.rpID) {
            recordFailure(request);
            return send(response, 401, { error: "Passkey not recognised for this site" }), true;
          }
          const result = await verifyAuthenticationResponse({
            response: credential,
            expectedChallenge: pending.challenge,
            expectedOrigin: pending.origin,
            expectedRPID: pending.rpID,
            credential: { id: key.id, publicKey: Buffer.from(key.public_key, "base64url"), counter: key.counter, transports: key.transports ? JSON.parse(key.transports) : undefined },
          });
          if (!result.verified) {
            recordFailure(request);
            return send(response, 401, { error: "Passkey verification failed" }), true;
          }
          q.usePasskey.run(result.authenticationInfo.newCounter, Date.now(), key.id);
          failures.delete(clientAddress(request));
          startSession(request, response, "passkey");
          return send(response, 200, { ok: true }), true;
        }
      }

      // Everything below changes credentials and needs a signed-in session.
      if (!session) return send(response, 401, { error: "Sign in first" }), true;

      switch (route) {
        case "POST /password": {
          const { current, next } = await readJson(request);
          if (!(await checkPassword(String(current || ""), passwordHash()))) {
            recordFailure(request);
            return send(response, 403, { error: "Current password is incorrect" }), true;
          }
          if (String(next || "").length < MIN_PASSWORD_LENGTH) return send(response, 400, { error: `Use at least ${MIN_PASSWORD_LENGTH} characters` }), true;
          q.set.run("password", await hashPassword(String(next)));
          // A new password signs out every other session.
          q.dropSessions.run();
          startSession(request, response, "password");
          return send(response, 200, { ok: true }), true;
        }

        case "POST /signout-all":
          q.dropSessions.run();
          endSession(request, response);
          return send(response, 200, { ok: true }), true;

        case "GET /passkeys":
          return send(response, 200, {
            passkeysAvailable: Boolean(rp),
            site: rp?.rpID || null,
            passkeys: q.passkeys.all().map((key) => ({ id: key.id, name: key.name, site: key.rp_id, created: key.created, lastUsed: key.last_used })),
          }), true;

        case "POST /passkey/register/options": {
          if (!rp) return send(response, 400, { error: "Passkeys need HTTPS and a domain name" }), true;
          const options = await generateRegistrationOptions({
            rpName: "Mining Console",
            rpID: rp.rpID,
            userName: "admin",
            userDisplayName: "Mining Console admin",
            attestationType: "none",
            excludeCredentials: q.passkeysFor.all(rp.rpID).map((key) => ({ id: key.id })),
            authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
          });
          return send(response, 200, { options, challengeId: storeChallenge({ challenge: options.challenge, ...rp }) }), true;
        }

        case "POST /passkey/register/verify": {
          const { challengeId, credential, name } = await readJson(request);
          const pending = takeChallenge(challengeId);
          if (!pending) return send(response, 400, { error: "Registration expired; try again" }), true;
          const result = await verifyRegistrationResponse({
            response: credential,
            expectedChallenge: pending.challenge,
            expectedOrigin: pending.origin,
            expectedRPID: pending.rpID,
          });
          if (!result.verified) return send(response, 400, { error: "Passkey registration failed" }), true;
          const info = result.registrationInfo.credential;
          q.addPasskey.run(info.id, Buffer.from(info.publicKey).toString("base64url"), info.counter, JSON.stringify(info.transports || credential.response?.transports || []), pending.rpID, String(name || "Passkey").slice(0, 60), Date.now());
          return send(response, 200, { ok: true }), true;
        }
      }

      const removal = /^DELETE \/passkeys\/([\w-]+)$/.exec(route);
      if (removal) {
        q.dropPasskey.run(removal[1]);
        return send(response, 200, { ok: true }), true;
      }
      return send(response, 404, { error: "Unknown auth endpoint" }), true;
    } catch (error) {
      // Name the route and where it failed; the browser only gets a generic message.
      const where = String(error.stack || "").split(/\r?\n/).slice(1, 4).map((line) => line.trim()).join(" < ");
      console.error(`Auth ${route}: ${error.message} (${where})`);
      return send(response, 400, { error: "Request could not be processed" }), true;
    }
  }

  return {
    handle,
    authenticated: (request) => Boolean(sessionFor(request)),
    // Used by reset-password.js: removes the password and every session; passkeys remain.
    resetPassword() {
      q.unset.run("password");
      q.dropSessions.run();
    },
  };
}

module.exports = { openAuth, hashPassword, checkPassword };
