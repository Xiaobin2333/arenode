import fs from 'node:fs';

const versionUrl = process.env.ARENODE_CDP_VERSION_URL;
const appUrl = process.env.ARENODE_APP_URL;
if (!versionUrl) throw new Error('请通过 ARENODE_CDP_VERSION_URL 指定 CDP /json/version 地址');
if (!appUrl) throw new Error('请通过 ARENODE_APP_URL 指定可由 CDP 浏览器访问的 Arenode 控制台地址');
const version = await (await fetch(versionUrl)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });

let nextId = 0; const pending = new Map(); const eventListeners = new Set();
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const pendingCommand = pending.get(message.id); pending.delete(message.id);
    if (message.error) pendingCommand.reject(new Error(message.error.message)); else pendingCommand.resolve(message.result || {});
  } else for (const listener of eventListeners) listener(message);
});
function command(method, params = {}, sessionId) {
  const id = ++nextId; socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function once(method, sessionId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { eventListeners.delete(handler); reject(new Error(`等待 ${method} 超时`)); }, timeoutMs);
    const handler = message => { if (message.method !== method || message.sessionId !== sessionId) return; clearTimeout(timeout); eventListeners.delete(handler); resolve(message.params || {}); };
    eventListeners.add(handler);
  });
}
async function evaluate(sessionId, expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || '页面脚本异常');
  return response.result?.value;
}
async function waitFor(sessionId, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(sessionId, `Boolean(${expression})`).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`页面状态等待超时: ${expression}`);
}

const { browserContextId } = await command('Target.createBrowserContext', { disposeOnDetach: true });
const { targetId } = await command('Target.createTarget', { url: 'about:blank', browserContextId });
const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
await Promise.all([command('Page.enable', {}, sessionId), command('Runtime.enable', {}, sessionId), command('Network.enable', {}, sessionId)]);
const failures = []; const exceptions = [];
eventListeners.add(message => {
  if (message.sessionId !== sessionId) return;
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails?.text || '页面异常');
  if (message.method === 'Network.loadingFailed') failures.push(message.params.errorText || '资源加载失败');
  if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) failures.push(`${message.params.response.status} ${new URL(message.params.response.url).pathname}`);
});
const loaded = once('Page.loadEventFired', sessionId); await command('Page.navigate', { url: appUrl }, sessionId); await loaded;
await waitFor(sessionId, "document.readyState === 'complete' && !document.querySelector('#loginView').classList.contains('hidden')");
await new Promise(resolve => setTimeout(resolve, 800));
const desktop = await evaluate(sessionId, `({
  title: document.title,
  brand: document.querySelector('[data-site-name]').textContent,
  appVersion: document.querySelector('script[src*="app.js"]')?.src || '',
  loginVisible: !document.querySelector('#loginForm').classList.contains('hidden'),
  bodyWidth: document.body.scrollWidth,
  viewportWidth: document.documentElement.clientWidth,
  formRect: (() => { const r = document.querySelector('#loginForm').getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; })(),
})`);
await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
await new Promise(resolve => setTimeout(resolve, 400));
const mobile = await evaluate(sessionId, `({
  bodyWidth: document.body.scrollWidth,
  viewportWidth: document.documentElement.clientWidth,
  formRect: (() => { const r = document.querySelector('#loginForm').getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; })(),
  mobileBrandVisible: getComputedStyle(document.querySelector('.mobile-brand')).display !== 'none',
})`);
const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
fs.mkdirSync(new URL('../.artifacts/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../.artifacts/cdp-login-final.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
if (!desktop.appVersion.includes('app.js?v=arenode') || !desktop.loginVisible || desktop.bodyWidth > desktop.viewportWidth || mobile.bodyWidth > mobile.viewportWidth || !mobile.mobileBrandVisible || failures.length || exceptions.length) {
  throw new Error(JSON.stringify({ desktop, mobile, failures, exceptions }));
}
console.log(JSON.stringify({ browser: version.Browser, desktop, mobile, failures, exceptions, screenshot: '.artifacts/cdp-login-final.png' }, null, 2));
await command('Target.closeTarget', { targetId }).catch(() => {}); await command('Target.disposeBrowserContext', { browserContextId }).catch(() => {}); socket.close();
