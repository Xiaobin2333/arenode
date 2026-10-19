export const billingState = {
  wallet: { balanceCents: 0, availableBalanceCents: 0, totalRechargeCents: 0, totalSpentCents: 0, transactions: [] },
  billingPlans: [],
  billingOrders: [],
  billingUpgrades: [],
  billingTraffic: [],
  redemptions: [],
  billingAdmin: {},
  currentOrder: null,
  planChangeQuote: null,
  planChangeRequest: null,
  billingTarget: 'current',
};
