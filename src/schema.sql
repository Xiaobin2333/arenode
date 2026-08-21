CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  email_verified_at TIMESTAMPTZ,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  site_limit INTEGER NOT NULL DEFAULT 1 CHECK (site_limit >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL DEFAULT 'admin' CHECK (role_key IN ('super_admin', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_mfa (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  recovery_code_hashes TEXT,
  confirmed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_registrations (
  email TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ;
ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS invite_id BIGINT;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  email TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS email_change_tokens (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Local compatibility resources. These never contain or proxy shared CDNFly
-- account credentials; they are scoped to the platform customer account.
CREATE TABLE IF NOT EXISTS user_configs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'site' CHECK (type IN ('site', 'stream', 'cert')),
  scope_id BIGINT NOT NULL DEFAULT 0,
  scope_name TEXT NOT NULL DEFAULT 'global' CHECK (scope_name IN ('global', 'group')),
  enable INTEGER NOT NULL DEFAULT 1 CHECK (enable IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS value TEXT NOT NULL DEFAULT '';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'site';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS scope_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS scope_name TEXT NOT NULL DEFAULT 'global';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS enable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_configs DROP CONSTRAINT IF EXISTS user_configs_user_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_configs_scope_unique
  ON user_configs(user_id, name, type, scope_name, scope_id);

CREATE TABLE IF NOT EXISTS user_api_keys (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS package_groups (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS upstream_accounts (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  cname_suffix TEXT,
  api_key_encrypted TEXT NOT NULL,
  api_secret_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  is_default INTEGER NOT NULL DEFAULT 0,
  requests_per_minute INTEGER NOT NULL DEFAULT 300 CHECK (requests_per_minute > 0),
  timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK (timeout_ms >= 1000),
  last_health_status TEXT CHECK (last_health_status IS NULL OR last_health_status IN ('healthy', 'unhealthy')),
  last_health_error TEXT,
  last_checked_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE upstream_accounts ADD COLUMN IF NOT EXISTS cname_suffix TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_accounts_default ON upstream_accounts(is_default) WHERE is_default=1;

CREATE TABLE IF NOT EXISTS upstream_packages (
  id BIGSERIAL PRIMARY KEY,
  upstream_id BIGINT NOT NULL REFERENCES upstream_accounts(id) ON DELETE RESTRICT,
  package_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(upstream_id, package_id)
);
CREATE TABLE IF NOT EXISTS plans (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT REFERENCES package_groups(id) ON DELETE SET NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  duration_days INTEGER NOT NULL DEFAULT 30 CHECK (duration_days > 0),
  domain_limit INTEGER CHECK (domain_limit IS NULL OR domain_limit >= 0),
  traffic_limit_bytes BIGINT CHECK (traffic_limit_bytes IS NULL OR traffic_limit_bytes >= 0),
  port_limit INTEGER CHECK (port_limit IS NULL OR port_limit >= 0),
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS upstream_id BIGINT REFERENCES upstream_accounts(id) ON DELETE RESTRICT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS upstream_package_id TEXT;
CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id BIGINT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'expired', 'cancelled')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_ends_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_failed_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_renewed_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS upstream_id BIGINT REFERENCES upstream_accounts(id) ON DELETE RESTRICT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS upstream_package_id TEXT;

-- Website groups are reseller-console metadata. They deliberately stay local:
-- customers sharing one CDNFly account must never create or rename upstream
-- site groups for one another.
CREATE TABLE IF NOT EXISTS customer_site_groups (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);
-- Four-layer groups shown in the reseller console are local metadata too.
-- CDNFly receives a separate hidden per-customer group maintained below.
CREATE TABLE IF NOT EXISTS customer_stream_groups (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);
-- Hidden CDNFly groups are unique per customer, upstream account and resource
-- kind. They are never exposed as the customer's in-console groups.
CREATE TABLE IF NOT EXISTS upstream_customer_groups (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_account_id BIGINT NOT NULL REFERENCES upstream_accounts(id) ON DELETE RESTRICT,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('site', 'stream')),
  upstream_group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, upstream_account_id, resource_kind),
  UNIQUE(upstream_account_id, resource_kind, upstream_group_id)
);
CREATE TABLE IF NOT EXISTS upstream_customer_group_history (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_account_id BIGINT NOT NULL REFERENCES upstream_accounts(id) ON DELETE RESTRICT,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('site', 'stream')),
  upstream_group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleaned_at TIMESTAMPTZ,
  UNIQUE(upstream_account_id, resource_kind, upstream_group_id)
);
CREATE TABLE IF NOT EXISTS sites (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
  upstream_id TEXT UNIQUE,
  domain TEXT NOT NULL,
  origin TEXT NOT NULL,
  backend_protocol TEXT NOT NULL DEFAULT 'http',
  backend_host TEXT,
  websocket INTEGER NOT NULL DEFAULT 0,
  gzip INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'provisioning',
  cname TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE sites ADD COLUMN IF NOT EXISTS upstream_account_id BIGINT REFERENCES upstream_accounts(id) ON DELETE RESTRICT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS local_group_id BIGINT REFERENCES customer_site_groups(id) ON DELETE SET NULL;
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_upstream_id_key;
DROP INDEX IF EXISTS idx_sites_legacy_upstream_unique;
DROP INDEX IF EXISTS idx_sites_scoped_upstream_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_upstream_scope_unique ON sites(COALESCE(upstream_account_id, 0), upstream_id);
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tenant_resources (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT,
  enabled INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE tenant_resources ADD COLUMN IF NOT EXISTS upstream_account_id BIGINT REFERENCES upstream_accounts(id) ON DELETE RESTRICT;
ALTER TABLE tenant_resources ADD COLUMN IF NOT EXISTS local_group_id BIGINT REFERENCES customer_stream_groups(id) ON DELETE SET NULL;
ALTER TABLE tenant_resources ADD COLUMN IF NOT EXISTS ownership_marker TEXT;
ALTER TABLE tenant_resources DROP CONSTRAINT IF EXISTS tenant_resources_kind_upstream_id_key;
DROP INDEX IF EXISTS idx_resources_legacy_upstream_unique;
DROP INDEX IF EXISTS idx_resources_scoped_upstream_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_upstream_scope_unique ON tenant_resources(COALESCE(upstream_account_id, 0), kind, upstream_id);
CREATE TABLE IF NOT EXISTS stream_ports (
  resource_id BIGINT NOT NULL REFERENCES tenant_resources(id) ON DELETE CASCADE,
  port INTEGER NOT NULL CHECK (port > 0 AND port <= 65535),
  PRIMARY KEY (resource_id, port)
);
CREATE TABLE IF NOT EXISTS monitor_documents (
  id BIGSERIAL NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  document_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE monitor_documents ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE monitor_documents ADD COLUMN IF NOT EXISTS upstream_account_id BIGINT REFERENCES upstream_accounts(id) ON DELETE RESTRICT;
ALTER TABLE monitor_documents DROP CONSTRAINT IF EXISTS monitor_documents_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_documents_id_unique ON monitor_documents(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_documents_scope_unique
  ON monitor_documents(user_id, kind, COALESCE(upstream_account_id, 0), document_id);
CREATE TABLE IF NOT EXISTS plan_upgrades (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  domain_increment INTEGER NOT NULL DEFAULT 0,
  traffic_increment_bytes BIGINT NOT NULL DEFAULT 0,
  port_increment INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subscription_upgrades (
  subscription_id BIGINT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  upgrade_id BIGINT NOT NULL REFERENCES plan_upgrades(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL DEFAULT 1 CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (subscription_id, upgrade_id)
);
CREATE TABLE IF NOT EXISTS traffic_packages (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  traffic_bytes BIGINT NOT NULL CHECK (traffic_bytes > 0),
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  duration_days INTEGER NOT NULL DEFAULT 30 CHECK (duration_days > 0),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_traffic_packages (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id BIGINT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  traffic_package_id BIGINT REFERENCES traffic_packages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  traffic_bytes BIGINT NOT NULL CHECK (traffic_bytes > 0),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  product_id BIGINT,
  subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded')),
  channel TEXT,
  metadata TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_snapshot TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_transaction_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS monthly_usage (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  traffic_bytes BIGINT NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, period)
);
CREATE TABLE IF NOT EXISTS subscription_monthly_usage (
  subscription_id BIGINT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  traffic_bytes BIGINT NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ,
  PRIMARY KEY (subscription_id, period)
);
CREATE TABLE IF NOT EXISTS site_custom_ports (
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  port INTEGER NOT NULL CHECK (port > 0 AND port <= 65535),
  PRIMARY KEY (site_id, port)
);
CREATE TABLE IF NOT EXISTS quota_suspensions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('site', 'stream')),
  resource_id BIGINT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  restored_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS redemption_codes (
  id BIGSERIAL PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_suffix TEXT NOT NULL,
  label TEXT,
  type TEXT NOT NULL CHECK (type IN ('plan', 'upgrade', 'traffic')),
  product_id BIGINT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 1 CHECK (amount > 0),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS redemption_uses (
  id BIGSERIAL PRIMARY KEY,
  code_id BIGINT NOT NULL REFERENCES redemption_codes(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code_id, user_id)
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  balance_after_cents BIGINT NOT NULL CHECK (balance_after_cents >= 0),
  reference_type TEXT NOT NULL,
  reference_id TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_reference
  ON wallet_transactions(reference_type, reference_id)
  WHERE reference_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS recharge_codes (
  id BIGSERIAL PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_suffix TEXT NOT NULL,
  label TEXT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE recharge_codes ADD COLUMN IF NOT EXISTS batch_id BIGINT;

CREATE TABLE IF NOT EXISTS recharge_code_batches (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  code_count INTEGER NOT NULL CHECK (code_count > 0),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recharge_code_uses (
  id BIGSERIAL PRIMARY KEY,
  code_id BIGINT NOT NULL REFERENCES recharge_codes(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id BIGINT NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code_id, user_id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registration_invites (
  id BIGSERIAL PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_suffix TEXT NOT NULL,
  label TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  expires_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS blocked_identities;

CREATE INDEX IF NOT EXISTS idx_sites_owner ON sites(owner_id);
CREATE INDEX IF NOT EXISTS idx_sites_subscription ON sites(subscription_id);
CREATE INDEX IF NOT EXISTS idx_tenant_resources_owner_kind ON tenant_resources(owner_id, kind);
CREATE INDEX IF NOT EXISTS idx_resources_subscription ON tenant_resources(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status, ends_at);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_suspensions_active ON quota_suspensions(user_id, resource_kind, resource_id) WHERE restored_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_redemption_codes_status ON redemption_codes(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_redemption_uses_user ON redemption_uses(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_codes_status ON recharge_codes(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_recharge_code_uses_user ON recharge_code_uses(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expiry ON mfa_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_registration_invites_status ON registration_invites(status, expires_at);
