import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { handleWalletApi } from '../src/wallet.js';
import { hashPassword } from '../src/security.js';

test('财务报表返回期间汇总和可核对的客户交易明细', async t => {
  const db = createDatabase(); t.after(() => db.close());
  const admin = Number(db.prepare("INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,'admin',0)").run('finance-admin', hashPassword('finance-admin-password')).lastInsertRowid);
  const customer = Number(db.prepare("INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,'user',1)").run('finance-user', hashPassword('finance-user-password')).lastInsertRowid);
  db.prepare('INSERT INTO wallets (user_id,balance_cents) VALUES (?,?)').run(customer, 7500);
  db.prepare(`INSERT INTO wallet_transactions (user_id,direction,amount_cents,balance_after_cents,reference_type,reference_id,description,created_at)
    VALUES (?,'credit',10000,10000,'recharge-code','recharge-1','充值码入账','2026-08-10T08:00:00Z')`).run(customer);
  db.prepare(`INSERT INTO wallet_transactions (user_id,direction,amount_cents,balance_after_cents,reference_type,reference_id,description,created_at)
    VALUES (?,'debit',2500,7500,'order','order-1','购买套餐','2026-08-11T08:00:00Z')`).run(customer);
  const result = await handleWalletApi({
    req: { method: 'GET' }, url: new URL('http://localhost/api/admin/billing/finance/summary?from=2026-08-01&to=2026-09-01'),
    user: { id: admin, role: 'admin' }, db, readBody: async () => ({}),
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.creditCents, 10000);
  assert.equal(result.data.debitCents, 2500);
  assert.equal(result.data.netChangeCents, 7500);
  assert.equal(result.data.transactionCount, 2);
  assert.equal(result.data.walletLiabilityCents, 7500);
  assert.deepEqual(result.data.transactions.map(item => [item.username, item.referenceType, item.amountCents]), [
    ['finance-user', 'order', 2500], ['finance-user', 'recharge-code', 10000],
  ]);
});
