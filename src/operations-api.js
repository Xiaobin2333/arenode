import { isSuperAdmin } from './admin-security.js';
import { verifyPassword } from './security.js';
import { operationSettings, saveOperationSettings, opError } from './operations-settings.js';

export async function handleOperationsApi({ req, url, user, db, config, operations, readBody }) {
  const prefix = '/api/admin/operations';
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  if (!isSuperAdmin(user)) throw opError('仅超级管理员可管理备份与巡查', 403);
  if (!operations) throw opError('运维服务未启用', 503);
  const route = url.pathname.slice(prefix.length);
  const settingsMatch = route.match(/^\/settings\/(backup|inspection)$/);
  let data;
  if (settingsMatch && req.method === 'GET') data = await operationSettings(db, config, settingsMatch[1]);
  else if (settingsMatch && req.method === 'PUT') data = await saveOperationSettings(db, config, settingsMatch[1], await readBody(), user.id);
  else if (route === '/jobs' && req.method === 'GET') data = await db.prepare('SELECT * FROM operations_jobs ORDER BY created_at DESC LIMIT 100').all();
  else if (route === '/inspections' && req.method === 'GET') data = await db.prepare('SELECT i.*,h.status AS hold_status FROM site_inspections i LEFT JOIN site_policy_holds h ON h.site_id=i.site_id ORDER BY i.created_at DESC LIMIT 200').all();
  else if (route === '/backups' && req.method === 'GET') {
    try { data = await operations.backups.list(await operations.settings('backup')); } catch { throw opError('读取备份失败，请检查 S3 配置、权限及加密密钥', 502); }
  } else if (route === '/test-s3' && req.method === 'POST') {
    try { data = await operations.backups.test(await operations.settings('backup')); } catch { throw opError('S3 连接验证失败，请检查配置及权限', 502); }
  } else if (['/backup', '/inspection', '/restore', '/delete-backup'].includes(route) && req.method === 'POST') {
    const body = await readBody(); const input = {};
    if (route === '/restore' || route === '/delete-backup') {
      if (typeof body.backupId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.backupId)) throw opError('备份 ID 无效');
      input.backupId = body.backupId;
      const expected = `${route === '/restore' ? 'RESTORE' : 'DELETE'} ${body.backupId}`;
      if (body.confirmation !== expected) throw opError('确认文本不匹配');
      if (route === '/restore' && operations.cache && !(await operations.cache.rateLimit('database-restore-password', user.id, 5, 900)).allowed) throw opError('还原验证尝试过多，请15分钟后重试', 429);
      if (route === '/restore' && (typeof body.currentPassword !== 'string' || body.currentPassword.length > 200 || !verifyPassword(body.currentPassword, user.password_hash))) throw opError('当前管理员密码错误', 403);
    }
    if (route === '/inspection' && body.siteId !== undefined && body.siteId !== '') {
      if (!Number.isSafeInteger(Number(body.siteId)) || Number(body.siteId) < 1) throw opError('网站 ID 无效');
      input.siteId = Number(body.siteId);
    }
    const kind = route === '/delete-backup' ? 'delete_backup' : route.slice(1);
    data = await operations.enqueue(kind, input, user.id);
    await db.prepare('INSERT INTO audit_logs (actor_id,action,resource_type,resource_id,detail) VALUES (?,?,?,?,?)').run(user.id, `operations.${kind}`, 'job', data.id, JSON.stringify(input));
    return { status: 202, data };
  } else if (route === '/inspection-action' && req.method === 'POST') {
    const body = await readBody();
    if (!['disable', 'enable', 'approve'].includes(body.action) || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000) throw opError('请选择操作并填写审核理由（最多1000字）');
    data = await operations.inspection.action(Number(body.siteId), String(body.inspectionId), body.action, body.reason.trim(), user.id);
  } else throw opError('接口不存在', 404);
  return { status: 200, data };
}
