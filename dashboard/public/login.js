// Login page: first-run password setup (with the setup code from the log), password sign-in,
// and passkey sign-in where the site supports it.
const byId = (id) => document.getElementById(id);

// Only return to a page on this site after signing in.
function nextPage() {
  const next = new URLSearchParams(location.search).get("next") || "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function showError(message) {
  byId("auth-error").textContent = message || "";
}

async function withButton(form, action) {
  const buttons = form.querySelectorAll("button");
  for (const button of buttons) button.disabled = true;
  showError("");
  try {
    await action();
  } catch (error) {
    showError(error.name === "NotAllowedError" ? "Passkey request was cancelled or timed out." : error.message);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

async function start() {
  const state = await fetch("/api/auth/state").then((response) => response.json());
  if (state.authenticated) {
    location.replace(nextPage());
    return;
  }
  byId("setup-form").hidden = state.configured;
  byId("login-form").hidden = !state.configured;
  byId("passkey-login").hidden = !(state.configured && state.passkeysAvailable && state.passkeysForSite && passkeysSupported());
  (state.configured ? byId("login-password") : byId("setup-code")).focus();
}

byId("setup-form").addEventListener("submit", (event) => {
  event.preventDefault();
  withButton(event.target, async () => {
    if (byId("setup-password").value !== byId("setup-confirm").value) throw new Error("Passwords do not match.");
    await postJson("/api/auth/setup", { code: byId("setup-code").value, password: byId("setup-password").value });
    location.replace(nextPage());
  });
});

byId("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  withButton(event.target, async () => {
    await postJson("/api/auth/login", { password: byId("login-password").value });
    location.replace(nextPage());
  });
});

byId("passkey-login").addEventListener("click", () => {
  withButton(byId("login-form"), async () => {
    const { options, challengeId } = await postJson("/api/auth/passkey/login/options");
    const credential = await usePasskey(options);
    await postJson("/api/auth/passkey/login/verify", { challengeId, credential });
    location.replace(nextPage());
  });
});

start().catch(() => showError("The dashboard is not responding."));
