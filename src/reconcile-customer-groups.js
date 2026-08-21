import { loadConfig } from './config.js';
import { createPostgresDatabase } from './db.js';
import { CacheService } from './cache.js';
import { CdnflyClient } from './cdnfly.js';
import { UpstreamService } from './upstreams.js';
import { reconcileCustomerUpstreamGroups } from './customer-group-reconciliation.js';

const config = loadConfig();
const db = await createPostgresDatabase(config.databaseUrl);
const cache = await new CacheService(config).connect();
try {
  const cdnfly = new CdnflyClient(config, fetch, cache);
  const upstreams = await new UpstreamService(db, config, cache, { legacyClient: cdnfly }).initialize();
  const cleanupLegacy = process.argv.includes('--cleanup-legacy');
  const result = await reconcileCustomerUpstreamGroups({ db, upstreams, cdnfly, cleanupLegacy, strict: true });
  console.log(JSON.stringify(result));
} catch (error) {
  if (error.result) console.error(JSON.stringify(error.result));
  throw error;
} finally {
  await Promise.allSettled([db.close(), cache.close()]);
}
