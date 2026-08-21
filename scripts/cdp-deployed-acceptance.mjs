import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadConfig } from 'file:///app/src/config.js';
import { createPostgresDatabase } from 'file:///app/src/db.js';
import { newSessionToken, tokenDigest } from 'file:///app/src/security.js';

const allowedDomain = String(process.env.ARENODE_ACCEPTANCE_DOMAIN || '').trim().toLowerCase();
const appUrl = process.env.ARENODE_APP_URL;
const cdpBase = process.env.ARENODE_CDP_URL;
if (!allowedDomain || !appUrl || !cdpBase) throw new Error('需要 ARENODE_ACCEPTANCE_DOMAIN、ARENODE_APP_URL 和 ARENODE_CDP_URL');
const appHost = new URL(appUrl).hostname;
const cdpHost = new URL(cdpBase).hostname;
const config = loadConfig();
const db = await createPostgresDatabase(config.databaseUrl);
const token = newSessionToken();
const digest = tokenDigest(token);
let socket;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function expectedCertificateStatus(resource) {
  if ([0, false, '0', 'false', 'off', 'disabled', 'inactive'].includes(resource.enable)) return '禁用';
  const issue = String(resource.issue_state || '').toLowerCase();
  const sync = String(resource.sync_state || '').toLowerCase();
  const taskRunning = [1, true, '1', 'true', 'on'].includes(resource.task_enable);
  if (issue === 'pending') return '待签发';
  if (issue === 'process') return '签发中';
  if (issue === 'failed') return taskRunning ? '签发失败，重试中' : '签发失败，已取消';
  if (sync === 'pending') return '待同步';
  if (sync === 'process') return '同步中';
  if (sync === 'failed') return '同步失败';
  return '正常';
}

