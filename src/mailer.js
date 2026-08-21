import nodemailer from 'nodemailer';

export class MailService {
  constructor(config) {
    this.config = config;
    this.devCodeEnabled = process.env.NODE_ENV !== 'production' && Boolean(config.mailDevExposeCode);
    this.transport = config.smtpHost ? nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
    }) : null;
    this.available = Boolean(this.transport || this.devCodeEnabled);
  }

  async sendCode({ email, code, purpose, siteName }) {
    const subjects = { registration: '注册邮箱验证码', passwordReset: '找回密码验证码', emailChange: '更换邮箱验证码' };
    const subject = `${siteName} - ${subjects[purpose] || '邮箱验证码'}`;
    const text = `${siteName} 验证码：${code}\n\n验证码 ${this.config.authCodeMinutes} 分钟内有效，请勿转发给他人。`;
    if (this.transport) {
      await this.transport.sendMail({ from: this.config.smtpFrom, to: email, subject, text });
      return {};
    }
    if (!this.devCodeEnabled) throw Object.assign(new Error('邮件服务未配置'), { status: 503 });
    console.log(`[开发邮件] ${email} ${subject}: ${code}`);
    return { devCode: code };
  }

  async sendText({ email, subject, text, siteName }) {
    const fullSubject = `${siteName} - ${subject}`;
    if (this.transport) {
      await this.transport.sendMail({ from: this.config.smtpFrom, to: email, subject: fullSubject, text });
      return {};
    }
    if (!this.devCodeEnabled) throw Object.assign(new Error('邮件服务未配置'), { status: 503 });
    console.log(`[开发邮件] ${email} ${fullSubject}: ${text}`);
    return {};
  }

  async verify() {
    if (this.transport) return this.transport.verify();
    if (this.devCodeEnabled) return true;
    throw Object.assign(new Error('邮件服务未配置'), { status: 503 });
  }
}
