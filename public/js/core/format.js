export function formatDate(value) {
  if (!value) return '-';
  const text = String(value).trim();
  if (!text || text === '-' || text === '0') return '-';
  const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export const GIB = 1024 ** 3;

export const formatMoney = cents => `¥${(Number(cents || 0) / 100).toFixed(2)}`;

export const orderNetAmountCents = order => order.type === 'plan_change' && Number(order.balanceAdjustmentCents) > 0
  ? -Number(order.amountCents || 0) : Number(order.amountCents || 0);

export const orderAmountLabel = order => orderNetAmountCents(order) < 0 ? `退款 ${formatMoney(Math.abs(orderNetAmountCents(order)))}` : formatMoney(order.amountCents);

export function formatBytes(value) {
  if (value === null || value === undefined) return '不限';
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return '-';
  if (Math.abs(bytes) < 1024) return `${bytes.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} B`;
  if (Math.abs(bytes) < 1024 ** 2) return `${(bytes / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} KiB`;
  if (Math.abs(bytes) < GIB) return `${(bytes / 1024 ** 2).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} MiB`;
  return `${(bytes / GIB).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} GiB`;
}

export const formatLimit = value => value === null || value === undefined ? '不限' : Number(value).toLocaleString('zh-CN');

export function remainingDays(item) {
  const ends = new Date(item?.subscription?.endsAt || item?.endsAt || item?.ends_at || 0);
  return Number.isFinite(ends.getTime()) ? (ends.getTime() - Date.now()) / 86400_000 : 0;
}

const financeTypeLabels = {
  'recharge-code': '充值码入账', 'admin-adjustment': '管理员余额调整', order: '订单支付',
  'order-refund': '订单退款', recharge: '余额充值', refund: '退款', redemption: '权益兑换',
};

export const financeTypeLabel = value => financeTypeLabels[value] || value || '其他';

export function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
