import pg from 'pg';

// Every application process holds a shared session lock before migrations/startup.
// An exclusive upgrade only succeeds when this is the sole live instance.
export async function acquireOperationsLease(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'arenode-instance', keepAlive: true });
  await client.connect();
  client.on('error', () => { console.error('数据库实例保护连接断开，停止进程'); process.exit(1); });
  const key = [178301902, 1];
  await client.query('SELECT pg_advisory_lock_shared($1,$2)', key);
  return {
    async exclusive() { return (await client.query('SELECT pg_try_advisory_lock($1,$2) AS locked', key)).rows[0].locked; },
    async releaseExclusive() { await client.query('SELECT pg_advisory_unlock($1,$2)', key); },
    async close() { await client.end(); },
  };
}
