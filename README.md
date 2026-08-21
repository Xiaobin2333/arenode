# Arenode

Arenode 是面向 CDNFly v6 普通用户 API 的开源多租户 CDN 资源管理与分销控制台。它在一个或多个上游 CDNFly 账号之上提供独立客户账号、套餐与余额、网站和四层转发管理、安全策略、证书、日志、监控以及管理员后台。

> Arenode 不是 CDN 节点或 CDNFly 的替代品。运行本项目需要你合法持有可用的 CDNFly v6 普通用户 API 账号。本项目与 CDNFly 官方没有隶属、授权或背书关系。

## 功能特性

- 多上游账号与套餐映射：不同销售套餐可固定到不同上游账号和上游套餐。
- 多租户资源隔离：浏览器只接触本地 ID，网站、证书、安全资源、转发和日志均校验客户归属。
- 网站管理：创建、配置、启停、删除、CNAME 检查、HTTPS、回源、缓存和访问控制。
- 安全与证书：证书、DNS API、ACL、CC 规则、WAF 编排和自动续签状态展示。
- 四层转发：TCP/UDP 转发、站内分组、源站配置、监控与用量。
- 数据中心：实时监控、质量与回源数据、排行、访问日志、任务和用量查询。
- 本地商业能力：客户、套餐、余额、充值码、订单、退款、续费、流量包和审计日志。
- 账号安全：邮箱验证、Turnstile、TOTP MFA、恢复码、登录设备、限流和会话撤销。
- Docker 部署：PostgreSQL 保存业务数据，Redis 提供缓存、限流和多实例协调。

## 工作方式

```text
浏览器
  │  本地会话、本地资源 ID
  ▼
Arenode ───── PostgreSQL（用户、归属、套餐、钱包、审计）
  │  └────── Redis（缓存、限流、请求合并）
  │
  ├── CDNFly 普通用户 API 账号 A
  └── CDNFly 普通用户 API 账号 B ...
```

客户创建的网站和转发会按套餐路由到指定上游。客户在控制台看到的网站分组和转发分组仅保存在 Arenode，不会在上游创建同名分组；Arenode 会为每个“客户 + 上游账号”维护一个隐藏网站分组和一个隐藏转发分组，并将资源自动归入其中。分组和资源备注使用不可逆标识，不包含控制台域名、IP 或端口，因此多个 Arenode 实例可以安全共用同一个上游账号。

## 环境要求

推荐使用 Docker Compose：

- Docker Engine 24+
- Docker Compose v2
- 一个可用的 CDNFly v6 普通用户 API 账号
- 用于生产访问的域名和 HTTPS 反向代理

本地源码运行还需要 Node.js 22.5+、PostgreSQL 17 和 Redis 7。

## Docker 快速开始

### 1. 准备配置

克隆仓库并进入项目目录后：

```bash
cp .env.example .env
chmod 600 .env
```

生成三个独立随机值：

```bash
openssl rand -hex 24
openssl rand -base64 48
openssl rand -base64 24
```

编辑 `.env`，至少替换以下配置：

```dotenv
APP_ORIGIN=http://localhost:3080
POSTGRES_PASSWORD=<第一个随机值>
SETTINGS_ENCRYPTION_KEY=<第二个随机值，至少 32 个字符>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<第三个随机值>
UPSTREAM_GROUP_NAMESPACE=<当前部署唯一的随机标识>
```

`UPSTREAM_GROUP_NAMESPACE` 在多个 Arenode 实例共享同一上游账号时必须各不相同。不要填写控制台域名、IP 或客户信息。

### 2. 启动服务

```bash
docker compose config
docker compose up -d --build
docker compose ps
```

