import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { parseHTML } from 'linkedom';
import { opError } from './operations-settings.js';

export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export async function fetchPublicPage(value, { resolve = lookup, timeoutMs = 15000, maxBytes = 512 * 1024, get = (url, options, callback) => (url.protocol === 'https:' ? https : http).get(url, options, callback) } = {}) {
  let url = new URL(value);
  for (let redirect = 0; redirect <= 4; redirect++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw opError('仅巡查公网 HTTP/HTTPS 标准端口');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let dnsTimer; let addresses;
    try {
      addresses = ipaddr.isValid(host) ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }] : await Promise.race([
        resolve(host, { all: true, verbatim: true }),
        new Promise((_resolve, reject) => { dnsTimer = setTimeout(() => reject(opError('DNS 解析超时')), timeoutMs); }),
      ]);
    } finally { clearTimeout(dnsTimer); }
    if (!addresses.length || addresses.some(row => !publicAddress(row.address))) throw opError('巡查目标或重定向解析到非公网地址');
    const selected = addresses[0];
    const response = await new Promise((resolveResponse, reject) => {
      const request = get(url, {
        agent: false, headers: { 'user-agent': 'Arenode-SiteInspection/1.0', accept: 'text/html,text/plain', 'accept-encoding': 'identity' },
        lookup: (_host, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) { res.destroy(); resolveResponse({ redirect: res.headers.location }); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); reject(opError(`网站返回 HTTP ${res.statusCode}`)); return; }
        if (!/^text\/(html|plain)/i.test(res.headers['content-type'] || '') || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) { res.destroy(); reject(opError('页面不是可检查的未压缩文本')); return; }
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > maxBytes) request.destroy(opError('页面超过抓取大小限制')); else chunks.push(chunk); });
        res.on('end', () => resolveResponse({ text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      const timer = setTimeout(() => request.destroy(opError('页面抓取超时')), timeoutMs);
      request.on('close', () => clearTimeout(timer)); request.on('error', reject);
    });
    if (response.redirect) { url = new URL(response.redirect, url); continue; }
    if (response.text === undefined) throw opError('重定向缺少地址');
    const { document } = parseHTML(response.text);
    const links = [...document.querySelectorAll('a[href]')].slice(0, 100).map(a => {
      try { const target = new URL(a.getAttribute('href'), url); target.hash = ''; return target.origin === url.origin ? target.href : null; } catch { return null; }
    }).filter(Boolean);
    for (const element of document.querySelectorAll('script,style,noscript,svg')) element.remove();
    const text = (document.body?.textContent || document.documentElement?.textContent || response.text).replace(/\s+/g, ' ').trim().slice(0, 20000);
    if (text.length < 30) throw opError('可读文本不足，需人工检查（可能为图片或 JavaScript 页面）');
    return { url: url.href, text, links: [...new Set(links)], title: document.title.slice(0, 300) };
  }
  throw opError('重定向次数过多');
}
