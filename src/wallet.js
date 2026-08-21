import crypto from 'node:crypto';
import { pagination, paged, searchLike } from './http-utils.js';

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }
function int(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw httpError(`${name}无效`); return parsed;
}

function canonicalCode(value) {
  const code = String(value || '').toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[A-Z0-9]{12,40}$/.test(code)) throw httpError('充值码格式无效');
  return code;
}

function digestCode(value) { return crypto.createHash('sha256').update(canonicalCode(value)).digest('hex'); }
function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const bytes = crypto.randomBytes(16);
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join('').match(/.{4}/g).join('-');
}

function parseDate(value, name) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value); if (!Number.isFinite(date.getTime())) throw httpError(`${name}无效`); return date.toISOString();
}

export async function ensureWallet(db, userId) {
  await db.prepare('INSERT INTO wallets (user_id, balance_cents) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING').run(userId);
  return db.prepare('SELECT * FROM wallets WHERE user_id=?').get(userId);
}

export async function changeBalance(db, userId, deltaCents, { referenceType, referenceId = null, description = '' }) {
  await ensureWallet(db, userId);
  const wallet = await db.prepare('SELECT * FROM wallets WHERE user_id=? FOR UPDATE').get(userId);
  const next = Number(wallet.balance_cents) + Number(deltaCents);
  if (!Number.isSafeInteger(next)) throw httpError('余额计算超出范围', 409);
  if (next < 0) throw httpError('账户余额不足', 409);
  await db.prepare('UPDATE wallets SET balance_cents=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?').run(next, userId);
  let transactionId = null;
  if (deltaCents !== 0) transactionId = Number((await db.prepare(`INSERT INTO wallet_transactions
    (user_id, direction, amount_cents, balance_after_cents, reference_type, reference_id, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, deltaCents > 0 ? 'credit' : 'debit', Math.abs(deltaCents), next, referenceType, referenceId, description)).lastInsertRowid);
  return { balanceCents: next, transactionId };
}

async function walletSnapshot(db, userId, url = null) {
  const wallet = await ensureWallet(db, userId);
  const { page, pageSize, offset } = url ? pagination(url) : { page: 1, pageSize: 100, offset: 0 };
  const total = (await db.prepare('SELECT COUNT(*) AS count FROM wallet_transactions WHERE user_id=?').get(userId)).count;
  const transactions = await db.prepare(`SELECT id, direction, amount_cents, balance_after_cents, reference_type, reference_id, description, created_at
    FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?`).all(userId, pageSize, offset);
  const totals = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN direction='credit' AND reference_type IN ('recharge-code','admin-adjustment') THEN amount_cents ELSE 0 END),0) AS recharge_cents,
    COALESCE(SUM(CASE WHEN direction='debit' AND reference_type='order' THEN amount_cents ELSE 0 END),0)
      - COALESCE(SUM(CASE WHEN direction='credit' AND reference_type='order-refund' THEN amount_cents ELSE 0 END),0) AS spent_cents
    FROM wallet_transactions WHERE user_id=?`).get(userId);
  return { balanceCents: Number(wallet.balance_cents), availableBalanceCents: Number(wallet.balance_cents),
    totalRechargeCents: Number(totals.recharge_cents), totalSpentCents: Math.max(0, Number(totals.spent_cents)), transactions: transactions.map(row => ({
    id: row.id, direction: row.direction, amountCents: Number(row.amount_cents), balanceAfterCents: Number(row.balance_after_cents),
    referenceType: row.reference_type, referenceId: row.reference_id, description: row.description, createdAt: row.created_at,
  })), pagination: { page, pageSize, total: Number(total), pages: Math.max(1, Math.ceil(Number(total) / pageSize)) } };
}

async function createRechargeCodes(db, user, body) {
  const amountCents = int(body.amountCents, '充值金额', { min: 1, max: 100_000_000 });
  const count = int(body.count ?? 1, '生成数量', { min: 1, max: 100 });
  const maxUses = int(body.maxUses ?? 1, '可用次数', { min: 1, max: 100000 });
  const startsAt = parseDate(body.startsAt, '开始时间'); const expiresAt = parseDate(body.expiresAt, '过期时间');
  if (startsAt && expiresAt && new Date(expiresAt) <= new Date(startsAt)) throw httpError('充值码有效期无效');
  const codes = [];
  await db.transaction(async transaction => {
    const batchName = String(body.batchName || body.label || `充值码批次 ${new Date().toLocaleDateString('zh-CN')}`).trim().slice(0, 120);
    const batchId = Number((await transaction.prepare(`INSERT INTO recharge_code_batches
      (name, amount_cents, code_count, max_uses, starts_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(batchName, amountCents, count, maxUses, startsAt, expiresAt, user.id)).lastInsertRowid);
    for (let index = 0; index < count; index += 1) {
      let code; let hash;
      do { code = generateCode(); hash = digestCode(code); }
      while (await transaction.prepare('SELECT 1 FROM recharge_codes WHERE code_hash=?').get(hash));
      const id = Number((await transaction.prepare(`INSERT INTO recharge_codes
        (code_hash, code_suffix, label, amount_cents, max_uses, starts_at, expires_at, created_by, batch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(hash, canonicalCode(code).slice(-4), String(body.label || ''), amountCents, maxUses, startsAt, expiresAt, user.id, batchId)).lastInsertRowid);
      codes.push({ id, code, batchId });
    }
  });
  return codes;
}

async function redeemRechargeCode(db, user, value) {
  const hash = digestCode(value); const now = new Date(); let result;
  await db.transaction(async transaction => {
    const code = await transaction.prepare('SELECT * FROM recharge_codes WHERE code_hash=? FOR UPDATE').get(hash);
    if (!code || code.status !== 'active') throw httpError('充值码不存在或已停用', 404);
    if (code.starts_at && now < new Date(code.starts_at)) throw httpError('充值码尚未生效', 409);
    if (code.expires_at && now >= new Date(code.expires_at)) throw httpError('充值码已过期', 409);
    if (code.used_count >= code.max_uses) throw httpError('充值码已用完', 409);
    if (await transaction.prepare('SELECT 1 FROM recharge_code_uses WHERE code_id=? AND user_id=?').get(code.id, user.id)) throw httpError('当前账号已使用过此充值码', 409);
    const changed = await changeBalance(transaction, user.id, Number(code.amount_cents), {
      referenceType: 'recharge-code', referenceId: `${code.id}:${user.id}`, description: code.label || `充值码 ****-${code.code_suffix}`,
    });
    await transaction.prepare('INSERT INTO recharge_code_uses (code_id, user_id, transaction_id) VALUES (?, ?, ?)').run(code.id, user.id, changed.transactionId);
    await transaction.prepare('UPDATE recharge_codes SET used_count=used_count+1, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(code.id);
    result = { codeId: code.id, amountCents: Number(code.amount_cents), balanceCents: changed.balanceCents };
  });
  return result;
}

function publicRechargeCode(row) {
  let status = row.status;
  if (status === 'active') {
    const now = Date.now();
    if (Number(row.used_count) >= Number(row.max_uses)) status = 'exhausted';
    else if (row.starts_at && new Date(row.starts_at).getTime() > now) status = 'scheduled';
    else if (row.expires_at && new Date(row.expires_at).getTime() <= now) status = 'expired';
  }
  return { id: row.id, suffix: row.code_suffix, label: row.label, amountCents: Number(row.amount_cents), maxUses: row.max_uses,
    usedCount: row.used_count, status, batchId: row.batch_id, batchName: row.batch_name,
    startsAt: row.starts_at, expiresAt: row.expires_at, createdAt: row.created_at };
}

export async function handleWalletApi({ req, url, user, db, readBody }) {
  if (user.role === 'user') {
    if (url.pathname === '/api/billing/wallet' && req.method === 'GET') return { status: 200, data: await walletSnapshot(db, user.id, url) };
    if (url.pathname === '/api/billing/recharge-code' && req.method === 'POST') {
      const result = await redeemRechargeCode(db, user, (await readBody(req)).code);
      return { status: 200, data: result, action: 'wallet.recharge-code', resourceId: result.codeId };
    }
  }
  if (user.role !== 'admin' || !url.pathname.startsWith('/api/admin/billing/')) return null;
  const path = url.pathname.slice('/api/admin/billing'.length);
  if (path === '/wallets' && req.method === 'GET') {
    const { page, pageSize, offset } = pagination(url); const q = url.searchParams.get('q'); const params = [];
    const where = q ? 'u.role=\'user\' AND (u.username LIKE ? OR u.email LIKE ?)' : "u.role='user'";
    if (q) { const like = searchLike(q); params.push(like, like); }
    const total = (await db.prepare(`SELECT COUNT(*) AS count FROM users u WHERE ${where}`).get(...params)).count;
    const rows = await db.prepare(`SELECT u.id AS user_id, u.username, u.email, COALESCE(w.balance_cents, 0) AS balance_cents
      FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    return { status: 200, data: paged(rows.map(row => ({ userId: row.user_id, username: row.username, email: row.email, balanceCents: Number(row.balance_cents) })), total, page, pageSize, 'wallets') };
  }
  const adjustment = path.match(/^\/wallets\/(\d+)\/adjust$/);
  if (adjustment && req.method === 'POST') {
    const customer = await db.prepare("SELECT id FROM users WHERE id=? AND role='user'").get(Number(adjustment[1])); if (!customer) throw httpError('客户不存在', 404);
    const body = await readBody(req); const delta = Number(body.amountCents);
    if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100_000_000) throw httpError('调整金额无效');
    const result = await db.transaction(transaction => changeBalance(transaction, customer.id, delta, {
      referenceType: 'admin-adjustment', referenceId: crypto.randomUUID(), description: String(body.description || '管理员余额调整').slice(0, 240),
    }));
    return { status: 200, data: result, action: 'wallet.adjust', resourceId: customer.id };
  }
  if (path === '/recharge-codes' && req.method === 'GET') {
    const { page, pageSize, offset } = pagination(url); const q = url.searchParams.get('q'); const status = url.searchParams.get('status'); const now = new Date().toISOString(); const clauses = ['1=1']; const params = [];
    if (q) { clauses.push('(r.label LIKE ? OR r.code_suffix LIKE ? OR b.name LIKE ?)'); const like = searchLike(q); params.push(like, like, like); }
    if (status === 'active') { clauses.push("r.status='active' AND r.used_count < r.max_uses AND (r.starts_at IS NULL OR r.starts_at<=?) AND (r.expires_at IS NULL OR r.expires_at>?)"); params.push(now, now); }
    else if (status === 'disabled') { clauses.push("r.status='disabled'"); }
    const where = clauses.join(' AND ');
    const total = (await db.prepare(`SELECT COUNT(*) AS count FROM recharge_codes r LEFT JOIN recharge_code_batches b ON b.id=r.batch_id WHERE ${where}`).get(...params)).count;
    const rows = await db.prepare(`SELECT r.*, b.name AS batch_name FROM recharge_codes r LEFT JOIN recharge_code_batches b ON b.id=r.batch_id WHERE ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    return { status: 200, data: paged(rows.map(publicRechargeCode), total, page, pageSize, 'codes') };
  }
  if (path === '/recharge-codes' && req.method === 'POST') {
    const codes = await createRechargeCodes(db, user, await readBody(req));
    return { status: 201, data: { codes }, action: 'recharge-code.create', resourceId: codes.map(item => item.id).join(',') };
  }
  if (path === '/recharge-code-batches' && req.method === 'GET') {
    const { page, pageSize, offset } = pagination(url);
    const total = (await db.prepare('SELECT COUNT(*) AS count FROM recharge_code_batches').get()).count;
    const rows = await db.prepare(`SELECT b.*, COALESCE(SUM(r.used_count),0) AS used_count, COALESCE(SUM(r.max_uses),0) AS total_uses
      FROM recharge_code_batches b LEFT JOIN recharge_codes r ON r.batch_id=b.id GROUP BY b.id ORDER BY b.id DESC LIMIT ? OFFSET ?`).all(pageSize, offset);
    return { status: 200, data: paged(rows.map(row => ({ id: row.id, name: row.name, amountCents: Number(row.amount_cents), codeCount: row.code_count,
      maxUses: row.max_uses, usedCount: Number(row.used_count), totalUses: Number(row.total_uses), startsAt: row.starts_at, expiresAt: row.expires_at, createdAt: row.created_at })), total, page, pageSize, 'batches') };
  }
  if (path === '/finance/summary' && req.method === 'GET') {
    const dateText = value => value.toISOString().slice(0, 10);
    const today = new Date(Date.now() + 8 * 60 * 60_000); today.setUTCHours(0, 0, 0, 0);
    const defaultFrom = new Date(today); defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 29);
    const defaultTo = new Date(today); defaultTo.setUTCDate(defaultTo.getUTCDate() + 1);
    const from = url.searchParams.get('from') || dateText(defaultFrom);
    const to = url.searchParams.get('to') || dateText(defaultTo);
    const fromBoundary = new Date(`${from}T00:00:00+08:00`); const toBoundary = new Date(`${to}T00:00:00+08:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || !Number.isFinite(fromBoundary.getTime()) || !Number.isFinite(toBoundary.getTime()) || fromBoundary >= toBoundary) throw httpError('财务报表日期范围无效');
    const fromQuery = fromBoundary.toISOString(); const toQuery = toBoundary.toISOString();
    const rows = await db.prepare(`SELECT direction, reference_type, COUNT(*) AS count, COALESCE(SUM(amount_cents),0) AS amount_cents
      FROM wallet_transactions WHERE created_at>=? AND created_at<? GROUP BY direction, reference_type ORDER BY direction, reference_type`).all(fromQuery, toQuery);
    const liability = (await db.prepare('SELECT COALESCE(SUM(balance_cents),0) AS total FROM wallets').get()).total;
    const totals = await db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents ELSE 0 END),0) AS credit_cents,
      COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents ELSE 0 END),0) AS debit_cents
      FROM wallet_transactions WHERE created_at>=? AND created_at<?`).get(fromQuery, toQuery);
    const transactions = await db.prepare(`SELECT wt.id,wt.direction,wt.amount_cents,wt.balance_after_cents,wt.reference_type,wt.reference_id,wt.description,wt.created_at,u.id AS user_id,u.username
      FROM wallet_transactions wt JOIN users u ON u.id=wt.user_id
      WHERE wt.created_at>=? AND wt.created_at<? ORDER BY wt.id DESC LIMIT 50`).all(fromQuery, toQuery);
    const displayTo = new Date(`${to}T00:00:00Z`); displayTo.setUTCDate(displayTo.getUTCDate() - 1);
    return { status: 200, data: {
      from, to: dateText(displayTo), toExclusive: to, walletLiabilityCents: Number(liability),
      creditCents: Number(totals.credit_cents), debitCents: Number(totals.debit_cents),
      netChangeCents: Number(totals.credit_cents) - Number(totals.debit_cents), transactionCount: Number(totals.count),
      breakdown: rows.map(row => ({ direction: row.direction, referenceType: row.reference_type, count: Number(row.count), amountCents: Number(row.amount_cents) })),
      transactions: transactions.map(row => ({ id: Number(row.id), userId: Number(row.user_id), username: row.username,
        direction: row.direction, amountCents: Number(row.amount_cents), balanceAfterCents: Number(row.balance_after_cents),
        referenceType: row.reference_type, referenceId: row.reference_id, description: row.description, createdAt: row.created_at })),
    } };
  }
  const uses = path.match(/^\/recharge-codes\/(\d+)\/uses$/);
  if (uses && req.method === 'GET') {
    const rows = await db.prepare(`SELECT rcu.id, rcu.redeemed_at, u.username, wt.amount_cents
      FROM recharge_code_uses rcu JOIN users u ON u.id=rcu.user_id JOIN wallet_transactions wt ON wt.id=rcu.transaction_id
      WHERE rcu.code_id=? ORDER BY rcu.id DESC`).all(Number(uses[1]));
    return { status: 200, data: { uses: rows.map(row => ({ id: row.id, username: row.username, amountCents: Number(row.amount_cents), redeemedAt: row.redeemed_at })) } };
  }
  const codeMatch = path.match(/^\/recharge-codes\/(\d+)$/);
  if (codeMatch && req.method === 'DELETE') {
    const result = await db.prepare("UPDATE recharge_codes SET status='disabled', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(Number(codeMatch[1]));
    if (!result.changes) throw httpError('充值码不存在', 404);
    return { status: 200, data: { ok: true }, action: 'recharge-code.disable', resourceId: codeMatch[1] };
  }
  return null;
}

export const walletInternals = { canonicalCode, digestCode, generateCode, walletSnapshot, redeemRechargeCode };
