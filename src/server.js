import http from 'node:http';
import { assertProductionConfig, loadConfig } from './config.js';
import { createPostgresDatabase, bootstrapAdmin } from './db.js';
import { CdnflyClient } from './cdnfly.js';
import { createApp } from './app.js';
import { BillingService } from './billing.js';
import { CacheService } from './cache.js';
import { MailService } from './mailer.js';
import { getRuntimeSettings } from './settings.js';
import { UpstreamService } from './upstreams.js';
import { reconcileCustomerUpstreamGroups } from './customer-group-reconciliation.js';
import { BRAND_NAME } from './brand.js';

const config = loadConfig();
if (process.env.NODE_ENV === 'production') assertProductionConfig(config);
const db = await createPostgresDatabase(config.databaseUrl);
const cache = await new CacheService(config).connect();
if (!cache.connected) console.warn(`警告: Redis 不可用，缓存和限流已降级到进程内存: ${cache.lastError}`);
const created = await bootstrapAdmin(db, config.adminUsername, config.adminPassword);
if (created) console.log(`已创建管理员: ${config.adminUsername}`);

const cdnfly = new CdnflyClient(config, fetch, cache);
const upstreams = await new UpstreamService(db, config, cache, { legacyClient: cdnfly }).initialize();
const configuredUpstream = (await upstreams.list()).some(account => account.status === 'active' && account.credentialConfigured);
if (!configuredUpstream) console.warn('警告: 未配置可用的 CDNFly 上游账户，CDN 服务操作将失败');
const mailer = new MailService(config);
if (!mailer.available) console.warn('警告: 邮件服务未配置，自助注册和找回密码暂不可用');
const initialSettings = await getRuntimeSettings(db, config);
if (initialSettings.registrationEnabled && (!initialSettings.emailVerificationEnabled || !initialSettings.turnstileEnabled)) {
  console.warn('警告: 公开注册已开启，但邮箱验证或 Turnstile 尚未启用');
}
const billing = await new BillingService(db, cdnfly, { renewalGraceDays: initialSettings.renewalGraceDays,
  settingsProvider: () => getRuntimeSettings(db, config), upstreams }).initialize();
billing.startScheduler();
const server = http.createServer(createApp({ db, cdnfly, upstreams, config, billing, cache, mailer }));
server.listen(config.port, () => {
  console.log(`${BRAND_NAME} 已启动: ${config.appOrigin}`);
  void reconcileCustomerUpstreamGroups({ db, upstreams, cdnfly }).then(result => {
    console.log(`客户上游分组对账完成: ${result.pairs} 个客户上游关系，${result.sites} 个网站，${result.streams} 个转发，清理 ${result.staleStreamsRemoved} 个陈旧转发，${result.errors.length} 个失败项`);
    for (const error of result.errors) console.error(`客户上游分组对账失败: ${error.kind}#${error.resourceId || '-'} ${error.message}`);
  }).catch(error => console.error(`客户上游分组对账失败: ${error.message}`));
});

function shutdown() {
  server.close(async () => { await Promise.allSettled([db.close(), cache.close()]); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
