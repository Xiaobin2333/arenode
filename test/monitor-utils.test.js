import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMonitorPoints, formatMonitorChartLabel, formatMonitorTime, normalizeMonitorItems } from '../public/monitor-utils.js';

test('监控工具展开 CDNFly 命名序列并忽略空数据点', () => {
  const input = [
    { name: '456', value: [[1787249700000, 0], [1787254800000, 84], [1787255100000, null]] },
    { name: '409', value: [[1787249700000, 1], [1787254800000, 9]] },
  ];
  const items = normalizeMonitorItems(input);
  assert.deepEqual(items.map(item => [item.series, item.time, item.value]), [
    ['456', 1787249700000, 0], ['456', 1787254800000, 84], ['409', 1787249700000, 1], ['409', 1787254800000, 9],
  ]);
  assert.deepEqual(collectMonitorPoints(input), [
    { label: '1787249700000', value: 1 }, { label: '1787254800000', value: 93 },
  ]);
});

test('监控工具正确解析 CDNFly 时间戳与 Nginx 日志时间', () => {
  const nginx = formatMonitorTime('21/Aug/2026:03:40:57 +0800');
  assert.match(nginx, /2026/);
  assert.match(nginx, /03:40:57/);
  assert.doesNotMatch(formatMonitorChartLabel(1787249700000), /1787249700000/);
});
