// Site and stream ports share an allowance. Keep the cross-process user lock
// through both upstream mutation and persistence of the resulting local usage.
export async function withResourceMutation(db, userId, callback) {
  const result = await db.withAdvisoryLock(`resource-mutation:${userId}`, callback);
  if (!result.acquired) throw Object.assign(new Error('资源正在更新，请稍后重试'), { status: 409 });
  return result.value;
}
