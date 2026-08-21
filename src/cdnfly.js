import { configInternals } from './config.js';

export class CdnflyError extends Error {
  constructor(message, { status = 502, upstreamCode = null, upstreamStatus = null, details = null, providerMessage = null } = {}) {
    super(message);
    this.name = 'CdnflyError';
    this.status = status;
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
    this.details = details;
    this.providerMessage = providerMessage;
  }
}

function publicProviderMessage(value, fallback = 'CDN 服务暂时不可用，请稍后重试') {
  const message = String(value || '').trim();
  if (!message) return fallback;
  return message.replace(/CDNFly/gi, 'CDN 服务');
}

const STRUCTURED_FIELDS = new Set([
  'acl', 'auth', 'backend', 'cc_switch', 'condition_backend', 'cors', 'data',
  'extra_cc_rule', 'health_check', 'hotlink', 'http_listen', 'https_listen',
  'listen', 'proxy_cache', 'req_header', 'resp_header', 'slice', 'url_rewrite',
]);

function normalizeStructuredFields(value, field = '') {
  if (Array.isArray(value)) return value.map(item => normalizeStructuredFields(item));
  if (typeof value === 'string' && STRUCTURED_FIELDS.has(field) && /^\s*[\[{]/.test(value)) {
    try { return normalizeStructuredFields(JSON.parse(value), field); }
    catch { return value; }
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeStructuredFields(child, key)]));
}

function unwrap(payload, responseStatus) {
  if (payload && typeof payload === 'object') {
    const code = payload.code ?? payload.status;
    const explicitFailure = payload.success === false || (code !== undefined && ![0, 200, '0', '200'].includes(code));
    if (explicitFailure) {
      const providerMessage = payload.message || payload.msg || '上游返回业务错误';
      throw new CdnflyError(publicProviderMessage(providerMessage, 'CDN 服务返回业务错误'), {
        status: responseStatus >= 400 ? responseStatus : 502,
        upstreamCode: code,
        upstreamStatus: responseStatus,
        details: payload.errors || null,
        providerMessage,
      });
    }
    return normalizeStructuredFields(payload.data ?? payload.result ?? payload);
  }
  if (typeof payload === 'string' && /(需要.*权限|无权限|权限不足|禁止访问|日期格式不正确|参数(?:错误|不正确)|不能为空|不支持|^缺少|操作失败|请求失败|服务.*异常)/.test(payload.trim())) {
    throw new CdnflyError(publicProviderMessage(payload), { status: 502, upstreamStatus: responseStatus, providerMessage: payload.trim() });
  }
  return payload;
}

function upstreamErrorMessage(payload, status) {
  const message = String(payload?.message || payload?.msg || '').trim();
  const looksLikeHtml = /<!doctype\s+html|<html\b|<body\b|<h1\b/i.test(message);
  if (message && !looksLikeHtml) return publicProviderMessage(message);
  return status >= 500 ? 'CDN 服务暂时不可用，请稍后重试' : 'CDN 服务请求失败，请稍后重试';
}

function providerDiagnostic(payload, status) {
  const message = String(payload?.message || payload?.msg || '').trim();
  return message && !/<!doctype\s+html|<html\b|<body\b|<h1\b/i.test(message) ? message : `HTTP ${status}`;
}

const RETRYABLE_METHODS = new Set(['GET', 'PUT']);
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

function retryDelay(attempt) {
  return new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
}

export class CdnflyClient {
  constructor(config, fetchImpl = fetch, cache = null) {
    this.baseUrl = config.cdnflyBaseUrl;
    this.apiKey = config.cdnflyApiKey;
    this.apiSecret = config.cdnflyApiSecret;
    this.packageId = config.cdnflyUserPackageId;
    this.accountId = config.cdnflyAccountId || null;
    this.groupNamespace = config.upstreamGroupNamespace
      || configInternals.defaultUpstreamGroupNamespace(config.appOrigin || config.cdnflyBaseUrl || 'local');
    this.cnameSuffix = config.cdnflyCnameSuffix || '';
    // A single upstream account may expose multiple purchased packages. Cache
    // and rate-limit buckets must not be shared across those package scopes.
    const baseScope = String(config.cdnflyAccountId || config.cdnflyApiKey || config.cdnflyBaseUrl || 'legacy');
    this.cacheScope = `${baseScope}|package=${encodeURIComponent(String(config.cdnflyUserPackageId ?? ''))}`;
    this.timeoutMs = config.upstreamTimeoutMs;
    this.cache = cache;
    this.cacheTtl = config.cdnflyCacheTtlSeconds || 30;
    this.monitorCacheTtl = config.cdnflyMonitorCacheTtlSeconds || 8;
    this.requestsPerMinute = config.cdnflyRequestsPerMinute || 300;
    this.fetch = fetchImpl;
  }

  async request(method, pathname, body) {
    const upper = method.toUpperCase();
    if (upper === 'GET' && this.cache) {
      const monitor = pathname.startsWith('/v1/monitor/');
      return this.cache.getOrSet(monitor ? 'monitor' : 'resource', `${this.cacheScope}:${pathname}`, monitor ? this.monitorCacheTtl : this.cacheTtl,
        () => this.performRequest(upper, pathname, body));
    }
    const data = await this.performRequest(upper, pathname, body);
    if (upper !== 'GET' && this.cache) await this.cache.invalidate();
    return data;
  }

