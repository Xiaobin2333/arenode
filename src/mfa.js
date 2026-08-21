import crypto from 'node:crypto';
import { BRAND_NAME } from './brand.js';
import { settingsInternals } from './settings.js';
import { verifyPassword } from './security.js';

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = ''; for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = ''; for (let index = 0; index < bits.length; index += 5) output += ALPHABET[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  return output;
}

function base32Decode(value) {
  const clean = String(value).toUpperCase().replace(/[^A-Z2-7]/g, ''); let bits = '';
  for (const character of clean) bits += ALPHABET.indexOf(character).toString(2).padStart(5, '0');
  const bytes = []; for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, timestamp = Date.now()) {
  const counter = BigInt(Math.floor(timestamp / 30_000)); const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(counter);
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest(); const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function verifyTotp(secret, code) {
  const candidate = String(code || '').trim(); if (!/^\d{6}$/.test(candidate)) return false;
  return [-1, 0, 1].some(step => {
    const expected = totp(secret, Date.now() + step * 30_000);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
  });
}

function recoveryHash(config, code) { return crypto.createHash('sha256').update(`${config.settingsEncryptionKey}:mfa:${String(code).toUpperCase()}`).digest('hex'); }
function challengeHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function recoveryCodes() { return Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{5}/g).join('-')); }

export async function verifyMfaCode(db, config, userId, code, { allowRecovery = true } = {}) {
  const row = await db.prepare('SELECT * FROM admin_mfa WHERE user_id=? AND enabled=1').get(userId);
  if (!row) return false;
  const secret = settingsInternals.decryptSecret(row.secret_encrypted, config);
  if (secret && verifyTotp(secret, code)) return true;
  if (!allowRecovery) return false;
  let hashes = []; try { hashes = JSON.parse(row.recovery_code_hashes || '[]'); } catch {}
  const hash = recoveryHash(config, code); const index = hashes.indexOf(hash);
  if (index < 0) return false;
  hashes.splice(index, 1);
  await db.prepare('UPDATE admin_mfa SET recovery_code_hashes=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?').run(JSON.stringify(hashes), userId);
  return true;
}

export async function beginMfaLogin(db, userId) {
  const row = await db.prepare('SELECT enabled FROM admin_mfa WHERE user_id=?').get(userId);
  if (!row?.enabled) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  await db.prepare('INSERT INTO mfa_challenges (token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run(challengeHash(token), userId, new Date(Date.now() + 5 * 60_000).toISOString());
  return token;
}

export async function completeMfaLogin(db, config, body) {
  const token = String(body.challengeToken || ''); if (token.length < 32) throw httpError('登录验证已失效，请重新登录', 401);
  const result = await db.transaction(async transaction => {
    const challenge = await transaction.prepare('SELECT * FROM mfa_challenges WHERE token_hash=? FOR UPDATE').get(challengeHash(token));
    if (!challenge || new Date(challenge.expires_at) <= new Date()) throw httpError('登录验证已失效，请重新登录', 401);
    if (Number(challenge.attempts) >= 5) throw httpError('验证尝试次数过多，请重新登录', 429);
    if (!await verifyMfaCode(transaction, config, challenge.user_id, body.code)) {
      await transaction.prepare('UPDATE mfa_challenges SET attempts=attempts+1 WHERE token_hash=?').run(challengeHash(token));
      return { invalid: true };
    }
    const user = await transaction.prepare(`SELECT u.*,COALESCE(ap.role_key,'super_admin') AS admin_role FROM users u
      LEFT JOIN admin_profiles ap ON ap.user_id=u.id WHERE u.id=? AND u.status='active'`).get(challenge.user_id);
    if (!user) return { unavailable: true };
    await transaction.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(challenge.user_id);
    return { user };
  });
  if (result.invalid) throw httpError('动态验证码或恢复码错误', 401);
  if (result.unavailable) throw httpError('账号不可用', 401);
  return result.user;
}

export async function handleMfaApi({ req, url, user, db, config, readBody }) {
  if (!url.pathname.startsWith('/api/account/mfa')) return null;
  if (url.pathname === '/api/account/mfa' && req.method === 'GET') {
    const row = await db.prepare('SELECT enabled,confirmed_at,recovery_code_hashes FROM admin_mfa WHERE user_id=?').get(user.id);
    let remaining = 0; try { remaining = JSON.parse(row?.recovery_code_hashes || '[]').length; } catch {}
    return { status: 200, data: { enabled: Boolean(row?.enabled), confirmedAt: row?.confirmed_at, recoveryCodesRemaining: remaining } };
  }
  if (url.pathname === '/api/account/mfa/setup' && req.method === 'POST') {
    const body = await readBody(req); if (!verifyPassword(body.currentPassword || '', user.password_hash)) throw httpError('当前密码错误', 403);
    const secret = base32Encode(crypto.randomBytes(20)); const codes = recoveryCodes();
    const encrypted = settingsInternals.encryptSecret(secret, config);
    await db.prepare(`INSERT INTO admin_mfa (user_id,secret_encrypted,enabled,recovery_code_hashes,updated_at) VALUES (?,?,0,?,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET secret_encrypted=excluded.secret_encrypted,enabled=0,recovery_code_hashes=excluded.recovery_code_hashes,confirmed_at=NULL,updated_at=CURRENT_TIMESTAMP`)
      .run(user.id, encrypted, JSON.stringify(codes.map(code => recoveryHash(config, code))));
    const issuer = encodeURIComponent(BRAND_NAME); const account = encodeURIComponent(user.email || user.username);
    return { status: 200, data: { secret, otpauthUri: `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&digits=6&period=30`, recoveryCodes: codes }, action: 'mfa.setup', resourceId: user.id };
  }
  if (url.pathname === '/api/account/mfa/confirm' && req.method === 'POST') {
    const row = await db.prepare('SELECT * FROM admin_mfa WHERE user_id=?').get(user.id); if (!row) throw httpError('请先开始绑定动态验证', 409);
    const secret = settingsInternals.decryptSecret(row.secret_encrypted, config);
    if (!verifyTotp(secret, (await readBody(req)).code)) throw httpError('动态验证码错误');
    await db.prepare('UPDATE admin_mfa SET enabled=1,confirmed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE user_id=?').run(user.id);
    return { status: 200, data: { enabled: true }, action: 'mfa.enable', resourceId: user.id };
  }
  if (url.pathname === '/api/account/mfa' && req.method === 'DELETE') {
    const body = await readBody(req); if (!verifyPassword(body.currentPassword || '', user.password_hash)) throw httpError('当前密码错误', 403);
    if (!await verifyMfaCode(db, config, user.id, body.code)) throw httpError('动态验证码或恢复码错误', 403);
    await db.prepare('DELETE FROM admin_mfa WHERE user_id=?').run(user.id);
    return { status: 200, data: { enabled: false }, action: 'mfa.disable', resourceId: user.id };
  }
  return null;
}

export const mfaInternals = { base32Encode, base32Decode, totp, verifyTotp, recoveryHash };
