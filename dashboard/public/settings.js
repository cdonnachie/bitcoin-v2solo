// Security page: passkeys for this site, password change, and signing out.
const byId = (id) => document.getElementById(id);

function message(text, ok = false) {
  const element = byId("settings-message");
  element.textContent = text || "";
  element.classList.toggle("ok", ok);
}

async function getJson(url) {
  const response = await fetch(url);
  if (response.status === 401) {
    location.replace(`/login.html?next=${encodeURIComponent(location.pathname)}`);
    throw new Error("Signed out");
  }
  return response.json();
}

function passkeyRow(key, site) {
  const row = document.createElement("div");
  row.className = "share-row passkey-row";
  const used = key.lastUsed ? `last used ${new Date(key.lastUsed).toLocaleDateString()}` : "never used";
  const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "Remove", className: "secondary" });
  remove.addEventListener("click", async () => {
    if (!confirmRemoval.has(key.id)) {
      confirmRemoval.add(key.id);
      remove.textContent = "Click again to remove";
      return;
    }
    const response = await fetch(`/api/auth/passkeys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
    message(response.ok ? `Removed passkey "${key.name}".` : "Could not remove the passkey.", response.ok);
    load();
  });
  row.replaceChildren(
    Object.assign(document.createElement("strong"), { textContent: key.name }),
    Object.assign(document.createElement("span"), { textContent: key.site === site ? key.site : `${key.site} (other site)` }),
    Object.assign(document.createElement("span"), { textContent: `added ${new Date(key.created).toLocaleDateString()}, ${used}` }),
    remove,
  );
  return row;
}

const confirmRemoval = new Set();

async function load() {
  confirmRemoval.clear();
  const data = await getJson("/api/auth/passkeys");
  const usable = data.passkeysAvailable && passkeysSupported();
  byId("add-passkey").hidden = !usable;
  byId("passkey-note").textContent = usable
    ? `Passkeys sign in to ${data.site} with Face ID, Windows Hello, a phone or a security key. Each passkey works only on the site it was added on.`
    : "Passkeys need the dashboard to be opened over HTTPS with a domain name (for example behind a reverse proxy or Tailscale Serve). Password sign-in works everywhere.";
  const list = byId("passkey-list");
  list.replaceChildren(...(data.passkeys.length
    ? data.passkeys.map((key) => passkeyRow(key, data.site))
    : [Object.assign(document.createElement("p"), { className: "empty", textContent: "No passkeys yet." })]));
}

byId("add-passkey").addEventListener("submit", async (event) => {
  event.preventDefault();
  message("");
  try {
    const name = byId("passkey-name").value.trim();
    if (!name) return;
    const { options, challengeId } = await postJson("/api/auth/passkey/register/options");
    const credential = await createPasskey(options);
    await postJson("/api/auth/passkey/register/verify", { challengeId, credential, name });
    byId("passkey-name").value = "";
    message(`Added passkey "${name}".`, true);
    load();
  } catch (error) {
    message(error.name === "NotAllowedError" ? "Passkey creation was cancelled or timed out." : error.message);
  }
});

byId("password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  message("");
  try {
    if (byId("new-password").value !== byId("confirm-password").value) throw new Error("New passwords do not match.");
    await postJson("/api/auth/password", { current: byId("current-password").value, next: byId("new-password").value });
    event.target.reset();
    message("Password changed. Other sessions were signed out.", true);
  } catch (error) {
    message(error.message);
  }
});

byId("sign-out").addEventListener("click", async () => {
  await postJson("/api/auth/logout").catch(() => {});
  location.replace("/login.html");
});

byId("sign-out-all").addEventListener("click", async () => {
  await postJson("/api/auth/signout-all").catch(() => {});
  location.replace("/login.html");
});

load().catch((error) => message(error.message));
