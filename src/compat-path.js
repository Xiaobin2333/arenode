const PREFIX = '/api/cdnfly/v1';

// Keep the local compatibility aliases while accepting the official v6 paths
// used by the upstream console and SDK. The resource APIs already use the
// official names; only legacy flattened aliases need translation here.
const ALIASES = [
  ['/common/menu2', '/common-menu-2'],
  ['/common/menu', '/common-menu'],
  ['/common/package-purchase-notice', '/common-package-purchase-notice'],
  ['/user/overview', '/user-overview'],
  ['/user/certify', '/user-certify'],
  ['/user/login-policy', '/user-login-policy'],
  ['/user-traffic-package/usage', '/user-traffic-package-usage'],
  ['/order/count', '/order-count'],
  ['/alipay/preorder', '/alipay-preorder'],
  ['/wxpay/preorder', '/wxpay-preorder'],
];

export function normalizeCdnflyPath(pathname) {
  if (!pathname.startsWith(`${PREFIX}/`)) return pathname;
  const path = pathname.slice(PREFIX.length);
  for (const [official, local] of ALIASES) {
    if (path === official || path.startsWith(`${official}/`)) return `${PREFIX}${local}${path.slice(official.length)}`;
  }
  return pathname;
}

export function normalizeCdnflyUrl(url) {
  const normalized = normalizeCdnflyPath(url.pathname);
  if (normalized !== url.pathname) url.pathname = normalized;
  return url;
}

export const compatPathInternals = { ALIASES };
