import test from 'node:test';
import assert from 'node:assert/strict';
import { certificateLifecycle, resourceEnabled, resourceLifecycle, siteLifecycle } from '../public/resource-status.js';

const now = new Date('2026-08-21T08:32:59Z');

test('自动证书任务失败等待重试时显示真实失败状态', () => {
  assert.deepEqual(certificateLifecycle({
    type: 'lets', enable: 1, task_enable: 1, issue_state: 'failed', start_time: null,
    retry_at2: '2026-08-21 16:47:57',
  }, now), { state: 'failed', tone: 'off danger-text', label: '签发失败，重试中' });
});

test('证书签发状态不会被启用开关误报为可用', () => {
  assert.equal(certificateLifecycle({ type: 'lets', enable: 1, task_enable: 0, issue_state: 'failed' }, now).label, '签发失败，已取消');
  assert.equal(certificateLifecycle({ type: 'lets', enable: 1, issue_state: 'pending' }, now).label, '待签发');
  assert.equal(certificateLifecycle({ type: 'lets', enable: 1, issue_state: 'process' }, now).label, '签发中');
  assert.equal(certificateLifecycle({ type: 'lets', enable: 1, issue_state: 'done' }, now).label, '正常');
  assert.equal(certificateLifecycle({ type: 'lets', enable: 1, sync_state: 'pending' }, now).label, '待同步');
  assert.equal(certificateLifecycle({ type: 'lets', enable: 1, sync_state: 'process' }, now).label, '同步中');
  assert.equal(certificateLifecycle({ type: 'lets', enable: 1, issue_state: 'success', start_time: '2026-08-21 16:30:00' }, now).label, '正常');
  assert.equal(certificateLifecycle({ type: 'lets', enable: 1, start_time: null, expire_time: null }, now).label, '正常');
  assert.equal(certificateLifecycle({ type: 'custom', enable: 0 }, now).label, '禁用');
  assert.equal(certificateLifecycle({ type: 'custom', enable: 1, start_time: '2026-08-21 16:30:00', sync_state: 'syncing' }, now).label, '同步中');
  assert.equal(certificateLifecycle({ type: 'custom', enable: 1, start_time: '2026-08-21 16:30:00', sync_state: 'failed' }, now).label, '同步失败');
});

test('通用资源明确区分处理、失败、暂停和停用状态', () => {
  assert.equal(resourceLifecycle({ status: 'processing' }, '', now).label, '处理中');
  assert.equal(resourceLifecycle({ status: 'failed' }, '', now).label, '处理失败');
  assert.equal(resourceLifecycle({ status: 'suspended' }, '', now).label, '已暂停');
  assert.equal(resourceLifecycle({ enable: 0 }, '', now).label, '已停用');
  assert.equal(resourceLifecycle({ sync_state: '200' }, '', now).label, '可用');
  assert.equal(resourceLifecycle({ status: 'disabled' }, '', now).label, '已停用');
  assert.equal(resourceLifecycle({ status: 'unexpected-state' }, '', now).label, '状态更新中');
  assert.equal(resourceLifecycle({}, '', now).label, '状态未知');
  assert.equal(resourceEnabled({ status: 0 }), true);
});

test('网站状态读取上游同步状态且不把未知值标记为运行中', () => {
  assert.equal(siteLifecycle({ enabled: true, syncState: '200' }).label, '运行中');
  assert.equal(siteLifecycle({ enabled: true, syncState: 'syncing' }).label, '配置中');
  assert.equal(siteLifecycle({ enabled: true, syncState: 'failed' }).label, '配置异常');
  assert.equal(siteLifecycle({ enabled: true, syncState: 'unexpected-state' }).label, '状态更新中');
});
