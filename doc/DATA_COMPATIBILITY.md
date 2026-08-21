# 转发与数据 API 兼容层

接口基地址为 `/api/cdnfly/v1`，使用平台登录 Cookie 鉴权。成功响应格式、错误格式及本地 ID 规则与 [API_COMPATIBILITY.md](./API_COMPATIBILITY.md) 相同。

## 四层转发

四层转发和站内分组使用独立本地 ID。完整支持：

```text
GET    /stream-groups
POST   /stream-groups
GET    /stream-groups/{id}
PUT    /stream-groups/{id}
DELETE /stream-groups/{id[,id]}

GET    /streams
POST   /streams
PUT    /streams
GET    /streams/{id}
PUT    /streams/{id}
DELETE /streams/{id[,id]}
```

创建转发时 `user_package` 固定为所属客户套餐冻结的上游套餐 ID，`uid` 等归属字段会被移除。请求中的 `groups` 是当前客户的站内分组 ID；它只写入 PostgreSQL，转发到 CDNFly 前会替换为该客户在目标上游账号中的隐藏转发分组。监听端口会登记到本地归属表，四层监控只能查询这些端口。

四层写入只转发 `des`、服务端生成的隐藏 `groups`、`listen`、`backend_port`、`backend`、`balance_way`、`enable` 和服务端设置的 `user_package`。协议限制为 TCP/UDP，负载方式限制为轮询或源 IP 哈希；监听端口不能重复，源站权重和状态会标准化。客户可在新建和详情页选择站内四层分组。

健康探针使用账号级 Redis 缓存合并请求，管理员手动点击检测时才强制实时探测。最近状态正常的账号发生前两次瞬时探测失败时沿用最近正常状态并显示波动说明，连续第三次失败才标记连接异常。

网站分组同样只保存在站内。网站资源根据套餐冻结的上游账号自动归入该客户的隐藏网站分组，不会把客户自定义分组同步到上游。

## 网站监控

| 方法 | 路径 | 隔离方式 |
| --- | --- | --- |
| GET | `/monitor/site/access-log` | 必须指定本地 `site_id`、`host` 或 `domain` |
| GET | `/monitor/site/access-log/{documentId}` | 仅允许读取当前租户受限列表中出现过的文档 |
| GET | `/monitor/site/attack-log` | 必须指定当前租户网站范围 |
| GET | `/monitor/site/attack-log/stats` | 先校验域名，再查询聚合 |
| GET | `/monitor/site/attack-log/{documentId}` | 仅允许读取当前租户受限列表中出现过的文档 |
| GET | `/monitor/site/blackip` | `site_id` 为本地网站 ID |
| GET | `/monitor/site/blackip-count` | 按上游网站 ID 过滤后转换为本地 ID |
| GET | `/monitor/site/download-access-log/{jobId}` | `jobId` 为当前租户本地任务 ID |
| GET | `/monitor/site/history-blackip` | `site_id` 为本地网站 ID |
| GET | `/monitor/site/realtime` | 必须指定当前租户网站范围 |
| GET | `/monitor/site/top` | 必须指定当前租户网站范围 |

访问日志、攻击日志和黑名单导出的 `action=export` 只在网站范围校验完成后转发。未指定范围且当前租户有多个域名时返回 HTTP 400，不会查询共享上游账号的全量数据。

日志详情采用“先列出、后读取”授权：列表结果中的 Elasticsearch 文档 ID 按上游账号登记，并替换为本地文档 ID；详情请求再还原并路由到原上游，其他 ID 返回 404。

## 四层监控

```text
GET /monitor/stream/realtime
GET /monitor/stream/top
```

`realtime` 的 `port` 只能包含当前租户已登记的监听端口；不传时自动使用当前租户全部端口。`top` 的上游聚合结果会按当前租户端口再次过滤，并修正结果数量。

## 用量统计

```text
GET /monitor/usage
GET /monitor/usage-count
```

`/monitor/usage` 必须指定 `cate=site` 或 `cate=stream`。`res` 使用本地网站/转发 ID；省略时自动使用当前租户该分类下的全部资源。

上游 `/monitor/usage-count` 没有资源范围参数，不能直接用于共享账号。兼容层会分别按当前租户网站和四层转发调用受限的 `/monitor/usage`，然后在本地计算最大带宽、总流量、总请求数和黑名单用量。

## 节点流量

```text
GET /node-traffic
```

节点总流量包含共享节点上其他网站的数据，无法证明属于单一客户账号，因此兼容层固定返回 HTTP 403。这是有意的隔离边界，不会降级为不安全的上游透传。

## 日志

```text
GET /log/login
GET /log/op
```

上游日志只识别共享的普通用户账号，无法区分本地客户。兼容层返回本平台按当前客户账号记录的登录与操作审计日志，不转发上游日志，且不包含证书私钥、DNS 授权或请求正文。

## 任务

```text
GET  /jobs
POST /jobs
```

支持 CDNFly v6 文档中的：

```text
clean_url clean_dir pre_cache_url
unlock_ip clear_white_ip down_http_access_log
```

- 缓存刷新与预热任务的 URL 主机必须属于当前租户网站。
- 解封和清白名单任务必须使用当前租户本地网站 ID。
- 下载访问日志必须指定当前租户域名。
- 返回的任务 ID 为本地 ID；任务列表只保留当前租户映射任务。
- `type=backup` 会取消 CDNFly 上游用户范围限制，因此兼容层固定返回 HTTP 403。
- CDNFly 文档未提供可确认的 `cancel_task` 任务 ID 请求字段，成品界面不展示该入口；兼容 API 明确返回 HTTP 501，不会把 URL 错当作任务 ID。
