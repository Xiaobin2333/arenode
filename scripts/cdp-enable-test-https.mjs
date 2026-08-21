import assert from 'node:assert/strict';
import { loadConfig } from 'file:///app/src/config.js';
import { createPostgresDatabase } from 'file:///app/src/db.js';
import { newSessionToken, tokenDigest } from 'file:///app/src/security.js';

if (String(process.env.RUN_REAL_CDNFLY_WRITE_TESTS || '') !== '1') throw new Error('必须显式设置 RUN_REAL_CDNFLY_WRITE_TESTS=1');
const allowedDomain = String(process.env.REAL_TEST_DOMAIN || '').trim().toLowerCase();
const allowedSiteId = Number(process.env.REAL_TEST_SITE_ID || 0);
const allowedCertificateId = Number(process.env.REAL_TEST_CERTIFICATE_ID || 0);
const appUrl = process.env.ARENODE_APP_URL;
const cdpBase = process.env.ARENODE_CDP_URL;
if (!allowedDomain || !allowedSiteId || !allowedCertificateId || !appUrl || !cdpBase) {
  throw new Error('需要 REAL_TEST_DOMAIN、REAL_TEST_SITE_ID、REAL_TEST_CERTIFICATE_ID、ARENODE_APP_URL 和 ARENODE_CDP_URL');
}
const appHost = new URL(appUrl).hostname;
const cdpHost = new URL(cdpBase).hostname;
const recommendedCiphers = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384';
const config = loadConfig();
const db = await createPostgresDatabase(config.databaseUrl);
const token = newSessionToken();
const digest = tokenDigest(token);
let socket;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

try {
  const site = await db.prepare(`SELECT s.*,u.role FROM sites s JOIN users u ON u.id=s.owner_id
    WHERE lower(s.domain)=? ORDER BY s.id`).get(allowedDomain);
  assert.ok(site, `未找到 ${allowedDomain}`);
  assert.equal(Number(site.id), allowedSiteId, '测试站点本地 ID 已变化');
  assert.equal(site.role, 'user');
  const ownerSites = await db.prepare('SELECT id,domain FROM sites WHERE owner_id=? ORDER BY id').all(site.owner_id);
  assert.deepEqual(ownerSites.map(item => ({ id: Number(item.id), domain: item.domain })), [{ id: allowedSiteId, domain: allowedDomain }]);
  const certificate = await db.prepare("SELECT id,snapshot FROM tenant_resources WHERE owner_id=? AND kind='certs' AND id=?").get(site.owner_id, allowedCertificateId);
  assert.ok(certificate, '未找到测试证书');
  const certificateSnapshot = typeof certificate.snapshot === 'string' ? JSON.parse(certificate.snapshot) : certificate.snapshot;
  assert.equal(String(certificateSnapshot?.domain || '').toLowerCase(), allowedDomain, '测试证书域名不匹配');

  await db.prepare(`INSERT INTO sessions (token_hash,user_id,expires_at,ip,user_agent)
    VALUES (?,?,CURRENT_TIMESTAMP + INTERVAL '5 minutes',?,?)`).run(digest, site.owner_id, cdpHost, 'Arenode HTTPS write acceptance');

  const targets = await fetch(`${cdpBase}/json/list`).then(response => response.json());
  const target = targets.find(item => item.type === 'page' && String(item.url).startsWith(appUrl));
  assert.ok(target, 'CDP 中没有本地 Arenode 页面');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
  const waitFor = async (expression, timeout = 20_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return;
      await delay(250);
    }
    throw new Error(`页面等待超时: ${expression}`);
  };

  await send('Network.enable');
  await send('Network.deleteCookies', { name: 'cdnfly_session', domain: appHost, path: '/' });
  await send('Page.navigate', { url: appUrl });
  await waitFor(`location.origin === ${JSON.stringify(new URL(appUrl).origin)}`);
  await evaluate(`document.cookie = ${JSON.stringify(`cdnfly_session=${token}; Path=/; SameSite=Lax`)}`);
  await send('Page.reload', { ignoreCache: true });
  await waitFor('document.querySelector("#appView") && !document.querySelector("#appView").classList.contains("hidden")');
  await evaluate('document.querySelector(".tenant-nav [data-view=\\"sites\\"]").click()');
  await waitFor('document.querySelectorAll("#siteTable tr").length === 1');
  await evaluate('document.querySelector("#siteTable [data-manage]").click()');
  await waitFor(`document.querySelector('#detailSiteDomain')?.textContent === ${JSON.stringify(allowedDomain)} && document.querySelector('#siteDetailForm').elements.httpsCert.options.length > 1`);
  const baseline = await evaluate(`fetch('/api/cdnfly/v1/sites/${allowedSiteId}').then(response => response.json())`);
  assert.equal(baseline.data?.domain, allowedDomain);

  await evaluate(`(() => {
    document.querySelector('[data-site-section="siteHttps"]').click();
    const form = document.querySelector('#siteDetailForm');
    form.elements.httpsCert.value = ${JSON.stringify(String(allowedCertificateId))};
    form.elements.httpsEnabled.checked = true;
    form.elements.sslCiphers.value = '';
    for (const input of form.querySelectorAll('[name="sslProtocol"]')) input.checked = ['TLSv1.2', 'TLSv1.3'].includes(input.value);
    form.requestSubmit();
  })()`);
  await waitFor(`document.querySelector('#toast').classList.contains('show') && (document.querySelector('#toast').textContent.includes('网站配置已保存') || document.querySelector('#toast').classList.contains('error'))`);
  const toast = await evaluate(`({ text: document.querySelector('#toast').textContent, error: document.querySelector('#toast').classList.contains('error') })`);
  assert.equal(toast.error, false, toast.text);
  const updated = await evaluate(`fetch('/api/cdnfly/v1/sites/${allowedSiteId}').then(response => response.json())`);
  assert.equal(updated.data?.domain, allowedDomain);
  assert.ok([1, true, '1', 'on'].includes(updated.data?.https_listen?.ok ?? updated.data?.https_listen?.enable), 'HTTPS 未启用');
  assert.equal(Number(updated.data?.https_listen?.cert), allowedCertificateId, 'HTTPS 证书未保存');
  assert.equal(updated.data?.https_listen?.ssl_protocols, 'TLSv1.2 TLSv1.3');
  assert.equal(updated.data?.https_listen?.ssl_ciphers, recommendedCiphers, 'HTTPS 推荐加密套件未保存');
  console.log(JSON.stringify({
    domain: updated.data.domain,
    localSiteId: allowedSiteId,
    certificateId: allowedCertificateId,
    https: {
      enabled: true,
      port: updated.data.https_listen.port,
      ssl_protocols: updated.data.https_listen.ssl_protocols,
      ssl_ciphers: `${updated.data.https_listen.ssl_ciphers.length} chars`,
    },
    toast,
  }, null, 2));
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: 1_000_000, method: 'Runtime.evaluate', params: { expression: 'document.cookie = "cdnfly_session=; Path=/; Max-Age=0; SameSite=Lax"' } }));
    await delay(100).catch(() => {});
  }
  socket?.close();
  await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest).catch(() => {});
  await db.close();
}
