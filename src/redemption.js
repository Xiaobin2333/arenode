import crypto from 'node:crypto';
import { pagination, paged, searchLike } from './http-utils.js';
import { billingInternals } from './billing.js';

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }
function int(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw httpError(`${name} 无效`);
  return parsed;
}

function canonicalCode(value) {
  const code = String(value || '').toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[A-Z0-9]{12,40}$/.test(code)) throw httpError('兑换码格式无效');
  return code;
}

function digestCode(value) {
  return crypto.createHash('sha256').update(canonicalCode(value)).digest('hex');
}

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  const value = [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
  return value.match(/.{4}/g).join('-');
}

function publicCode(row) {
  let status = row.status;
  if (status === 'active') {
    const now = Date.now();
    if (Number(row.used_count) >= Number(row.max_uses)) status = 'exhausted';
    else if (row.starts_at && new Date(row.starts_at).getTime() > now) status = 'scheduled';
    else if (row.expires_at && new Date(row.expires_at).getTime() <= now) status = 'expired';
  }
  return {
    id: row.id, suffix: row.code_suffix, label: row.label, type: row.type, productId: row.product_id,
    productName: row.product_name || null, amount: row.amount, maxUses: row.max_uses, usedCount: row.used_count,
    status, startsAt: row.starts_at, expiresAt: row.expires_at, createdAt: row.created_at,
  };
}

async function codeRows(db, where = '', params = [], pageClause = '') {
  return (await db.prepare(`SELECT c.*,
    CASE c.type WHEN 'plan' THEN p.name WHEN 'upgrade' THEN u.name WHEN 'traffic' THEN t.name
    END AS product_name
    FROM redemption_codes c
    LEFT JOIN plans p ON c.type='plan' AND p.id=c.product_id
    LEFT JOIN plan_upgrades u ON c.type='upgrade' AND u.id=c.product_id
    LEFT JOIN traffic_packages t ON c.type='traffic' AND t.id=c.product_id
    ${where} ORDER BY c.id DESC ${pageClause}`).all(...params)).map(publicCode);
}

async function product(db, type, id, { enabled = true } = {}) {
  const tables = { plan: 'plans', upgrade: 'plan_upgrades', traffic: 'traffic_packages' };
  const table = tables[type];
  if (!table) throw httpError('兑换码类型无效');
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?${enabled ? ' AND enabled = 1' : ''}`).get(Number(id));
  if (!row) throw httpError('兑换商品不存在或已停用', 404);
  return row;
}

function parseDate(value, name, { nullable = true } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw httpError(`${name}无效`);
  return date.toISOString();
}

async function createCodes(db, user, body) {
  const type = String(body.type || '');
  const productRow = await product(db, type, int(body.productId, '商品'));
  const count = int(body.count ?? 1, '生成数量', { min: 1, max: 100 });
  const amount = int(body.amount ?? 1, '权益数量', { min: 1, max: 10000 });
  const maxUses = int(body.maxUses ?? 1, '可用次数', { min: 1, max: 100000 });
  const startsAt = parseDate(body.startsAt, '开始时间'); const expiresAt = parseDate(body.expiresAt, '过期时间');
  if (startsAt && expiresAt && new Date(expiresAt) <= new Date(startsAt)) throw httpError('兑换码有效期无效');
  const codes = [];
  await db.transaction(async transaction => {
    const txInsert = transaction.prepare(`INSERT INTO redemption_codes
      (code_hash, code_suffix, label, type, product_id, amount, max_uses, starts_at, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < count; index += 1) {
      let code; let hash;
      do { code = generateCode(); hash = digestCode(code); }
      while (await transaction.prepare('SELECT 1 FROM redemption_codes WHERE code_hash = ?').get(hash));
      const id = Number((await txInsert.run(hash, canonicalCode(code).slice(-4), String(body.label || ''), type, productRow.id, amount, maxUses, startsAt, expiresAt, user.id)).lastInsertRowid);
      codes.push({ id, code });
    }
  });
  return codes;
}

