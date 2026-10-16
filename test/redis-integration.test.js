import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CacheService } from '../src/cache.js';

test('Redis integration shares cache, invalidation, rate limits and token-checked cooldowns', { skip: !process.env.TEST_REDIS_URL }, async t => {
  const config = { redisUrl: process.env.TEST_REDIS_URL };
  const first = new CacheService(config); const second = new CacheService(config);
  t.after(async () => { await Promise.all([first.close(), second.close()]); });
  await Promise.all([first.connect(), second.connect()]);
  assert.equal(first.connected, true); assert.equal(second.connected, true);
  const scope = `integration-${randomUUID()}`;
  assert.deepEqual(await first.getOrSet(scope, 'key', 30, async () => ({ value: 1 })), { value: 1 });
  assert.deepEqual(await second.getOrSet(scope, 'key', 30, () => assert.fail('cache not shared')), { value: 1 });
  await first.invalidate();
  assert.deepEqual(await second.getOrSet(scope, 'key', 30, async () => ({ value: 2 })), { value: 2 });
  assert.equal((await first.rateLimit(scope, 'client', 1, 3600)).allowed, true);
  assert.equal((await second.rateLimit(scope, 'client', 1, 3600)).allowed, false);
  const claim = await first.claimCooldown(scope, 'client', 30);
  assert.equal(claim.allowed, true);
  assert.equal((await second.claimCooldown(scope, 'client', 30)).allowed, false);
  await second.releaseCooldown({ ...claim, token: 'not-the-owner' });
  assert.equal((await second.claimCooldown(scope, 'client', 30)).allowed, false);
  await first.releaseCooldown(claim);
  const next = await second.claimCooldown(scope, 'client', 30);
  assert.equal(next.allowed, true); await second.releaseCooldown(next);
  assert.equal((await first.health()).ok, true);
});
