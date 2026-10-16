import { settingsInternals } from './settings.js';

export const categories = ['gambling', 'pornography', 'fraud', 'phishing', 'other_illegal'];
export const operationDefaults = {
  backup: { endpoint: '', region: 'us-east-1', bucket: '', prefix: 'arenode/', accessKeyId: '', secretAccessKey: '', forcePathStyle: true, scheduled: false, intervalHours: 24, retention: 7, maxBackupMb: 1024 },
  inspection: { baseUrl: '', apiKey: '', model: '', scheduled: false, intervalHours: 24, autoDisable: false, threshold: 0.9, categories, policy: '', maxPages: 3 },
};
const secrets = { backup: ['accessKeyId', 'secretAccessKey'], inspection: ['apiKey'] };
export function opError(message, status = 400) { return Object.assign(new Error(message), { status }); }
export async function operationSettings(db, config, kind, reveal = false) {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key=?').get(`operations:${kind}`);
  const data = { ...operationDefaults[kind], ...(row ? JSON.parse(row.value) : {}) };
  for (const key of secrets[kind]) {
    const value = settingsInternals.decryptSecret(data[key], config);
    data[`${key}Configured`] = Boolean(value);
    data[key] = reveal ? value : '';
  }
  return data;
}
export async function saveOperationSettings(db, config, kind, body, actorId) {
  const previous = await operationSettings(db, config, kind, true);
  const next = { ...previous };
  for (const key of Object.keys(operationDefaults[kind])) if (Object.hasOwn(body, key)) {
    if (secrets[kind].includes(key) && body[key] === '') continue;
    next[key] = body[key];
  }
  for (const key of ['scheduled', ...(kind === 'backup' ? ['forcePathStyle'] : ['autoDisable'])]) if (typeof next[key] !== 'boolean') throw opError(`${key} 必须是布尔值`);
  for (const [key, min, max] of [['intervalHours', 1, 720], ...(kind === 'backup' ? [['retention', 1, 365], ['maxBackupMb', 1, 102400]] : [['maxPages', 1, 5]])]) {
    if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) throw opError(`${key} 必须在 ${min}–${max} 之间`);
  }
  const urlKey = kind === 'backup' ? 'endpoint' : 'baseUrl';
  if (next[urlKey]) {
    let url; try { url = new URL(next[urlKey]); } catch { throw opError('接口地址无效'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw opError('接口地址必须为无凭据、无查询参数的 HTTPS 地址');
    next[urlKey] = url.href.replace(/\/$/, '');
  }
  if (kind === 'backup') {
    if (typeof next.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(next.bucket)) throw opError('S3 Bucket 名称无效');
    if (typeof next.prefix !== 'string' || !/^[a-zA-Z0-9_/-]{1,150}\/$/.test(next.prefix) || next.prefix.includes('..')) throw opError('备份前缀须以 / 结尾，仅允许字母、数字、下划线和连字符');
    if (typeof next.region !== 'string' || !/^[a-z0-9-]{1,60}$/.test(next.region)) throw opError('S3 Region 无效');
    if (!next.accessKeyId || !next.secretAccessKey) throw opError('请配置 S3 凭据');
  } else {
    if (!Array.isArray(next.categories) || !next.categories.length || next.categories.some(x => !categories.includes(x))) throw opError('请选择有效的巡查类别');
    if (typeof next.threshold !== 'number' || !Number.isFinite(next.threshold) || next.threshold < 0.5 || next.threshold > 1) throw opError('置信度阈值须在 0.5–1 之间');
    if (typeof next.policy !== 'string' || next.policy.length > 4000) throw opError('判定规则最多 4000 字');
    if (!next.baseUrl || !next.model || typeof next.model !== 'string' || next.model.length > 200 || !next.apiKey) throw opError('请配置 API 地址、模型和密钥');
  }
  for (const key of secrets[kind]) {
    if (typeof next[key] !== 'string' || next[key].length > 4096) throw opError('凭据无效');
    next[key] = settingsInternals.encryptSecret(next[key], config);
    delete next[`${key}Configured`];
  }
  await db.prepare(`INSERT INTO app_settings (key,value,updated_by) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
    .run(`operations:${kind}`, JSON.stringify(next), actorId);
  await db.prepare('INSERT INTO audit_logs (actor_id,action,resource_type,resource_id,detail) VALUES (?,?,?,?,?)')
    .run(actorId, 'operations.settings.update', 'settings', kind, JSON.stringify({ changedFields: Object.keys(body).filter(key => Object.hasOwn(operationDefaults[kind], key)) }));
  return operationSettings(db, config, kind);
}
