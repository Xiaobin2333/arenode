import { normalizeUpstreamGroupNamespace } from './config.js';
import { BRAND_GROUP_PREFIX, LEGACY_BRAND_GROUP_PREFIXES } from './brand.js';

export const OWNERSHIP_REMARK_KINDS = new Set([
  'certs', 'dnsapis', 'cc-filters', 'cc-matchs', 'cc-rules', 'waf-rules', 'acls', 'streams',
]);

const OWNERSHIP_PREFIX = new RegExp(
  `^\\[(?:${[BRAND_GROUP_PREFIX, ...LEGACY_BRAND_GROUP_PREFIXES].join('|')}):[A-Z0-9-]+:U\\d{6}\\]\\s*`,
);

export function ownershipMarker(client, userId) {
  if (!client?.groupNamespace) throw Object.assign(new Error('未配置当前站点的上游分组命名空间'), { status: 503 });
  const namespace = normalizeUpstreamGroupNamespace(client.groupNamespace);
  const suffix = String(Number(userId)).padStart(6, '0');
  return `[${BRAND_GROUP_PREFIX}:${namespace}:U${suffix}]`;
}

export function stripOwnershipRemark(value) {
  return String(value ?? '').replace(OWNERSHIP_PREFIX, '').trim();
}

export function ownershipRemark(client, userId, value = '', maxLength = 240) {
  const marker = ownershipMarker(client, userId);
  const available = Math.max(0, maxLength - marker.length - 1);
  const customerRemark = stripOwnershipRemark(value).slice(0, available);
  return customerRemark ? `${marker} ${customerRemark}` : marker;
}

export function exposeOwnershipRemark(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const output = { ...record };
  if (Object.hasOwn(output, 'des')) output.des = stripOwnershipRemark(output.des);
  if (Object.hasOwn(output, 'description')) output.description = stripOwnershipRemark(output.description);
  return output;
}

export const resourceOwnershipInternals = { OWNERSHIP_PREFIX };
