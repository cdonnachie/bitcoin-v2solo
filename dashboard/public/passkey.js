// Browser side of passkeys: converts the server's WebAuthn JSON options to the binary form
// navigator.credentials expects, and the resulting credential back to JSON.
const toBytes = (base64url) => Uint8Array.from(atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const bytesToBase64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Binary fields arrive as ArrayBuffers from the browser, but password managers that
// intercept WebAuthn (Dashlane, 1Password, Bitwarden...) may return views or already
// base64-encoded strings. Normalise any of them to base64url; undefined when unusable.
function encodeField(value) {
  if (value == null) return undefined;
  // clientDataJSON as plain JSON text rather than encoded bytes.
  if (typeof value === "string" && value.trimStart().startsWith("{")) return bytesToBase64url(new TextEncoder().encode(value));
  if (typeof value === "string") return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") || undefined;
  if (ArrayBuffer.isView(value)) return bytesToBase64url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) || undefined;
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return bytesToBase64url(new Uint8Array(value)) || undefined;
  return undefined;
}

function passkeysSupported() {
  return Boolean(window.PublicKeyCredential && window.isSecureContext);
}

// Builds the WebAuthn JSON form from the credential's own fields, falling back to its toJSON()
// output field by field, so a partial or non-standard implementation still works.
function credentialToJSON(credential) {
  let native = {};
  try {
    native = typeof credential.toJSON === "function" ? credential.toJSON() || {} : {};
  } catch {
    native = {};
  }
  const response = credential.response || {};
  const nativeResponse = native.response || {};
  const field = (name) => encodeField(response[name]) || encodeField(nativeResponse[name]);
  let extensions = native.clientExtensionResults || {};
  try {
    extensions = credential.getClientExtensionResults ? credential.getClientExtensionResults() : extensions;
  } catch {
    // Keep what toJSON() reported.
  }
  const json = {
    id: credential.id || native.id,
    rawId: encodeField(credential.rawId) || encodeField(native.rawId) || credential.id,
    type: credential.type || native.type || "public-key",
    clientExtensionResults: extensions,
    authenticatorAttachment: credential.authenticatorAttachment || native.authenticatorAttachment || undefined,
    response: { clientDataJSON: field("clientDataJSON") },
  };
  if (response.attestationObject || nativeResponse.attestationObject) {
    json.response.attestationObject = field("attestationObject");
    let transports = nativeResponse.transports;
    try {
      transports = response.getTransports ? response.getTransports() : transports;
    } catch {
      // Keep what toJSON() reported.
    }
    json.response.transports = transports || [];
  } else {
    json.response.authenticatorData = field("authenticatorData");
    json.response.signature = field("signature");
    const userHandle = field("userHandle");
    if (userHandle) json.response.userHandle = userHandle;
  }
  return json;
}

async function createPasskey(options) {
  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON
    ? PublicKeyCredential.parseCreationOptionsFromJSON(options)
    : {
        ...options,
        challenge: toBytes(options.challenge),
        user: { ...options.user, id: toBytes(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: toBytes(item.id) })),
      };
  return credentialToJSON(await navigator.credentials.create({ publicKey }));
}

async function usePasskey(options) {
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON
    ? PublicKeyCredential.parseRequestOptionsFromJSON(options)
    : {
        ...options,
        challenge: toBytes(options.challenge),
        allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id: toBytes(item.id) })),
      };
  return credentialToJSON(await navigator.credentials.get({ publicKey }));
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
