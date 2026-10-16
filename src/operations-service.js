import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { operationSettings, opError } from './operations-settings.js';
import { S3Backups } from './s3-backups.js';
import { SiteInspection } from './site-inspection.js';

export class OperationsService {
  constructor({ db, config, billing, cache, upstreams, cdnfly, lease, restart, backups, inspection }) {
    Object.assign(this, { db, config, billing, cache, lease, restart });
    this.backups = backups || new S3Backups(config);
    this.inspection = inspection || new SiteInspection({ db, upstreams, cdnfly, billing });
    this.inflight = 0; this.restoring = false; this.busy = false; this.stopped = false;
  }
  settings(kind) { return operationSettings(this.db, this.config, kind, true); }
  async enqueue(kind, input = {}, actorId = null) {
    const result = await this.db.withAdvisoryLock('operations-queue', async () => {
      const pending = await this.db.prepare("SELECT id FROM operations_jobs WHERE status IN ('queued','running')").all();
      if (pending.length >= 10) throw opError('任务队列已满，请稍后重试', 409);
      const id = crypto.randomUUID();
      await this.db.prepare('INSERT INTO operations_jobs (id,kind,actor_id,input) VALUES (?,?,?,?)').run(id, kind, actorId, JSON.stringify(input));
      return { id, status: 'queued' };
    });
    if (!result.acquired) throw opError('任务队列忙，请重试', 409);
    return result.value;
  }
  start() { if (this.stopped || this.timer) return; this.timer = setInterval(() => void this.tick().catch(() => console.error('运维任务调度失败')), 15000); this.timer.unref(); void this.tick().catch(() => {}); }
  async stop() { this.stopped = true; clearInterval(this.timer); while (this.busy) await delay(100); }
  async tick() {
    if (this.busy || this.stopped || this.restoring) return;
    this.busy = true;
    try {
      await this.db.withAdvisoryLock('operations-worker', async () => {
        // Owning the worker lock proves no other worker is still executing these jobs.
        await this.db.prepare("UPDATE operations_jobs SET status='failed',error='进程中断，请检查外部服务状态后重试',finished_at=CURRENT_TIMESTAMP WHERE status='running'").run();
        for (const kind of ['backup', 'inspection']) {
          const settings = await this.settings(kind);
          if (!settings.scheduled) continue;
          const last = await this.db.prepare('SELECT created_at FROM operations_jobs WHERE kind=? ORDER BY created_at DESC LIMIT 1').get(kind);
          if (!last || Date.now() - new Date(last.created_at).getTime() >= settings.intervalHours * 3600000) {
            try { await this.enqueue(kind, { scheduled: true }); }
            catch (error) { if (error.status !== 409) throw error; }
          }
        }
        const job = await this.db.prepare("SELECT * FROM operations_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get();
        if (!job) return;
        await this.db.prepare("UPDATE operations_jobs SET status='running',started_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
        try {
          const input = JSON.parse(job.input); let result;
          if (job.kind === 'backup') result = await this.backups.backup(await this.settings('backup'), { reason: input.scheduled ? 'scheduled' : 'manual' });
          else if (job.kind === 'inspection') result = await this.inspection.run(job.id, await this.settings('inspection'), input.siteId);
          else if (job.kind === 'restore') { await this.restore(job, input.backupId); return; }
          else if (job.kind === 'delete_backup') { await this.backups.remove(await this.settings('backup'), input.backupId); result = { deleted: input.backupId }; }
          else throw opError('未知任务');
          await this.db.prepare("UPDATE operations_jobs SET status='succeeded',result=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(result), job.id);
        } catch (error) {
          const message = error.status ? String(error.message).slice(0, 500) : '任务失败：请检查配置、连接、权限及服务版本；还原失败后请核查还原前备份';
          await this.db.prepare("UPDATE operations_jobs SET status='failed',error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(message, job.id);
        }
      });
    } finally { this.busy = false; }
  }
  async restore(job, backupId) {
    if (!this.lease || !this.restart) throw opError('当前运行环境不支持安全覆盖还原', 503);
    const settings = await this.settings('backup');
    await this.backups.withDownloaded(settings, backupId, async dump => {
      if (!await this.lease.exclusive()) throw opError('还原前请将应用缩至单实例', 409);
      let committed = false;
      this.restoring = true; if (this.billing) this.billing.paused = true;
      try {
        const deadline = Date.now() + 60000;
        while (this.inflight || this.billing?.scheduler.runningSince || this.reconciling) {
          if (Date.now() > deadline) throw opError('请求未排空，取消还原', 409);
          await delay(100);
        }
        const before = await this.backups.backup(settings, { reason: 'pre_restore', protectedIds: [backupId] });
        await this.backups.restore(dump); committed = true;
        await this.db.prepare('DELETE FROM sessions').run();
        await this.db.prepare('DELETE FROM user_api_keys').run();
        await this.db.prepare('DELETE FROM mfa_challenges').run();
        await this.db.prepare('DELETE FROM password_reset_tokens').run();
        await this.db.prepare('DELETE FROM email_change_tokens').run();
        await this.db.prepare('DELETE FROM pending_registrations').run();
        await this.cache?.invalidate();
        await this.db.prepare("UPDATE operations_jobs SET status='failed',error='数据库还原后取消旧任务',finished_at=CURRENT_TIMESTAMP WHERE status IN ('queued','running')").run();
        await this.db.prepare(`INSERT INTO operations_jobs (id,kind,status,input,result,finished_at) VALUES (?,'restore','succeeded',?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET status='succeeded',result=excluded.result,finished_at=CURRENT_TIMESTAMP`)
          .run(job.id, JSON.stringify({ backupId }), JSON.stringify({ backupId, preRestoreBackupId: before.id }));
        await this.db.prepare('INSERT INTO audit_logs (action,resource_type,resource_id,detail) VALUES (?,?,?,?)').run('database.restore', 'backup', backupId, JSON.stringify({ originalActorId: job.actor_id, preRestoreBackupId: before.id }));
      } finally {
        if (committed) {
          // Keep maintenance and the exclusive lease through process termination.
          this.stopped = true; clearInterval(this.timer); setTimeout(() => this.restart(), 1000).unref();
        } else {
          this.restoring = false; if (this.billing) this.billing.paused = false;
          await this.lease.releaseExclusive();
        }
      }
    });
  }
}
