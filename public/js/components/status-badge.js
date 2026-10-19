export function statusBadge(status) {
  const labels = { active: '生效中', suspended: '已暂停', pending: '等待客户', open: '处理中', resolved: '已解决', closed: '已关闭', paid: '已支付', cancelled: '已取消', refunded: '已退款', expired: '已到期' };
  const tone = ['active', 'paid', 'resolved'].includes(status) ? 'active' : ['pending', 'open'].includes(status) ? 'pending' : 'off';
  return `<span class="badge ${tone}">${labels[status] || status || '-'}</span>`;
}
