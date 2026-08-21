import net from 'node:net';

export function validateDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (domain.length > 253 || !domain.includes('.') || !/^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error('请输入有效域名');
  }
  return domain;
}

export function validateOrigin(value) {
  const origin = String(value || '').trim();
  if (origin.length > 253 || (!net.isIP(origin) && !/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(origin))) {
    throw new Error('请输入有效的源站 IP 或主机名');
  }
  return origin.toLowerCase();
}

export function validateSiteInput(body, partial = false) {
  const result = {};
  if (!partial || body.domain !== undefined) result.domain = validateDomain(body.domain);
  if (!partial || body.origin !== undefined) result.origin = validateOrigin(body.origin);
  if (body.backendProtocol !== undefined) {
    if (!['http', 'https'].includes(body.backendProtocol)) throw new Error('回源协议无效');
    result.backendProtocol = body.backendProtocol;
  }
  if (body.backendHost !== undefined) result.backendHost = validateDomain(body.backendHost);
  for (const key of ['websocket', 'gzip', 'enabled']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`);
      result[key] = body[key];
    }
  }
  return result;
}
