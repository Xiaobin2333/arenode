import { hashPassword, validateUsername } from './security.js';
import { publicUser } from './db.js';

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }

export function isSuperAdmin(user) {
  return user?.role === 'admin' && (user.admin_role || user.role_key || 'super_admin') === 'super_admin';
}

async function adminRow(db, id) {
  return db.prepare(`SELECT u.*, COALESCE(ap.role_key, 'super_admin') AS admin_role
    FROM users u LEFT JOIN admin_profiles ap ON ap.user_id=u.id WHERE u.id=? AND u.role='admin'`).get(Number(id));
}

export async function handleAdminSecurityApi({ req, url, user, db, tokenHash, readBody }) {
  if (url.pathname === '/api/account/sessions' && req.method === 'GET') {
    const rows = await db.prepare(`SELECT token_hash, ip, user_agent, last_seen_at, created_at, expires_at
      FROM sessions WHERE user_id=? AND expires_at>? ORDER BY last_seen_at DESC`).all(user.id, new Date().toISOString());
    return { status: 200, data: { sessions: rows.map(row => ({
      id: row.token_hash.slice(0, 16), current: row.token_hash === tokenHash, ip: row.ip,
      userAgent: row.user_agent, lastSeenAt: row.last_seen_at, createdAt: row.created_at, expiresAt: row.expires_at,
    })) } };
  }
  const session = url.pathname.match(/^\/api\/account\/sessions\/([a-f0-9]{16})$/);
  if (session && req.method === 'DELETE') {
    const row = await db.prepare('SELECT token_hash FROM sessions WHERE user_id=? AND token_hash LIKE ?').get(user.id, `${session[1]}%`);
    if (!row) throw httpError('登录会话不存在', 404);
    await db.prepare('DELETE FROM sessions WHERE token_hash=? AND user_id=?').run(row.token_hash, user.id);
    return { status: 200, data: { ok: true, current: row.token_hash === tokenHash }, action: 'session.revoke', resourceId: session[1] };
  }
  if (!url.pathname.startsWith('/api/admin/administrators')) return null;
  if (!isSuperAdmin(user)) throw httpError('仅超级管理员可管理管理员账号', 403);

  if (url.pathname === '/api/admin/administrators' && req.method === 'GET') {
    const rows = await db.prepare(`SELECT u.*, COALESCE(ap.role_key, 'super_admin') AS admin_role, al.last_login
      FROM users u LEFT JOIN admin_profiles ap ON ap.user_id=u.id
      LEFT JOIN (SELECT actor_id, MAX(created_at) AS last_login FROM audit_logs WHERE action='login.success' GROUP BY actor_id) al ON al.actor_id=u.id
      WHERE u.role='admin' ORDER BY u.id`).all();
    return { status: 200, data: { administrators: rows.map(row => ({ ...publicUser(row), lastLoginAt: row.last_login })) } };
  }
  if (url.pathname === '/api/admin/administrators' && req.method === 'POST') {
    const body = await readBody(req); const username = validateUsername(body.username); const email = String(body.email || '').trim().toLowerCase() || null;
    const roleKey = body.adminRole === 'super_admin' ? 'super_admin' : 'admin';
    let id;
    try {
      id = Number((await db.prepare(`INSERT INTO users (username, email, email_verified_at, password_hash, role, site_limit)
        VALUES (?, ?, ?, ?, 'admin', 0)`).run(username, email, email ? new Date().toISOString() : null, hashPassword(body.password || ''))).lastInsertRowid);
      await db.prepare('INSERT INTO admin_profiles (user_id, role_key) VALUES (?, ?)').run(id, roleKey);
    } catch (error) {
      if (error.code === '23505' || /unique|duplicate/i.test(error.message || '')) throw httpError('用户名或邮箱已存在', 409);
      throw error;
    }
    return { status: 201, data: { administrator: publicUser(await adminRow(db, id)) }, action: 'administrator.create', resourceId: id };
  }
  const match = url.pathname.match(/^\/api\/admin\/administrators\/(\d+)$/);
  if (!match) return null;
  const target = await adminRow(db, match[1]);
  if (!target) throw httpError('管理员不存在', 404);
  if (req.method === 'PUT') {
    const body = await readBody(req); const roleKey = body.adminRole === undefined ? target.admin_role : (body.adminRole === 'super_admin' ? 'super_admin' : 'admin');
    const status = body.status === undefined ? target.status : body.status;
    if (!['active', 'disabled'].includes(status)) throw httpError('管理员状态无效');
    if (target.id === user.id && (status !== 'active' || roleKey !== 'super_admin')) throw httpError('不能降低或停用当前超级管理员账号', 409);
    if (target.admin_role === 'super_admin' && (status !== 'active' || roleKey !== 'super_admin')) {
      const count = (await db.prepare(`SELECT COUNT(*) AS count FROM users u JOIN admin_profiles ap ON ap.user_id=u.id
        WHERE u.role='admin' AND u.status='active' AND ap.role_key='super_admin'`).get()).count;
      if (Number(count) <= 1) throw httpError('必须保留至少一个可用的超级管理员', 409);
    }
    await db.prepare('UPDATE users SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, target.id);
    await db.prepare(`INSERT INTO admin_profiles (user_id, role_key) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET role_key=excluded.role_key, updated_at=CURRENT_TIMESTAMP`).run(target.id, roleKey);
    if (body.password) await db.prepare('UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hashPassword(body.password), target.id);
    if (status === 'disabled' || body.password) await db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    return { status: 200, data: { administrator: publicUser(await adminRow(db, target.id)) }, action: 'administrator.update', resourceId: target.id };
  }
  if (req.method === 'DELETE') {
    if (target.id === user.id) throw httpError('不能停用当前登录账号', 409);
    if (target.admin_role === 'super_admin') {
      const count = (await db.prepare(`SELECT COUNT(*) AS count FROM users u JOIN admin_profiles ap ON ap.user_id=u.id
        WHERE u.role='admin' AND u.status='active' AND ap.role_key='super_admin'`).get()).count;
      if (Number(count) <= 1) throw httpError('必须保留至少一个可用的超级管理员', 409);
    }
    await db.prepare("UPDATE users SET status='disabled', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(target.id);
    await db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    return { status: 200, data: { ok: true }, action: 'administrator.disable', resourceId: target.id };
  }
  return null;
}
