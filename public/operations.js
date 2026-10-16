const labels = { gambling: '赌博', pornography: '色情', fraud: '诈骗', phishing: '钓鱼', other_illegal: '其他涉嫌违法', clean: '未发现违规', uncertain: '待人工确认' };
const states = { queued: '等待执行', running: '执行中', succeeded: '已完成', failed: '失败', flagged: '待审核', reviewed: '人工审核通过', error: '检查失败', disabled: '已禁用', disable_failed: '禁用失败', pending: '禁用中' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const base = '/api/admin/operations';
const time = value => value ? new Date(value).toLocaleString() : '—';

function field(settings, key, label, type = 'text', extra = '') {
  if (type === 'checkbox') return `<label class="operations-check"><input type="checkbox" name="${key}" ${settings[key] ? 'checked' : ''}>${label}</label>`;
  return `<label>${label}<input name="${key}" type="${type}" value="${type === 'password' ? '' : escape(settings[key])}" ${extra} ${type === 'password' ? `autocomplete="new-password" placeholder="${settings[`${key}Configured`] ? '已配置，留空保持不变' : '未配置'}"` : ''}></label>`;
}

function confirmation({ title, text, password = false, reason = false, expected = '' }) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'operations-dialog';
    dialog.innerHTML = `<form><h3>${escape(title)}</h3><p>${escape(text)}</p>${password ? '<label>当前管理员密码<input type="password" name="currentPassword" autocomplete="current-password" required maxlength="200"></label>' : ''}${expected ? `<label>输入 ${escape(expected)}<input name="confirmation" required autocomplete="off"></label>` : ''}${reason ? '<label>审核理由<textarea name="reason" required maxlength="1000"></textarea></label>' : ''}<div class="operations-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="submit">确认执行</button></div><p data-error></p></form>`;
    const finish = result => { dialog.close(); dialog.remove(); resolve(result); };
    dialog.querySelector('[data-cancel]').onclick = () => finish(null);
    dialog.oncancel = event => { event.preventDefault(); finish(null); };
    dialog.querySelector('form').onsubmit = event => {
      event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
      if (expected && data.confirmation !== expected) { dialog.querySelector('[data-error]').textContent = '确认文本不匹配'; return; }
      finish(data);
    };
    document.body.append(dialog); dialog.showModal();
  });
}

