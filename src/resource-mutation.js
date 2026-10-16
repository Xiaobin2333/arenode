// Site and stream ports share an allowance. Keep the cross-process user lock
// through both upstream mutation and persistence of the resulting local usage.
import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage();
export async function withResourceMutation(db, userId, callback, { allowReentrant = false } = {}) {
  const existing = context.getStore(); const key = `resource-mutation:${userId}`;
  if (allowReentrant && existing?.db === db && existing.keys.has(key)) return callback();
  const keys = new Set(existing?.db === db ? existing.keys : []); keys.add(key);
  const result = await db.withAdvisoryLock(key, () => context.run({ db, keys }, callback));
  if (!result.acquired) throw Object.assign(new Error('资源正在更新，请稍后重试'), { status: 409 });
  return result.value;
}
