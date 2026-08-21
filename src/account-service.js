import { verifyPassword } from './security.js';
import { verifyMfaCode } from './mfa.js';

function httpError(message, status = 400, detail = null) { return Object.assign(new Error(message), { status, detail }); }

export async function accountClosureStatus(db, userId) {
  const now = new Date().toISOString();
  const row = await db.prepare(`SELECT
    COALESCE((SELECT balance_cents FROM wallets WHERE user_id=?),0) AS balance_cents,
    (SELECT COUNT(*) FROM subscriptions WHERE user_id=? AND (status IN ('pending','active','suspended') OR (grace_ends_at IS NOT NULL AND grace_ends_at>?))) AS subscriptions,
    (SELECT COUNT(*) FROM sites WHERE owner_id=?) AS sites,
    (SELECT COUNT(*) FROM tenant_resources WHERE owner_id=?) AS resources`).get(userId, userId, now, userId, userId);
  const blockers = [];
  if (Number(row.balance_cents) > 0) blockers.push({ key: 'balance', message: '账户仍有可用余额，请先联系管理员处理' });
  if (Number(row.subscriptions) > 0) blockers.push({ key: 'subscriptions', message: '仍有生效、暂停、待生效或宽限期内的套餐' });
  if (Number(row.sites) > 0) blockers.push({ key: 'sites', message: '仍有网站，请先停用并删除' });
  if (Number(row.resources) > 0) blockers.push({ key: 'resources', message: '仍有 CDN 服务资源，请先删除' });
  return { eligible: blockers.length === 0, blockers, balanceCents: Number(row.balance_cents), subscriptionCount: Number(row.subscriptions), siteCount: Number(row.sites), resourceCount: Number(row.resources) };
}

export async function closeAccount({ db, config, user, body }) {
  if (user.role !== 'user') throw httpError('管理员账号不能自助注销', 403);
  if (!verifyPassword(body.currentPassword || '', user.password_hash)) throw httpError('当前密码错误', 403);
  const mfa = await db.prepare('SELECT enabled FROM admin_mfa WHERE user_id=?').get(user.id);
  if (mfa?.enabled && !await verifyMfaCode(db, config, user.id, body.mfaCode)) throw httpError('动态验证码或恢复码错误', 403);
  const status = await accountClosureStatus(db, user.id);
  if (!status.eligible) throw httpError('账号暂不满足注销条件', 409, status);
  await db.transaction(async transaction => {
    await transaction.prepare("UPDATE users SET email=NULL,email_verified_at=NULL,status='disabled',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(user.id);
    await transaction.prepare('DELETE FROM email_change_tokens WHERE user_id=?').run(user.id);
    await transaction.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(user.id);
    await transaction.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  });
  return { ok: true, relogin: true };
}
