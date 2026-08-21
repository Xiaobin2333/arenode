import test from 'node:test';
import assert from 'node:assert/strict';
import { MailService } from '../src/mailer.js';

test('生产环境始终禁止开发验证码回显', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const mailer = new MailService({
      smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpPassword: '',
      smtpFrom: 'noreply@example.com', mailDevExposeCode: true, authCodeMinutes: 10,
    });
    assert.equal(mailer.available, false);
    await assert.rejects(
      mailer.sendCode({ email: 'user@example.com', code: '123456', purpose: 'passwordReset', siteName: 'Arenode' }),
      error => error.status === 503 && error.message === '邮件服务未配置',
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
