import crypto from 'node:crypto';
import { pagination, paged } from './http-utils.js';
import { isSuperAdmin } from './admin-security.js';
import { emailDomain, parseEmailDomains } from './email-policy.js';

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }
function canonical(value) { return String(value || '').toUpperCase().replace(/[\s-]+/g, ''); }
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function generate() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const bytes = crypto.randomBytes(16);
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join('').match(/.{4}/g).join('-');
}

export async function validateSelfServiceEmail(settings, email) {
  const domain = emailDomain(email);
  const allowed = new Set(parseEmailDomains(settings.allowedEmailDomains));
  if (!allowed.has(domain)) throw httpError('该邮箱域名不在自助服务白名单中', 403);
  return true;
}

export async function validateRegistrationEligibility(db, settings, { email, inviteCode, termsAccepted, privacyAccepted, ip }) {
  if (settings.legalConsentRequired && (termsAccepted !== true || privacyAccepted !== true)) throw httpError('请阅读并同意服务条款和隐私政策');
  await validateSelfServiceEmail(settings, email);
  if (!settings.inviteOnly) return { inviteId: null };
  const code = canonical(inviteCode);
  if (!/^[A-Z0-9]{12,40}$/.test(code)) throw httpError('请输入有效的邀请码');
  const invite = await db.prepare('SELECT * FROM registration_invites WHERE code_hash=?').get(digest(code));
  if (!invite || invite.status !== 'active' || Number(invite.used_count) >= Number(invite.max_uses) || (invite.expires_at && new Date(invite.expires_at) <= new Date())) throw httpError('邀请码不存在、已用完或已过期', 409);
  return { inviteId: invite.id };
}

export async function consumeInvite(db, inviteId) {
  if (!inviteId) return;
  const invite = await db.prepare('SELECT * FROM registration_invites WHERE id=? FOR UPDATE').get(inviteId);
  if (!invite || invite.status !== 'active' || Number(invite.used_count) >= Number(invite.max_uses) || (invite.expires_at && new Date(invite.expires_at) <= new Date())) throw httpError('邀请码已失效，请重新注册', 409);
  await db.prepare('UPDATE registration_invites SET used_count=used_count+1 WHERE id=?').run(invite.id);
}

export async function handleRegistrationSecurityApi({ req, url, user, db, readBody }) {
  if (!url.pathname.startsWith('/api/admin/security/')) return null;
  if (!isSuperAdmin(user)) throw httpError('仅超级管理员可管理邀请码', 403);
  const path = url.pathname.slice('/api/admin/security'.length);
  if (path === '/invites' && req.method === 'GET') {
    const { page, pageSize, offset } = pagination(url); const total = (await db.prepare('SELECT COUNT(*) AS count FROM registration_invites').get()).count;
    const rows = await db.prepare('SELECT * FROM registration_invites ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, offset);
    const summary = await db.prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status='active' AND used_count<max_uses AND (expires_at IS NULL OR expires_at>?) THEN 1 ELSE 0 END),0) AS active,
      COALESCE(SUM(used_count),0) AS used
      FROM registration_invites`).get(new Date().toISOString());
    return { status: 200, data: { ...paged(rows.map(row => ({ id: row.id, suffix: row.code_suffix, label: row.label, maxUses: row.max_uses, usedCount: row.used_count, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at })), total, page, pageSize, 'invites'),
      summary: { total: Number(summary.total), active: Number(summary.active), used: Number(summary.used) } } };
  }
  if (path === '/invites' && req.method === 'POST') {
    const body = await readBody(req); const count = Math.min(100, Math.max(1, Number.parseInt(body.count || 1, 10))); const maxUses = Math.min(100000, Math.max(1, Number.parseInt(body.maxUses || 1, 10)));
    const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null; const codes = [];
    await db.transaction(async transaction => {
      for (let index = 0; index < count; index += 1) {
        const code = generate(); const id = Number((await transaction.prepare(`INSERT INTO registration_invites
          (code_hash, code_suffix, label, max_uses, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(digest(code), canonical(code).slice(-4), String(body.label || '').slice(0, 120), maxUses, expiresAt, user.id)).lastInsertRowid);
        codes.push({ id, code });
      }
    });
    return { status: 201, data: { codes }, action: 'registration-invite.create', resourceId: codes.map(item => item.id).join(',') };
  }
  const invite = path.match(/^\/invites\/(\d+)$/);
  if (invite && req.method === 'DELETE') {
    await db.prepare("UPDATE registration_invites SET status='disabled' WHERE id=?").run(Number(invite[1]));
    return { status: 200, data: { ok: true }, action: 'registration-invite.disable', resourceId: invite[1] };
  }
  return null;
}

export const registrationSecurityInternals = { canonical, digest };
