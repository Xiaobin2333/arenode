import { isSuperAdmin } from './admin-security.js';

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }

export async function handleUpstreamApi({ req, url, user, db, upstreams, readBody }) {
  if (!url.pathname.startsWith('/api/admin/upstreams')) return null;
  if (user.role !== 'admin') throw httpError('无管理员权限', 403);
  if (!upstreams) throw httpError('多上游服务未启用', 503);

  if (url.pathname === '/api/admin/upstreams' && req.method === 'GET') {
    return { status: 200, data: { upstreams: await upstreams.list() } };
  }
  if (!isSuperAdmin(user)) throw httpError('仅超级管理员可管理 CDNFly 上游', 403);
  if (url.pathname === '/api/admin/upstreams' && req.method === 'POST') {
    const account = await upstreams.create(await readBody(req), user.id);
    return { status: 201, data: { upstream: account }, action: 'upstream.create', resourceId: account.id };
  }

  const accountMatch = url.pathname.match(/^\/api\/admin\/upstreams\/(\d+)$/);
  if (accountMatch && req.method === 'PUT') {
    const id = Number(accountMatch[1]); const body = await readBody(req);
    if (body.status === 'disabled') {
      const active = Number((await db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE upstream_id=? AND status IN ('active','suspended','pending')").get(id)).count);
      if (active) throw httpError('该上游仍有生效客户套餐，迁移或到期后才能停用', 409);
    }
    const account = await upstreams.update(id, body);
    return { status: 200, data: { upstream: account }, action: 'upstream.update', resourceId: id };
  }

  const testMatch = url.pathname.match(/^\/api\/admin\/upstreams\/(\d+)\/test$/);
  if (testMatch && req.method === 'POST') {
    const result = await upstreams.test(Number(testMatch[1]), { fresh: true });
    return { status: result.ok || result.degraded ? 200 : 502, data: result, action: 'upstream.test', resourceId: testMatch[1] };
  }

  const availablePackagesMatch = url.pathname.match(/^\/api\/admin\/upstreams\/(\d+)\/available-packages$/);
  if (availablePackagesMatch && req.method === 'GET') {
    const upstreamId = Number(availablePackagesMatch[1]);
    return { status: 200, data: { packages: await upstreams.syncAvailablePackages(upstreamId) } };
  }

  const packagesMatch = url.pathname.match(/^\/api\/admin\/upstreams\/(\d+)\/packages$/);
  if (packagesMatch && req.method === 'POST') {
    const upstreamId = Number(packagesMatch[1]); const body = await readBody(req);
    const available = await upstreams.availablePackages(upstreamId); const selected = available.find(item => item.packageId === String(body.packageId));
    if (!selected) throw httpError('所选上游套餐已不可用，请刷新后重试', 409);
    const existing = await db.prepare('SELECT id FROM upstream_packages WHERE upstream_id=? AND package_id=?').get(upstreamId, selected.packageId);
    const packageRowId = await upstreams.savePackage(
      upstreamId,
      { ...body, name: body.name || selected.name, description: body.description || selected.description },
      existing?.id || null,
    );
    return { status: 201, data: { id: packageRowId }, action: 'upstream-package.create', resourceId: packageRowId };
  }
  const packageMatch = url.pathname.match(/^\/api\/admin\/upstreams\/(\d+)\/packages\/(\d+)$/);
  if (packageMatch && req.method === 'PUT') {
    const upstreamId = Number(packageMatch[1]); const packageRowId = Number(packageMatch[2]); const body = await readBody(req);
    const available = await upstreams.availablePackages(upstreamId);
    if (!available.some(item => item.packageId === String(body.packageId))) throw httpError('所选上游套餐已不可用，请刷新后重试', 409);
    if (body.enabled === false) {
      const mapped = Number((await db.prepare('SELECT COUNT(*) AS count FROM plans p JOIN upstream_packages up ON up.upstream_id=p.upstream_id AND up.package_id=p.upstream_package_id WHERE up.id=? AND p.enabled=1').get(packageRowId)).count);
      if (mapped) throw httpError('仍有在售平台套餐使用该上游套餐，不能停用', 409);
    }
    await upstreams.savePackage(upstreamId, body, packageRowId);
    return { status: 200, data: { ok: true }, action: 'upstream-package.update', resourceId: packageRowId };
  }
  return null;
}