try {
  const site = await db.prepare(`SELECT s.*,u.role FROM sites s JOIN users u ON u.id=s.owner_id
    WHERE lower(s.domain)=? ORDER BY s.id`).get(allowedDomain);
  assert.ok(site); assert.equal(site.role, 'user');
  const ownerSites = await db.prepare('SELECT domain FROM sites WHERE owner_id=?').all(site.owner_id);
  assert.deepEqual(ownerSites.flatMap(item => String(item.domain).split(/[\s,]+/).filter(Boolean)), [allowedDomain]);
  await db.prepare(`INSERT INTO sessions (token_hash,user_id,expires_at,ip,user_agent)
    VALUES (?,?,CURRENT_TIMESTAMP + INTERVAL '5 minutes',?,?)`).run(digest, site.owner_id, cdpHost, 'Arenode CDP acceptance');

  const targets = await fetch(`${cdpBase}/json/list`).then(response => response.json());
  const target = targets.find(item => item.type === 'page' && String(item.url).startsWith(appUrl));
  assert.ok(target, 'CDP 中没有本地 Arenode 页面');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data); const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
  const waitFor = async (expression, timeout = 15_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return;
      await delay(250);
    }
    throw new Error(`页面等待超时: ${expression}`);
  };
  const screenshot = async path => {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(path, Buffer.from(result.data, 'base64'));
  };

  await send('Network.enable'); await send('Page.enable');
  await send('Network.deleteCookies', { name: 'cdnfly_session', domain: appHost, path: '/' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: appUrl });
  await waitFor(`location.origin === ${JSON.stringify(new URL(appUrl).origin)}`);
  await evaluate(`document.cookie = ${JSON.stringify(`cdnfly_session=${token}; Path=/; SameSite=Lax`)}`);
  const storedCookies = await send('Network.getCookies', { urls: [appUrl] });
  assert.ok(storedCookies.cookies.some(item => item.name === 'cdnfly_session' && item.domain === appHost), 'CDP 未保存同源会话 Cookie');
  await send('Page.reload', { ignoreCache: true });
  const authProbe = await evaluate('fetch("/api/me").then(async response => ({ status: response.status, error: (await response.json().catch(() => ({}))).error || "" }))');
  assert.equal(authProbe.status, 200, `CDP 同源会话验证失败: ${authProbe.status} ${authProbe.error}`);
  await waitFor('document.querySelector("#appView") && !document.querySelector("#appView").classList.contains("hidden")');
  await waitFor('document.querySelectorAll("#recentSites tr").length === 1');
  await waitFor('document.querySelector("#trafficChart") && document.querySelector("#trafficChart").width > 0');
  await delay(1000);
  const overview = await evaluate(`(() => {
    const canvas = document.querySelector('#trafficChart'); const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0; for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 100 && pixels[index + 1] > 70 && pixels[index + 1] < 190 && pixels[index + 2] > 190 && pixels[index + 3] > 0) blue += 1;
    const empty = document.querySelector('#chartEmpty');
    return { blue, version: performance.getEntriesByType('resource').map(item => item.name).find(name => name.includes('/app.js?v=')) || '', emptyVisible: !empty.classList.contains('hidden'), emptyText: empty.textContent };
  })()`);
  assert.ok(overview.blue > 20, '核心趋势画布未绘制流量数据线'); assert.equal(overview.emptyVisible, false);
  assert.match(overview.version, /[?&]v=arenode(?:&|$)/);
  await screenshot('/tmp/arenode-overview-desktop.png');

  await evaluate('document.querySelector(".tenant-nav [data-monitor-endpoint=\\"access-log\\"]").click()');
  await waitFor('document.querySelectorAll("#monitorTable tr").length > 0');
  const access = await evaluate(`(() => ({
    headers: [...document.querySelectorAll('#monitorTableHead th')].map(item => item.textContent.trim()),
    rows: document.querySelectorAll('#monitorTable tr').length,
    cells: document.querySelector('#monitorTable tr')?.children.length || 0,
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }))()`);
  assert.equal(access.headers.length, 19); assert.equal(access.cells, 19); assert.ok(access.rows > 0); assert.equal(access.pageOverflow, false);
  for (const label of ['地理位置', '运营商', '源地址', '内容类型', '来源', '浏览器', '回源耗时', '返回字节', '缓存命中']) assert.ok(access.headers.includes(label));
  await screenshot('/tmp/arenode-access-log-desktop.png');

  await evaluate('document.querySelector("#monitorRail [data-monitor-mode=\\"quality\\"]").click()');
  await waitFor('document.querySelector("#monitorForm").elements.metric.value === "status-4xx"');
  await waitFor('document.querySelector("#monitorCount").textContent !== "查询中"');
  const quality = await evaluate(`(() => ({ metric: document.querySelector('#monitorForm').elements.metric.value,
    title: document.querySelector('#dataPageTitle').textContent, count: document.querySelector('#monitorCount').textContent }))()`);
  assert.equal(quality.metric, 'status-4xx'); assert.equal(quality.title, '质量监控');

  await evaluate('document.querySelector(".tenant-nav [data-view=\\"sites\\"]").click()');
  await waitFor('document.querySelectorAll("#siteTable tr").length === 1');
  await evaluate('document.querySelector("#siteTable [data-manage]").click()');
  await waitFor('document.querySelector("#site-detail").classList.contains("active") && document.querySelectorAll("#siteBackendList .site-backend-row").length > 0');
  await waitFor('document.querySelector("#siteDetailForm").elements.httpsCert.options.length > 1');
  await evaluate('document.querySelector("[data-site-section=\\"siteAdvanced\\"]").click()');
  const siteDetail = await evaluate(`(() => ({
    domain: document.querySelector('#detailSiteDomain').textContent,
    sections: document.querySelectorAll('[data-site-section]').length,
    active: document.querySelector('.detail-section.active')?.id,
    errorPages: ['403','404','500','502','504'].every(code => document.querySelector('[name="page' + code + '"]')),
    postSizeUnit: document.querySelector('[name="postSizeUnit"]')?.value
  }))()`);
  assert.equal(siteDetail.domain, allowedDomain); assert.equal(siteDetail.sections, 8); assert.equal(siteDetail.active, 'siteAdvanced'); assert.equal(siteDetail.errorPages, true);
  await evaluate('document.querySelector("[data-site-section=\\"siteHttps\\"]").click()');
  const httpsForm = await evaluate(`(async () => {
    const detail = await fetch('/api/cdnfly/v1/sites/${site.id}').then(response => response.json());
    const rawProtocols = detail.data?.https_listen?.ssl_protocols || 'TLSv1.2 TLSv1.3';
    return {
      ciphers: document.querySelector('#siteDetailForm').elements.sslCiphers.value,
      protocols: [...document.querySelectorAll('#siteDetailForm [name="sslProtocol"]:checked')].map(item => item.value),
      upstreamProtocols: (Array.isArray(rawProtocols) ? rawProtocols : String(rawProtocols).split(/[\\s,]+/)).filter(Boolean),
      certificateOptions: document.querySelector('#siteDetailForm').elements.httpsCert.options.length
    };
  })()`);
  assert.ok(httpsForm.ciphers.includes('ECDHE-RSA-AES128-GCM-SHA256'), 'HTTPS 页面未预填推荐加密套件');
  assert.deepEqual(httpsForm.protocols, httpsForm.upstreamProtocols);
  assert.ok(httpsForm.certificateOptions > 1, 'HTTPS 页面未加载客户证书');
  await screenshot('/tmp/arenode-site-detail-desktop.png');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(500);
  const mobile = await evaluate(`(() => ({ width: innerWidth, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    active: document.querySelector('.detail-section.active')?.id }))()`);
  assert.equal(mobile.width, 390); assert.equal(mobile.pageOverflow, false); assert.equal(mobile.active, 'siteHttps');
  await screenshot('/tmp/arenode-site-detail-mobile.png');

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector(".tenant-nav [data-kind=\\"certs\\"]").click()');
  await waitFor('document.querySelector("#security").classList.contains("active") && document.querySelectorAll("#resourceTable tr").length === 2 && !document.querySelector("#resourceCreatedHeader").classList.contains("hidden")');
  const certificates = await evaluate(`(async () => ({
    headers: [...document.querySelectorAll('#resourceTable')].flatMap(table => [...table.closest('table').querySelectorAll('thead th:not(.hidden)')].map(item => item.textContent.trim())),
    rows: [...document.querySelectorAll('#resourceTable tr')].map(row => [...row.children].map(cell => cell.textContent.trim())),
    resources: await fetch('/api/cdnfly/v1/certs').then(response => response.json()).then(body => Array.isArray(body.data) ? body.data : body.data?.items || []),
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }))()`);
  for (const label of ['创建时间', '到期时间', '自动续签', '状态']) assert.ok(certificates.headers.includes(label));
  for (const row of certificates.rows) {
    assert.notEqual(row[5], '-', '证书创建时间未显示');
    assert.notEqual(row[6], '-', '证书到期时间缺失时应显示上游未返回');
    const resource = certificates.resources.find(item => `#${item.id}` === row[1]);
    assert.ok(resource, `找不到证书 ${row[1]} 的接口数据`);
    assert.equal(row[7], [1, true, '1', 'true', 'on', 'enabled'].includes(resource.auto_renew) ? '已开启' : '未开启');
    assert.equal(row[8], expectedCertificateStatus(resource));
  }
  certificates.resources = certificates.resources.map(resource => ({
    id: resource.id, issue_state: resource.issue_state, sync_state: resource.sync_state,
    task_enable: resource.task_enable, auto_renew: resource.auto_renew, create_at2: resource.create_at2, expire_time2: resource.expire_time2,
  }));
  await screenshot('/tmp/arenode-certificates-desktop.png');
  console.log(JSON.stringify({ targetId: target.id, overview, access, quality, siteDetail, httpsForm: { ...httpsForm, ciphers: `${httpsForm.ciphers.length} chars` }, mobile, certificates }, null, 2));
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    let cleanupId = 1_000_000;
    socket.send(JSON.stringify({ id: cleanupId, method: 'Runtime.evaluate', params: { expression: 'document.cookie = "cdnfly_session=; Path=/; Max-Age=0; SameSite=Lax"' } }));
    await delay(100).catch(() => {});
  }
  socket?.close();
  await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest).catch(() => {});
  await db.close();
}
