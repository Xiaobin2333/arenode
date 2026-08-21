const CONFIG_DEFINITIONS = {
  site: {
    'http_listen.port': 'text',
    'https_listen.port': 'text',
    'https_listen.hsts': 'toggle',
    'https_listen.http2': 'toggle',
    'https_listen.http3': 'toggle',
    'https_listen.force_ssl_enable': 'toggle',
    backend_protocol: 'text',
    backend_http_port: 'number',
    backend_https_port: 'number',
    proxy_timeout: 'number',
    balance_way: 'text',
    gzip_enable: 'toggle',
    websocket_enable: 'toggle',
    block_proxy: 'toggle',
    recv_real_time: 'toggle',
    send_real_time: 'toggle',
    enable_ipv6: 'toggle',
    black_ip: 'text',
    white_ip: 'text',
    spider_to_sip: 'text',
  },
  stream: {
    proxy_protocol: 'toggle',
    listen_protocol: 'text',
    balance_way: 'text',
  },
  cert: {
    provider: 'text',
    cert_default_type: 'text',
    dnsapi: 'number',
    auto_renew: 'toggle',
  },
};

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function mergeObjects(base, override) {
  if (!plainObject(base) || !plainObject(override)) return structuredClone(override);
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    output[key] = plainObject(value) && plainObject(output[key])
      ? mergeObjects(output[key], value)
      : structuredClone(value);
  }
  return output;
}

function parsedValue(kind, value) {
  if (kind === 'toggle') return ['1', 'true', 'on', 'yes'].includes(String(value).trim().toLowerCase()) ? 1 : 0;
  if (kind === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return String(value ?? '').trim();
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!plainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function defaultsFromRows(type, rows) {
  const defaults = {}; let listenProtocol = null;
  for (const row of rows) {
    const definition = CONFIG_DEFINITIONS[type]?.[row.name];
    if (!definition) continue;
    const value = parsedValue(definition, row.value);
    if (value === null) continue;
    if (type === 'cert' && ['provider', 'cert_default_type'].includes(row.name)) {
      defaults.type = value;
    } else if (type === 'stream' && row.name === 'listen_protocol') {
      listenProtocol = value;
    } else {
      setPath(defaults, row.name, value);
    }
  }
  return { defaults, listenProtocol };
}

export async function applyUserDefaults(db, userId, type, groupId, input) {
  if (!CONFIG_DEFINITIONS[type] || !plainObject(input)) return input;
  const params = [Number(userId), type];
  let scope = "scope_name='global'";
  if (Number.isInteger(Number(groupId)) && Number(groupId) > 0 && type !== 'cert') {
    scope = "(scope_name='global' OR (scope_name='group' AND scope_id=?))";
    params.push(Number(groupId));
  }
  const rows = await db.prepare(`SELECT name,value,scope_name FROM user_configs
    WHERE user_id=? AND type=? AND enable=1 AND ${scope}
    ORDER BY CASE scope_name WHEN 'global' THEN 0 ELSE 1 END,id`).all(...params);
  const { defaults, listenProtocol } = defaultsFromRows(type, rows);
  const output = mergeObjects(defaults, input);
  if (type === 'stream' && listenProtocol && Array.isArray(output.listen)) {
    output.listen = output.listen.map(item => ({ protocol: listenProtocol, ...item }));
  }
  return output;
}

export const userDefaultsInternals = { CONFIG_DEFINITIONS, defaultsFromRows, mergeObjects, parsedValue };
