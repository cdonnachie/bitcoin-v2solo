// Browser side of passkeys: converts the server's WebAuthn JSON options to the binary form
// navigator.credentials expects, and the resulting credential back to JSON.
const toBytes = (base64url) => Uint8Array.from(atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const toBase64url = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function passkeysSupported() {
  return Boolean(window.PublicKeyCredential && window.isSecureContext);
}

function credentialToJSON(credential) {
  if (typeof credential.toJSON === "function") return credential.toJSON();
  const response = credential.response;
  const json = {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    response: { clientDataJSON: toBase64url(response.clientDataJSON) },
  };
  if (response.attestationObject) {
    json.response.attestationObject = toBase64url(response.attestationObject);
    json.response.transports = response.getTransports ? response.getTransports() : [];
  } else {
    json.response.authenticatorData = toBase64url(response.authenticatorData);
    json.response.signature = toBase64url(response.signature);
    if (response.userHandle) json.response.userHandle = toBase64url(response.userHandle);
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