async function redeem(db, billing, user, value) {
  const hash = digestCode(value); const now = new Date(); let orderId; let codeId;
  await db.transaction(async transaction => {
    const code = await transaction.prepare('SELECT * FROM redemption_codes WHERE code_hash = ? FOR UPDATE').get(hash);
    if (!code || code.status !== 'active') throw httpError('兑换码不存在或已停用', 404);
    if (code.starts_at && now < new Date(code.starts_at)) throw httpError('兑换码尚未生效', 409);
    if (code.expires_at && now >= new Date(code.expires_at)) throw httpError('兑换码已过期', 409);
    if (code.used_count >= code.max_uses) throw httpError('兑换码已用完', 409);
    if (await transaction.prepare('SELECT 1 FROM redemption_uses WHERE code_id = ? AND user_id = ?').get(code.id, user.id)) throw httpError('当前账号已使用过此兑换码', 409);
    const item = await product(transaction, code.type, code.product_id);
    let subscriptionId = (await billing.activeSubscription(user.id))?.id || null;
    if (code.type === 'plan') {
      const upstreamCount = Number((await transaction.prepare('SELECT COUNT(*) AS count FROM upstream_accounts').get()).count);
      if (upstreamCount && (!item.upstream_id || !item.upstream_package_id)) throw httpError('兑换套餐尚未绑定上游套餐', 409);
      if (upstreamCount) {
        const upstreamPackage = await transaction.prepare(`SELECT up.id FROM upstream_packages up JOIN upstream_accounts ua ON ua.id=up.upstream_id
          WHERE up.upstream_id=? AND up.package_id=? AND up.enabled=1 AND ua.status='active'`).get(item.upstream_id, item.upstream_package_id);
        if (!upstreamPackage) throw httpError('兑换套餐绑定的上游套餐不可用', 409);
      }
      const owned = await billingInternals.livePlanSubscription(transaction, user.id, item.id, { forUpdate: true });
      const mode = billingInternals.purchaseMode(item);
      if (owned && mode === 'once') throw httpError('该套餐每位客户只能兑换一次', 409);
      if (owned && mode === 'stack') billingInternals.assertRenewalAllowed(item, owned, now);
      if (owned && mode === 'stack') {
        const end = billingInternals.addDays(billingInternals.stackBaseDate(owned, now), item.duration_days * code.amount);
        await transaction.prepare(`UPDATE subscriptions SET status='active', ends_at=?, grace_ends_at=NULL, last_renewed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(end.toISOString(), owned.id);
        subscriptionId = Number(owned.id);
      } else {
        const start = new Date(); const end = new Date(start.getTime() + item.duration_days * code.amount * 86400_000);
        subscriptionId = Number((await transaction.prepare(`INSERT INTO subscriptions
          (user_id, plan_id, status, starts_at, ends_at, upstream_id, upstream_package_id)
          VALUES (?, ?, 'active', ?, ?, ?, ?)`).run(user.id, item.id, start.toISOString(), end.toISOString(), item.upstream_id, item.upstream_package_id)).lastInsertRowid);
      }
    } else {
      if (!subscriptionId) throw httpError('请先开通有效套餐', 409);
      if (code.type === 'upgrade') {
        await transaction.prepare(`INSERT INTO subscription_upgrades (subscription_id, upgrade_id, amount) VALUES (?, ?, ?)
          ON CONFLICT(subscription_id, upgrade_id) DO UPDATE
          SET amount = subscription_upgrades.amount + excluded.amount`).run(subscriptionId, item.id, code.amount);
      } else {
        const end = new Date(now.getTime() + item.duration_days * 86400_000);
        await transaction.prepare(`INSERT INTO user_traffic_packages
          (user_id, subscription_id, traffic_package_id, name, traffic_bytes, starts_at, ends_at, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(user.id, subscriptionId, item.id, item.name, item.traffic_bytes * code.amount, now.toISOString(), end.toISOString());
      }
    }
    orderId = Number((await transaction.prepare(`INSERT INTO orders
      (user_id, type, product_id, subscription_id, amount_cents, status, channel, metadata, paid_at)
      VALUES (?, ?, ?, ?, 0, 'paid', 'redemption', ?, CURRENT_TIMESTAMP)`)
      .run(user.id, code.type, item.id, subscriptionId, JSON.stringify({ redemptionCodeId: code.id, amount: code.amount }))).lastInsertRowid);
    await transaction.prepare('INSERT INTO redemption_uses (code_id, user_id, order_id) VALUES (?, ?, ?)').run(code.id, user.id, orderId);
    await transaction.prepare('UPDATE redemption_codes SET used_count = used_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(code.id);
    codeId = code.id;
  });
  await billing.updateLegacySiteLimit(user.id);
  await billing.enforceUser(user.id, { syncTraffic: false });
  return { orderId, codeId, billing: await billing.snapshot(user.id) };
}

export async function handleRedemptionApi({ req, url, user, db, billing, readBody }) {
  if (user.role === 'user') {
    if (url.pathname === '/api/billing/redeem' && req.method === 'POST') {
      const result = await redeem(db, billing, user, (await readBody(req)).code);
      return { status: 200, data: result, action: 'redemption.redeem', resourceId: result.codeId };
    }
    if (url.pathname === '/api/billing/redemptions' && req.method === 'GET') {
      const rows = await db.prepare(`SELECT ru.id, ru.order_id, ru.redeemed_at, c.code_suffix, c.label, c.type, c.amount,
        CASE c.type WHEN 'plan' THEN p.name WHEN 'upgrade' THEN u.name WHEN 'traffic' THEN t.name END AS product_name
        FROM redemption_uses ru JOIN redemption_codes c ON c.id=ru.code_id
        LEFT JOIN plans p ON c.type='plan' AND p.id=c.product_id
        LEFT JOIN plan_upgrades u ON c.type='upgrade' AND u.id=c.product_id
        LEFT JOIN traffic_packages t ON c.type='traffic' AND t.id=c.product_id
        WHERE ru.user_id=? ORDER BY ru.id DESC`).all(user.id);
      return { status: 200, data: { redemptions: rows.map(row => ({ id: row.id, orderId: row.order_id, suffix: row.code_suffix, label: row.label, type: row.type, amount: row.amount, productName: row.product_name, redeemedAt: row.redeemed_at })) } };
    }
  }

  const prefix = '/api/admin/billing/redemption-codes';
  if (user.role === 'admin' && url.pathname.startsWith(prefix)) {
    const path = url.pathname.slice(prefix.length) || '/';
    if (path === '/' && req.method === 'GET') {
      const { page, pageSize, offset } = pagination(url); const clauses = ['1=1']; const params = [];
      const q = url.searchParams.get('q'); const status = url.searchParams.get('status'); const type = url.searchParams.get('type'); const now = new Date().toISOString();
      if (q) { clauses.push('(c.label LIKE ? OR c.code_suffix LIKE ?)'); const like = searchLike(q); params.push(like, like); }
      if (status === 'active') { clauses.push("c.status='active' AND c.used_count < c.max_uses AND (c.starts_at IS NULL OR c.starts_at<=?) AND (c.expires_at IS NULL OR c.expires_at>?)"); params.push(now, now); }
      else if (status === 'disabled') { clauses.push("c.status='disabled'"); }
      if (type) { clauses.push('c.type=?'); params.push(type); }
      const where = `WHERE ${clauses.join(' AND ')}`;
      const total = (await db.prepare(`SELECT COUNT(*) AS count FROM redemption_codes c ${where}`).get(...params)).count;
      const rows = await db.prepare(`SELECT c.* FROM redemption_codes c ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
      const codes = await Promise.all(rows.map(async row => ({ ...publicCode(row), productName: (await product(db, row.type, row.product_id, { enabled: false })).name })));
      return { status: 200, data: paged(codes, total, page, pageSize, 'codes') };
    }
    if (path === '/' && req.method === 'POST') {
      const codes = await createCodes(db, user, await readBody(req));
      return { status: 201, data: { codes }, action: 'redemption.create', resourceId: codes.map(row => row.id).join(',') };
    }
    const uses = path.match(/^\/(\d+)\/uses$/);
    if (uses && req.method === 'GET') {
      const code = await db.prepare('SELECT id FROM redemption_codes WHERE id=?').get(Number(uses[1])); if (!code) throw httpError('兑换码不存在', 404);
      const rows = await db.prepare(`SELECT ru.id, ru.order_id, ru.redeemed_at, u.id AS user_id, u.username
        FROM redemption_uses ru JOIN users u ON u.id=ru.user_id WHERE ru.code_id=? ORDER BY ru.id DESC`).all(code.id);
      return { status: 200, data: { uses: rows.map(row => ({ id: row.id, userId: row.user_id, username: row.username, orderId: row.order_id, redeemedAt: row.redeemed_at })) } };
    }
    const match = path.match(/^\/(\d+)$/);
    if (match) {
      const row = await db.prepare('SELECT * FROM redemption_codes WHERE id=?').get(Number(match[1])); if (!row) throw httpError('兑换码不存在', 404);
      if (req.method === 'PUT') {
        const body = await readBody(req); const status = body.status ?? row.status;
        if (!['active', 'disabled'].includes(status)) throw httpError('兑换码状态无效');
        const maxUses = body.maxUses === undefined ? row.max_uses : int(body.maxUses, '可用次数', { min: row.used_count || 1, max: 100000 });
        const startsAt = body.startsAt === undefined ? row.starts_at : parseDate(body.startsAt, '开始时间');
        const expiresAt = body.expiresAt === undefined ? row.expires_at : parseDate(body.expiresAt, '过期时间');
        if (startsAt && expiresAt && new Date(expiresAt) <= new Date(startsAt)) throw httpError('兑换码有效期无效');
        await db.prepare(`UPDATE redemption_codes SET label=?, status=?, max_uses=?, starts_at=?, expires_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(body.label === undefined ? row.label : String(body.label || ''), status, maxUses, startsAt, expiresAt, row.id);
        return { status: 200, data: { code: (await codeRows(db, 'WHERE c.id=?', [row.id]))[0] }, action: 'redemption.update', resourceId: row.id };
      }
      if (req.method === 'DELETE') {
        await db.prepare("UPDATE redemption_codes SET status='disabled', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
        return { status: 200, data: { ok: true }, action: 'redemption.disable', resourceId: row.id };
      }
    }
  }
  return null;
}

export const redemptionInternals = { canonicalCode, digestCode, generateCode };