默认只监听 `127.0.0.1:3080`。本机浏览器打开 [http://localhost:3080](http://localhost:3080)，使用 `.env` 中的初始管理员账号登录。

仓库的 GitHub Actions 会在 PR 中验证 Docker 构建，并在推送到 `main` 或 `v*` 版本标签时发布 `linux/amd64`、`linux/arm64` 镜像到 `ghcr.io/<仓库所有者>/<仓库名>`。使用已发布镜像时，在 `.env` 设置：

```dotenv
ARENODE_IMAGE=ghcr.io/<仓库所有者>/<仓库名>:latest
```

然后运行 `docker compose pull && docker compose up -d`。版本标签（例如 `v1.0.0`）会同时生成 `1.0.0`、`1.0` 和提交 SHA 标签，生产环境建议固定版本标签而不是 `latest`。

### 3. 初始化控制台

首次登录后按以下顺序配置：

1. 在“上游管理”添加 CDNFly v6 API 地址、API Key、API Secret 和 CNAME 后缀。
2. 同步或录入该账号可用的上游套餐。
3. 在“套餐目录”创建客户可购买的本地套餐，并映射到上游账号和套餐。
4. 创建专用测试客户和套餐实例，先验证网站、证书、转发、日志与监控，再接入正式客户。
5. 确认管理员已经写入数据库后，从 `.env` 删除 `ADMIN_PASSWORD` 并重建应用容器。

环境变量中的 `CDNFLY_*` 只用于首次启动兼容迁移。正常运营应从管理员后台维护多个上游账号。

## 生产部署

生产环境不要把 3080 端口直接暴露到公网。保持默认回环监听，通过 Caddy、Nginx 或其他反向代理提供 HTTPS，并将 `APP_ORIGIN` 设置为完整外部地址。

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name console.example.com;

    ssl_certificate     /etc/letsencrypt/live/console.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/console.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

对应 `.env`：

```dotenv
APP_ORIGIN=https://console.example.com
ALLOW_REGISTRATION=false
MAIL_DEV_EXPOSE_CODE=false
```

公开注册默认关闭。需要自助注册时，应先配置 SMTP、邮箱验证和 Cloudflare Turnstile，再从管理员后台开启。`MAIL_DEV_EXPOSE_CODE` 仅供本地开发；生产进程即使读到 `true` 也不会返回验证码。

若确实需要从其他机器直接访问 3080，可设置 `ARENODE_BIND_ADDRESS=0.0.0.0`，但仍应使用防火墙限制来源，不能代替 HTTPS 反向代理。

## 配置参考

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `APP_ORIGIN` | 生产必填 | `http://localhost:3080` | 浏览器实际访问源；HTTPS 时会启用 Secure Cookie |
| `PORT` | 否 | `3080` | 容器内应用端口 |
| `ARENODE_BIND_ADDRESS` | 否 | `127.0.0.1` | Compose 对宿主机的监听地址 |
| `POSTGRES_PASSWORD` | 是 | 无 | Compose PostgreSQL 密码 |
| `DATABASE_URL` | 源码运行必填 | 本地示例 | PostgreSQL 连接串；Compose 自动覆盖 |
| `REDIS_URL` | 否 | `redis://localhost:6379` | Redis 连接串；Compose 自动覆盖 |
| `SETTINGS_ENCRYPTION_KEY` | 是 | 无 | 上游凭据加密主密钥，至少 32 个随机字符 |
| `UPSTREAM_GROUP_NAMESPACE` | 强烈建议 | 由 `APP_ORIGIN` 派生 | 多部署共享上游时的唯一匿名命名空间 |
| `ADMIN_USERNAME` | 首次启动 | `admin` | 初始管理员用户名 |
| `ADMIN_PASSWORD` | 首次启动 | 无 | 初始管理员密码；创建成功后删除 |
| `ALLOW_REGISTRATION` | 否 | `false` | 首次启动的公开注册默认值 |
| `EMAIL_VERIFICATION_ENABLED` | 否 | `false` | 首次启动的注册邮箱验证默认值 |
| `SMTP_*` | 按需 | 无 | 验证码邮件服务配置 |
| `MAIL_DEV_EXPOSE_CODE` | 否 | `false` | 仅非生产开发进程可回显验证码 |
| `CDNFLY_CACHE_TTL_SECONDS` | 否 | `30` | 普通上游 GET 缓存时间 |
| `CDNFLY_MONITOR_CACHE_TTL_SECONDS` | 否 | `8` | 监控数据缓存时间 |
| `CDNFLY_REQUESTS_PER_MINUTE` | 否 | `300` | 每个上游账号的请求预算 |
| `POSTGRES_VOLUME_NAME` | 否 | `arenode-postgres-data` | PostgreSQL 数据卷名 |
| `REDIS_VOLUME_NAME` | 否 | `arenode-redis-data` | Redis 数据卷名 |
| `ARENODE_EXTERNAL_VOLUMES` | 否 | `false` | 使用预先创建的数据卷时设为 `true` |

全部选项和注释见 [.env.example](./.env.example)。管理员后台保存的运行参数会覆盖注册、邮箱验证、Turnstile 和计费等对应启动默认值。

## 本地开发

先准备可访问的 PostgreSQL 与 Redis，并填写 `.env`：

```bash
npm ci
npm run dev
```

数据库结构由 [src/schema.sql](./src/schema.sql) 在启动时幂等初始化。旧版 SQLite 文件 `data/reseller.db` 不会自动迁移到 PostgreSQL。

## 测试

运行本地测试：

```bash
npm test
```

## 备份、升级与恢复

业务数据以 PostgreSQL 为准：

```bash
docker compose exec -T postgres pg_dump -U cdnfly -d cdnfly_reseller -Fc > arenode.dump
```

升级前应同时保存 `.env`、`SETTINGS_ENCRYPTION_KEY` 和数据库备份，然后：

```bash
docker compose pull
docker compose up -d --build
docker compose ps
```

在隔离数据库使用 `pg_restore --exit-on-error` 演练恢复，并核对用户、钱包流水、订单、套餐、网站和审计记录。Redis 只存放可重建缓存与短期协调状态，不是业务备份来源。不要在未验证备份时删除 Docker 卷。

旧部署复用已有卷时：

```dotenv
POSTGRES_VOLUME_NAME=<现有 PostgreSQL 卷名>
REDIS_VOLUME_NAME=<现有 Redis 卷名>
ARENODE_EXTERNAL_VOLUMES=true
```

## 相关文档

- [文档中心](./doc/README.md)
- [架构与实现说明](./doc/ARCHITECTURE.md)
- [API 能力矩阵](./doc/API_CAPABILITY_MATRIX.md)
- [网站与安全接口兼容说明](./doc/API_COMPATIBILITY.md)
- [转发、监控与日志兼容说明](./doc/DATA_COMPATIBILITY.md)
- [计费兼容说明](./doc/BILLING_COMPATIBILITY.md)
- [账号与管理员接口](./doc/ACCOUNT_ADMIN.md)
- [生产部署验收清单](./doc/DEPLOYMENT_CHECKLIST.md)

## 常见问题

### 为什么启动后没有 CDN 数据？

先确认管理员后台存在已启用且探针正常的上游账号，本地套餐已经映射上游套餐，客户也持有生效套餐。监控和日志只有在上游对应资源实际产生请求后才会返回数据。

### 为什么证书一直在签发或没有到期时间？

Arenode 展示上游实际签发和同步状态。请确认测试域名的 CNAME 可公开解析到上游目标；上游未返回到期时间时界面会显示“上游未返回”，本地不会伪造日期。

## 参与贡献

提交 Issue 或 Pull Request 前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。涉及安全问题时请按 [SECURITY.md](./SECURITY.md) 私密报告，不要公开凭据、客户数据或可利用细节。

## 许可证

Arenode 使用 [MIT License](./LICENSE) 发布。
