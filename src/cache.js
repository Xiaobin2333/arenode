import crypto from 'node:crypto';
import { createClient } from 'redis';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export class CacheService {
  constructor(config, client = null) {
    this.url = config.redisUrl;
    this.client = client || createClient({ url: this.url, socket: { connectTimeout: 5_000, reconnectStrategy: retries => Math.min(retries * 250, 5_000) } });
    this.client.on?.('error', error => { this.connected = false; this.lastError = error.message; });
    this.client.on?.('end', () => { this.connected = false; });
    this.connected = false;
    this.lastError = null;
    this.memory = new Map();
    this.inflight = new Map();
    this.generation = 1;
  }

  async connect() {
    try {
      if (!this.client.isOpen) await this.client.connect();
      await this.client.ping();
      await this.client.set('cdnfly:cache:generation', '1', { NX: true });
      this.connected = true;
      this.lastError = null;
    } catch (error) {
      this.connected = false;
      this.lastError = error.message;
    }
    return this;
  }

  async currentGeneration() {
    if (!this.connected) return this.generation;
    try {
      const value = await this.client.get('cdnfly:cache:generation');
      this.generation = Number(value || 1);
      return this.generation;
    } catch (error) {
      this.connected = false; this.lastError = error.message;
      return this.generation;
    }
  }

  async invalidate() {
    this.memory.clear();
    this.generation += 1;
    if (!this.connected) return;
    try { this.generation = Number(await this.client.incr('cdnfly:cache:generation')); }
    catch (error) { this.connected = false; this.lastError = error.message; }
  }

  async getOrSet(namespace, rawKey, ttlSeconds, loader) {
    const generation = await this.currentGeneration();
    const key = `cdnfly:cache:${generation}:${namespace}:${digest(rawKey)}`;
    const memory = this.memory.get(key);
    if (memory && memory.expiresAt > Date.now()) return structuredClone(memory.value);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = (async () => {
      if (this.connected) {
        try {
          const cached = await this.client.get(key);
          if (cached !== null) return JSON.parse(cached);
        } catch (error) { this.connected = false; this.lastError = error.message; }
      }
      const value = await loader();
      this.memory.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttlSeconds * 1000 });
      if (this.connected) {
        try { await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds }); }
        catch (error) { this.connected = false; this.lastError = error.message; }
      }
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  async rateLimit(scope, identity, limit, windowSeconds) {
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `cdnfly:rate:${scope}:${digest(String(identity))}:${bucket}`;
    if (this.connected) {
      try {
        const count = await this.client.incr(key);
        if (count === 1) await this.client.expire(key, windowSeconds + 1);
        return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
      } catch (error) { this.connected = false; this.lastError = error.message; }
    }
    const entry = this.memory.get(key) || { value: 0, expiresAt: Date.now() + windowSeconds * 1000 };
    entry.value += 1; this.memory.set(key, entry);
    return { allowed: entry.value <= limit, remaining: Math.max(0, limit - entry.value) };
  }

  async claimCooldown(scope, identity, seconds) {
    const key = `cdnfly:cooldown:${scope}:${digest(String(identity))}`;
    const token = crypto.randomUUID();
    if (this.connected) {
      try {
        const result = await this.client.set(key, token, { EX: seconds, NX: true });
        if (result === 'OK') return { allowed: true, retryAfter: 0, key, token };
        return { allowed: false, retryAfter: Math.max(1, await this.client.ttl(key)), key, token: null };
      } catch (error) { this.connected = false; this.lastError = error.message; }
    }
    const current = this.memory.get(key);
    if (current?.expiresAt > Date.now()) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.expiresAt - Date.now()) / 1000)), key, token: null };
    }
    this.memory.set(key, { value: token, expiresAt: Date.now() + seconds * 1000 });
    return { allowed: true, retryAfter: 0, key, token };
  }

  async releaseCooldown(claim) {
    if (!claim?.key || !claim.token) return;
    if (this.connected) {
      try {
        await this.client.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          { keys: [claim.key], arguments: [claim.token] },
        );
      } catch (error) { this.connected = false; this.lastError = error.message; }
    }
    const current = this.memory.get(claim.key);
    if (current?.value === claim.token) this.memory.delete(claim.key);
  }

  async health() {
    try {
      if (!this.client.isOpen) await this.client.connect();
      await this.client.ping();
      this.connected = true;
      this.lastError = null;
    } catch (error) {
      this.connected = false;
      this.lastError = error.message;
    }
    return { ok: this.connected, degraded: !this.connected, error: this.lastError };
  }

  async close() {
    if (this.client.isOpen) await this.client.quit();
  }
}