export async function loadOperations(kind, api, toast) {
  const root = document.getElementById(kind === 'backup' ? 'backups-admin' : 'inspection-admin');
  const settings = await api(`${base}/settings/${kind}`);
  const isBackup = kind === 'backup';
  root.innerHTML = `<div class="panel"><h3>${isBackup ? 'S3 数据库备份' : 'AI 站点巡查'}</h3><p>${isBackup ? '备份经过加密并上传至 S3 兼容存储。请离线保管 SETTINGS_ENCRYPTION_KEY；还原会覆盖当前数据库并使所有登录和 API 密钥失效。' : '默认人工审核。置信度是模型估计，并非法律结论。巡查仅抓取公开网页文本，不执行 JavaScript，不识别图片或视频；抓取失败需人工检查。网页内容将发送至配置的 AI 服务。'}</p><form class="operations-form"><div class="operations-grid">${isBackup ? [field(settings,'endpoint','S3 Endpoint（AWS 可留空）','url'),field(settings,'region','Region'),field(settings,'bucket','Bucket'),field(settings,'prefix','专用备份前缀'),field(settings,'accessKeyId','Access Key ID','password'),field(settings,'secretAccessKey','Secret Access Key','password'),field(settings,'retention','保留普通备份份数','number','min="1" max="365"'),field(settings,'maxBackupMb','单份备份大小上限（MiB）','number','min="1" max="102400"'),field(settings,'forcePathStyle','使用 Path Style','checkbox')].join('') : [field(settings,'baseUrl','OpenAI 兼容接口根地址（含 /v1）','url'),field(settings,'model','模型名称'),field(settings,'apiKey','API Key','password'),field(settings,'maxPages','每域名最多抓取页面数','number','min="1" max="5"'),field({ threshold: settings.threshold * 100 },'threshold','自动禁用置信度阈值（%）','number','min="50" max="100" step="1"'),field(settings,'autoDisable','启用自动禁用（默认关闭）','checkbox')].join('')}${field(settings,'intervalHours','定时间隔（小时）','number','min="1" max="720"')}${field(settings,'scheduled','启用定时任务','checkbox')}</div>${!isBackup ? `<fieldset><legend>关注类别</legend>${Object.keys(labels).slice(0,5).map(key => `<label class="operations-check"><input type="checkbox" name="categories" value="${key}" ${settings.categories.includes(key) ? 'checked' : ''}>${labels[key]}</label>`).join('')}</fieldset><label>补充判定规则<textarea name="policy" maxlength="4000">${escape(settings.policy)}</textarea></label>` : ''}<button type="submit">保存配置</button><span data-save-status role="status"></span></form></div><div class="panel"><div class="operations-actions">${isBackup ? '<button data-test class="secondary">测试 S3 连接</button><button data-run>立即备份</button>' : '<label>网站 ID（留空巡查全部）<input data-site type="number" min="1"></label><button data-run>手动巡查</button>'}<button class="secondary" data-refresh>刷新记录</button></div><p data-status role="status"></p><div data-records class="operations-table"></div><h3>最近任务</h3><div data-jobs class="operations-table"></div></div>`;
  const post = (route, body = {}) => api(`${base}/${route}`, { method: 'POST', body: JSON.stringify(body) });
  const safe = handler => async event => {
    const button = event?.currentTarget; if (button?.tagName === 'BUTTON') button.disabled = true;
    try { await handler(event); } catch (error) { toast(error.message, true); }
    finally { if (button?.tagName === 'BUTTON') button.disabled = false; }
  };
  const refresh = async () => {
    const jobs = await api(`${base}/jobs`);
    root.querySelector('[data-jobs]').innerHTML = `<table><thead><tr><th>创建时间</th><th>类型 / 状态</th><th>结果</th></tr></thead><tbody>${jobs.map(job => `<tr><td>${escape(time(job.created_at))}</td><td>${escape(job.kind)} / ${escape(states[job.status] || job.status)}</td><td><pre>${escape(job.error || job.result)}</pre></td></tr>`).join('') || '<tr><td colspan="3">暂无任务</td></tr>'}</tbody></table>`;
    try {
      const rows = await api(`${base}/${isBackup ? 'backups' : 'inspections'}`);
      root.querySelector('[data-records]').innerHTML = isBackup
        ? `<p>还原前自动备份不参与自动清理，需手动删除。记录读取自 S3。</p><table><thead><tr><th>时间 / ID</th><th>类型 / 大小</th><th>操作</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(time(row.createdAt))}<br>${escape(row.id)}</td><td>${escape(row.reason)} / ${(row.size / 1048576).toFixed(2)} MiB</td><td><button data-restore="${escape(row.id)}" class="secondary">覆盖还原</button> <button data-delete="${escape(row.id)}" class="secondary">删除</button></td></tr>`).join('') || '<tr><td colspan="3">暂无备份</td></tr>'}</tbody></table>`
        : `<table><thead><tr><th>网站 / 时间</th><th>判定 / 置信度</th><th>依据与审核</th></tr></thead><tbody>${rows.map(row => {
          let evidence = {}; try { evidence = JSON.parse(row.evidence); } catch { /* old records */ }
          return `<tr><td>#${escape(row.site_id)} ${escape(row.domain)}<br>${escape(time(row.created_at))}</td><td>${escape(labels[row.category] || states[row.status] || row.status)}<br>${row.confidence === null ? '—' : `${(row.confidence * 100).toFixed(1)}%`}<br>${escape(states[row.status] || '')}<br>${escape(states[row.hold_status] || row.hold_status || '')}</td><td>${escape(evidence.reason || row.error || '')}${(evidence.evidence || []).map(item => `<blockquote>${escape(item.quote)}<br>${escape(item.url)}</blockquote>`).join('')}${row.error && evidence.reason ? `<p>${escape(row.error)}</p>` : ''}${row.site_id ? `<button class="secondary" data-review="${escape(row.id)}" data-site-id="${escape(row.site_id)}" data-action="${row.hold_status ? 'enable' : 'disable'}">${row.hold_status ? '审核并重新启用' : '审核并禁用'}</button> ${!row.hold_status && row.status !== 'reviewed' ? `<button class="secondary" data-review="${escape(row.id)}" data-site-id="${escape(row.site_id)}" data-action="approve">审核通过</button>` : ''}` : ''}</td></tr>`;
        }).join('') || '<tr><td colspan="3">暂无巡查记录</td></tr>'}</tbody></table>`;
      root.querySelector('[data-status]').textContent = '记录已更新；后台执行期间可刷新查看结果。';
    } catch (error) { root.querySelector('[data-status]').textContent = error.message; }
    root.querySelectorAll('[data-restore],[data-delete]').forEach(button => { button.onclick = safe(async () => {
      const restore = Boolean(button.dataset.restore); const backupId = button.dataset.restore || button.dataset.delete;
      const data = await confirmation({ title: restore ? '覆盖当前业务数据库' : '删除 S3 备份', text: restore ? '停止外部数据库写入，并将应用缩至单实例。执行前自动备份，随后进入维护状态覆盖数据库；完成后应用重启，须使用备份中的账户重新登录。' : '这将删除此备份的清单和加密数据。', password: restore, expected: `${restore ? 'RESTORE' : 'DELETE'} ${backupId}` });
      if (!data) return; await post(restore ? 'restore' : 'delete-backup', { ...data, backupId }); toast('任务已加入队列'); await refresh();
    }); });
    root.querySelectorAll('[data-review]').forEach(button => { button.onclick = safe(async () => {
      const data = await confirmation({ title: button.textContent, text: '请核查页面与证据后填写审核理由。重新启用仍受客户状态及套餐限额约束。', reason: true });
      if (!data) return; await post('inspection-action', { ...data, siteId: button.dataset.siteId, inspectionId: button.dataset.review, action: button.dataset.action }); toast('审核操作已完成'); await refresh();
    }); });
  };
  root.querySelector('form').onsubmit = safe(async event => {
    event.preventDefault(); const form = event.target; const data = Object.fromEntries(new FormData(form));
    for (const key of ['scheduled', ...(isBackup ? ['forcePathStyle'] : ['autoDisable'])]) data[key] = form.elements[key].checked;
    for (const key of ['intervalHours', ...(isBackup ? ['retention','maxBackupMb'] : ['maxPages','threshold'])]) data[key] = Number(data[key]);
    if (!isBackup) { data.threshold /= 100; data.categories = new FormData(form).getAll('categories'); }
    await api(`${base}/settings/${kind}`, { method: 'PUT', body: JSON.stringify(data) });
    form.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; input.placeholder = '已配置，留空保持不变'; });
    root.querySelector('[data-save-status]').textContent = '配置已保存'; toast('配置已保存');
  });
  root.querySelector('[data-run]').onclick = safe(async () => { await post(kind, isBackup ? {} : { siteId: root.querySelector('[data-site]').value }); toast('任务已加入队列，约15秒内开始'); await refresh(); });
  root.querySelector('[data-refresh]').onclick = safe(refresh);
  if (isBackup) root.querySelector('[data-test]').onclick = safe(async () => { await post('test-s3'); toast('S3 连接成功'); });
  await refresh();
}
