# 运行环境升级

当前验证版本为 Node.js 24.22.0 LTS、PostgreSQL 18.6、Redis 8.10.2。Node.js 26 当前尚未进入 LTS，生产镜像保留 24 LTS 并固定补丁版本。应用的 `pg` / `redis` npm 客户端与服务器版本独立，保持当前锁定版本并使用真实数据库测试兼容性。

全新部署直接使用 `compose.yaml`。已有部署必须安排停写窗口并先演练恢复。本次仓库升级不会自动迁移线上数据。

## PostgreSQL 17 → 18

18 官方镜像将数据目录改为 `/var/lib/postgresql/18/docker`，卷挂载改为 `/var/lib/postgresql`。不能仅修改镜像标签，也不能通过移动文件把 17 数据变成 18 数据。当前卷名默认值保持不变；误挂旧卷时官方镜像会拒绝启动，不会自动迁移。

1. 在旧版本配置仍生效时，记录旧应用镜像摘要、旧 PostgreSQL/Redis 卷名与镜像版本，备份 `.env` 和加密密钥。停止应用及所有外部写入者，再导出业务库：

   ```bash
   docker compose stop app
   docker compose exec -T postgres pg_dump -U cdnfly -d cdnfly_reseller -Fc > arenode-before-pg18.dump
   docker compose exec -T postgres pg_restore --list < arenode-before-pg18.dump
   docker compose stop postgres redis
   ```

   上述命令适用于仓库默认单库/单用户配置；自定义角色、扩展、其他业务库须另行导出并核对。备份文件应保存在受控目录并加密异地保存。

2. 更新代码到当前版本，将 `.env` 中 `POSTGRES_VOLUME_NAME` 改成一个确认未被使用的新卷名，例如 `arenode-postgres18-data`，旧卷保留。若 `ARENODE_EXTERNAL_VOLUMES=true`，先手动创建新的命名卷。不要执行 `docker compose down -v`。

3. 拉取新镜像，仅启动 PostgreSQL，等待健康检查通过，然后在应用尚未启动、空白库尚未执行应用 schema 初始化时恢复：

   ```bash
   docker compose pull postgres redis
   docker compose up -d --wait postgres
   docker compose exec -T postgres pg_restore --exit-on-error --single-transaction --no-owner --no-acl -U cdnfly -d cdnfly_reseller < arenode-before-pg18.dump
   docker compose exec -T postgres psql -U cdnfly -d cdnfly_reseller -c 'ANALYZE;'
   ```

4. 核对表数量、用户/钱包/订单/套餐/站点/审计记录及关键金额总数，完成下方 Redis 迁移，再启动应用并验证登录、数据库健康和计费任务。恢复失败时停止，不在部分恢复库上启动应用。

## Redis 7 → 8

Redis 保存缓存、限流及短期协调状态。停写期间备份原 Redis 数据卷并保留原卷。建议复制停机后的完整 `/data`（包括 `appendonlydir`）到一个新命名卷，将 `REDIS_VOLUME_NAME` 指向该副本，再用 8.10.2 启动；不要让两个 Redis 实例同时使用同一个数据卷。新卷权限必须允许容器用户写入。检查启动日志、`redis-cli ping`、持久化状态及限流/冷却功能。

如果选择使用空的新卷，所有短期限流和冷却记录都会重置，须在维护窗口内明确接受这一影响后再开放流量。新版本写出的 RDB/AOF 不应直接交给 Redis 7 回滚；回滚使用保留的停机前旧卷。

## 启动与回滚

```bash
docker compose up -d --wait redis
docker compose up -d --build --wait app
docker compose ps
```

开放流量前验证 HTTPS、登录、租户资源、计费与邮件。失败时保持停写，恢复旧代码/应用镜像和旧 `.env` 卷名，使用 PostgreSQL 17 原 `/var/lib/postgresql/data` 挂载及 Redis 7 原卷启动。开始接收新写入后，直接回滚旧卷会丢失切换后的写入，必须先制定数据对账/回迁方案。验收完成前不删除任何旧卷或备份。

参考：[Node.js 发布](https://nodejs.org/en/about/previous-releases)、[PostgreSQL 官方镜像目录说明](https://hub.docker.com/_/postgres)、[PostgreSQL 大版本升级](https://www.postgresql.org/docs/18/upgrading.html)、[Redis 持久化](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)。
