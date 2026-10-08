// The pool's monitoring API, normalized into the shape the rest of the dashboard uses.
//
// This is the only file that reads raw pool responses. Everything else, the browser included,
// uses the normalized objects below, so when an SRI release renames or moves a field the fix
// is a mapping here (keeping a fallback for the old name). CONTRACT lists every raw field the
// mapping reads; scripts/check-pool-image.sh checks a candidate pool image's own OpenAPI spec
// against it before upgrading.

const CHANNEL_FIELDS = {
  channel_id: "integer",
  user_identity: "string",
  nominal_hashrate: "number",
  target_hex: "string",
  shares_accepted: "integer",
  shares_rejected: "integer",
  shares_rejected_by_reason: "object",
  share_work_sum: "number",
  best_diff: "number",
  blocks_found: "integer",
};

const prefixed = (prefix, fields) => Object.fromEntries(Object.entries(fields).map(([name, type]) => [`${prefix}${name}`, type]));

const CONTRACT = {
  "/api/v1/global": {
    uptime_secs: "integer",
    "sv2_clients.total_clients": "integer",
    "sv2_clients.total_channels": "integer",
    "sv2_clients.total_hashrate": "number",
  },
  "/api/v1/health": { status: "string" },
  "/api/v1/clients": { "items[].client_id": "integer" },
  "/api/v1/clients/{client_id}/channels": {
    ...prefixed("extended_channels[].", CHANNEL_FIELDS),
    ...prefixed("standard_channels[].", CHANNEL_FIELDS),
  },
};

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function normalizeGlobal(raw) {
  const sv2 = raw?.sv2_clients || {};
  return {
    total_clients: number(sv2.total_clients),
    total_channels: number(sv2.total_channels),
    total_hashrate: number(sv2.total_hashrate),
    uptime_secs: number(raw?.uptime_secs),
  };
}

function normalizeHealth(raw) {
  return { status: String(raw?.status ?? "unknown") };
}

function normalizeChannel(raw, clientId) {
  return {
    client_id: clientId,
    channel_id: number(raw.channel_id),
    user_identity: String(raw.user_identity ?? ""),
    nominal_hashrate: number(raw.nominal_hashrate),
    target_hex: String(raw.target_hex ?? ""),
    shares_accepted: number(raw.shares_accepted),
    shares_rejected: number(raw.shares_rejected),
    shares_rejected_by_reason: raw.shares_rejected_by_reason && typeof raw.shares_rejected_by_reason === "object" ? raw.shares_rejected_by_reason : {},
    share_work_sum: number(raw.share_work_sum),
    best_diff: number(raw.best_diff),
    blocks_found: number(raw.blocks_found),
  };
}

// get(path) performs a GET against the pool's monitoring server and resolves to parsed JSON.
function poolApi(get) {
  return {
    global: async () => normalizeGlobal(await get("/api/v1/global")),
    health: async () => normalizeHealth(await get("/api/v1/health")),
    async channels() {
      const clients = await get("/api/v1/clients?limit=100");
      const perClient = await Promise.all((clients.items || []).map(async (client) => {
        const clientId = number(client.client_id);
        const response = await get(`/api/v1/clients/${clientId}/channels?limit=100`);
        return [...(response.extended_channels || []), ...(response.standard_channels || [])]
          .map((channel) => normalizeChannel(channel, clientId));
      }));
      return perClient.flat();
    },
  };
}

// Checks an OpenAPI 3 spec (the pool serves its own at /api-docs/openapi.json) against
// CONTRACT. Returns a list of problems; empty means every field the dashboard reads exists
// with the expected type.
function checkContract(spec) {
  const problems = [];
  const resolve = (schema) => {
    let current = schema;
    for (let depth = 0; current && depth < 10; depth += 1) {
      if (current.$ref) current = spec.components?.schemas?.[current.$ref.split("/").pop()];
      else if (current.oneOf || current.anyOf) current = (current.oneOf || current.anyOf).find((option) => option.type !== "null");
      else return current;
    }
    return current;
  };
  const typeOf = (schema) => {
    const types = [].concat(schema?.type ?? []).filter((type) => type !== "null");
    return types[0] ?? (schema?.properties ? "object" : undefined);
  };

  for (const [path, fields] of Object.entries(CONTRACT)) {
    const response = spec.paths?.[path]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
    if (!response) {
      problems.push(`${path}: endpoint or its 200 response is missing`);
      continue;
    }
    for (const [field, expected] of Object.entries(fields)) {
      let schema = resolve(response);
      for (const part of field.split(".")) {
        const name = part.replace(/\[\]$/, "");
        schema = resolve(schema?.properties?.[name]);
        if (schema && part.endsWith("[]")) schema = resolve(schema.items);
        if (!schema) break;
      }
      const actual = typeOf(schema);
      if (!schema) problems.push(`${path}: ${field} is missing`);
      else if (actual !== expected && !(expected === "number" && actual === "integer")) {
        problems.push(`${path}: ${field} is ${actual ?? "untyped"}, expected ${expected}`);
      }
    }
  }
  return problems;
}

module.exports = { CONTRACT, poolApi, checkContract, normalizeChannel, normalizeGlobal };