  async performRequest(method, pathname, body) {
    if (this.cache) {
      const budget = await this.cache.rateLimit('cdnfly-upstream', this.cacheScope, this.requestsPerMinute, 60);
      if (!budget.allowed) throw new CdnflyError('CDN 服务请求过于频繁，请稍后重试', { status: 429 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init = {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'api-key': this.apiKey,
          'api-secret': this.apiSecret,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      };
      let response;
      const attempts = upperRequestAttempts(method);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          response = await this.fetch(`${this.baseUrl}${pathname}`, init);
          if (RETRYABLE_METHODS.has(method) && RETRYABLE_STATUS.has(response.status) && attempt < attempts - 1) {
            await response.body?.cancel().catch(() => {});
            await retryDelay(attempt);
            continue;
          }
          break;
        } catch (error) {
          if (!RETRYABLE_METHODS.has(method) || attempt >= attempts - 1 || error?.name === 'AbortError') throw error;
          await retryDelay(attempt);
        }
      }
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text || '上游返回非 JSON 内容' }; }
      if (!response.ok) {
        const providerMessage = providerDiagnostic(payload, response.status);
        throw new CdnflyError(upstreamErrorMessage(payload, response.status), { status: 502, upstreamStatus: response.status, providerMessage });
      }
      return unwrap(payload, response.status);
    } catch (error) {
      if (error instanceof CdnflyError) throw error;
      if (error.name === 'AbortError') throw new CdnflyError('CDN 服务请求超时，请稍后重试', { status: 504 });
      const failure = new CdnflyError('CDN 服务暂时不可用，请稍后重试', { providerMessage: error?.message || null });
      failure.requestMethod = method;
      failure.requestPath = pathname;
      failure.causeCode = error?.cause?.code || error?.code || null;
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  async download(pathname) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${pathname}`, {
        headers: { 'api-key': this.apiKey, 'api-secret': this.apiSecret },
        signal: controller.signal,
      });
      if (!response.ok) throw new CdnflyError('CDN 服务请求失败，请稍后重试', { status: 502, upstreamStatus: response.status, providerMessage: `HTTP ${response.status}` });
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      if (contentType.includes('application/json')) {
        const payload = await response.json();
        unwrap(payload, response.status);
        throw new CdnflyError('CDN 服务未返回证书文件');
      }
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType,
        disposition: response.headers.get('content-disposition') || 'attachment',
      };
    } catch (error) {
      if (error instanceof CdnflyError) throw error;
      if (error.name === 'AbortError') throw new CdnflyError('CDN 服务请求超时，请稍后重试', { status: 504 });
      throw new CdnflyError('CDN 服务暂时不可用，请稍后重试', { providerMessage: error?.message || null });
    } finally {
      clearTimeout(timer);
    }
  }

  async createSite(input) {
    const payload = {
      domain: input.domain,
      backend: [{ addr: input.origin, weight: 1, state: 'up' }],
      backend_protocol: input.backendProtocol || 'http',
      backend_host: input.backendHost || input.domain,
      http_listen: { port: '80', enable: 1 },
      websocket_enable: input.websocket ? 1 : 0,
      gzip_enable: input.gzip ? 1 : 0,
      enable: 1,
      user_package: this.packageId,
    };
    for (const field of [
      'http_listen', 'https_listen', 'backend_http_port', 'backend_https_port', 'proxy_timeout', 'balance_way',
      'block_proxy', 'recv_real_time', 'send_real_time', 'enable_ipv6', 'black_ip', 'white_ip', 'spider_to_sip',
    ]) {
      if (input[field] !== undefined) {
        payload[field] = input[field] && typeof input[field] === 'object' && !Array.isArray(input[field])
          ? { ...(payload[field] || {}), ...input[field] }
          : input[field];
      }
    }
    if (input.backend_protocol !== undefined && input.backendProtocol === undefined) payload.backend_protocol = input.backend_protocol;
    if (input.websocket_enable !== undefined && input.websocket === undefined) payload.websocket_enable = input.websocket_enable;
    if (input.gzip_enable !== undefined && input.gzip === undefined) payload.gzip_enable = input.gzip_enable;
    if (input.groups !== undefined) payload.groups = String(input.groups);
    const data = await this.request('POST', '/v1/sites', payload);
    const rawId = typeof data === 'object' ? (data.id ?? data.ids ?? data.site_id) : data;
    const id = String(rawId ?? '').split(',')[0].trim();
    if (!id) throw new CdnflyError('CDN 服务创建成功但未返回网站 ID');
    return { id };
  }

  getSite(id) {
    return this.request('GET', `/v1/sites/${encodeURIComponent(id)}`);
  }

  updateSite(id, input) {
    const payload = {};
    if (input.origin !== undefined) payload.backend = [{ addr: input.origin, weight: 1, state: 'up' }];
    if (input.backendProtocol !== undefined) payload.backend_protocol = input.backendProtocol;
    if (input.backendHost !== undefined) payload.backend_host = input.backendHost;
    if (input.websocket !== undefined) payload.websocket_enable = input.websocket ? 1 : 0;
    if (input.gzip !== undefined) payload.gzip_enable = input.gzip ? 1 : 0;
    if (input.enabled !== undefined) payload.enable = input.enabled ? 1 : 0;
    if (input.groups !== undefined) payload.groups = String(input.groups);
    return this.request('PUT', `/v1/sites/${encodeURIComponent(id)}`, payload);
  }

  deleteSite(id) {
    return this.request('DELETE', `/v1/sites/${encodeURIComponent(id)}`);
  }

  async health({ fresh = false } = {}) {
    const pathname = '/v1/sites?page=1&page_size=1';
    if (fresh) await this.performRequest('GET', pathname);
    else await this.request('GET', pathname);
    return true;
  }
}

function upperRequestAttempts(method) {
  if (method === 'GET') return 3;
  if (method === 'PUT') return 2;
  return 1;
}
