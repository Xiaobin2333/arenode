# 网站与安全 API 兼容层

兼容层基地址为 `/api/cdnfly/v1`。登录后可以使用平台登录 Cookie、官方客户端使用的 `access-token` 请求头，或本站签发的 `Authorization: Bearer epk_...` API Key 鉴权。兼容层不接收也不暴露共享 CDNFly 上游账号的 `api-key`、`api-secret` 或登录凭据。

成功的 JSON 响应统一为：

```json
{
  "code": 0,
  "data": {}
}
```

业务或权限错误使用对应的 HTTP 4xx/5xx 状态，并返回 `{ "error": "..." }`。CDNFly 即使以 HTTP 200 返回业务错误，兼容层也会识别并转换为失败响应。

## 公开账户接口

无需登录的官方 v6 路径按本站账户体系实现：

| 方法 | 路径 | 实现 |
| --- | --- | --- |
| POST | `/login` | 使用 `account`、`password` 登录，返回 `access_token`；沿用维护模式、失败锁定、Turnstile 和 MFA 策略 |
| POST | `/email-captcha` | `account` 用于找回密码；直接传 `email` 时必须明确提供 `check_exist=0`（注册）或 `1`（找回） |
| POST | `/user` | 使用 `username`、`email`、`password`、`captcha` 和 `accept_agreement=1` 注册；不会默认分配套餐 |
| POST | `/reset-pass` | 支持 `reset_by=email`，成功后使旧会话全部失效 |
| POST | `/phone-captcha` | 返回 `501`，本站没有可验证的短信通道 |

注册验证码只有在自助注册和注册邮箱验证都开启时才发送。启用 Turnstile 后必须先完成人机验证；所有邮件用途共享邮箱与 IP 冷却、小时限流。允许邮箱域、邀请码、协议确认和注册开关仍由管理员运行参数控制。

公开读取接口完整兼容：

```text
GET /common-register-info
GET /common-sysinfo
GET /common-captcha
GET /common-captcha-type
GET /user-login-policy
```

本站不模拟 CDNFly 图片验证码；`common-captcha` 和 `common-captcha-type` 返回 `type=none`，人机验证由管理员配置的 Cloudflare Turnstile 提供。

## 租户 ID 规则

- 网站、分组、域名、证书、DNS API、ACL、CC 和 WAF 资源 ID 都是本平台生成的本地 ID。
- 路径 ID、批量请求中的 `id` 以及网站配置中的关联 ID 会在服务端翻译成上游 ID。
- 其他租户的本地 ID 返回 404，而且不会向 CDNFly 发起请求。
- `uid`、`new_uid`、`user_package`、`internal`、`internal_self`、`owner_id` 等上游归属或管理员字段会被移除。
- 创建网站时 `user_package` 始终覆盖为所选客户套餐冻结的上游套餐 ID；同一批资源必须属于同一上游账号。
- WAF 全局/系统规则可以只读查看和编排，不能更新或删除。

## 配置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/configs` | 普通上游用户无集合查询权限，返回空集合 |
| GET | `/configs/site-{siteId}-{type}-{name}` | 查询当前租户网站配置，自动翻译网站 ID |
| GET | `/configs/global-0-system-recharge` | CDNFly 文档允许普通用户读取的脱敏公开支付配置 |
| GET | `/site-sys-config` | 获取全局网站安全时长配置 |

## 本地用户兼容能力

官方 CDNFly v6 的嵌套路径与本站历史兼容路径同时支持：

```text
GET /user/overview                  # 官方路径，返回 user_package_count、balance、domain_count、cert_count、stream_port_count 等字段
GET /user/certify                    # 官方路径，未接入第三方实名时返回 supported=false
GET /common/menu                     # 官方菜单数组
GET /common/menu2                    # 官方 sider/header 菜单对象
GET /common/package-purchase-notice  # 官方 html 字段
GET /order/count                     # 官方订单金额统计路径
```

这些官方路径由兼容层映射到下方本地实现，不会把共享 CDNFly 账号的聚合数据直接暴露给客户。`/user/overview` 的余额、域名、证书和四层端口数量均按当前本地租户重新计算。

以下接口使用平台 PostgreSQL 数据，不读取或修改共享 CDNFly 用户资料：

```text
GET    /user
PUT    /user                  # 需要当前密码；邮箱验证开启时必须使用账户中心换绑流程
GET    /user-overview                 # 历史扁平别名；等价于 /user/overview
GET    /user-configs
POST   /user-configs
PUT    /user-configs
GET    /user-configs/{id}
PUT    /user-configs/{id}
DELETE /user-configs/{id}
GET    /api-key
POST   /api-key               # 完整密钥只在创建响应中返回一次
PUT    /api-key
DELETE /api-key               # 请求体指定本地 ID
PUT    /api-key/{id}
DELETE /api-key/{id}
GET    /common-menu                   # 历史扁平别名
GET    /common-menu-2                 # 历史扁平别名
GET    /common-package-purchase-notice # 历史扁平别名
GET    /user-certify          # 返回明确的未接入状态
```

`user-configs` 使用官方 v6 字段 `name` / `value` / `type` / `scope_name` / `scope_id` / `enable`。列表接口支持 `page`、`limit=0`、`type`、`name`和 `enable` 筛选；`GET /user-configs/{id}` 按官方当前行为仍返回列表并忽略路径 ID。批量更新必须提交 JSON 数组，删除路径支持逗号分隔的多个 ID。`group` 作用域只能引用当前客户的网站分组或四层转发分组。

该能力供 CDNFly v6 兼容客户端保存创建默认值；当前用户端的网站、证书和四层转发创建表单已直接提供完整配置，因此不再额外增加一个原始配置或 JSON 编辑页面。

平台 API Key 使用 `Authorization: Bearer epk_...` 调用本兼容层，权限仍受当前客户租户隔离；不会被转发为 CDNFly `api-key` 或 `api-secret`。

公开读取接口兼容 `/common-register-info`、`/common-sysinfo`、`/common-captcha`、`/common-captcha-type` 和 `/user-login-policy`。本站的人机验证由管理员配置的 Cloudflare Turnstile 提供，因此验证码类型接口返回 `none`，不会宣告并未提供的 CDNFly 图片验证码服务。

未接入实名第三方流程的 `POST /user-certify` 返回 `501`，不会保存或上传身份证明材料。上游账号级资料、上游 API Key、共享用户消息和支付宝/微信预下单不通过兼容层暴露。

## 网站

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sites` | 当前租户网站列表 |
| POST | `/sites` | 创建一个或多个网站并固定上游套餐 |
| PUT | `/sites` | 批量更新当前租户网站 |
| GET | `/sites/{id}` | 网站完整配置 |
| PUT | `/sites/{id}` | 更新网站完整配置 |
| DELETE | `/sites/{id[,id]}` | 删除一个或多个当前租户网站 |
| GET | `/sites/{id}/waf-rules` | 网站 WAF 规则编排 |
| PUT | `/sites/{id}/waf-rules` | 保存网站 WAF 规则编排，最多 50 条 |

网站配置中的 `groups`、`https_listen.cert`、`dns_api`、`cc_default_rule`、`cc_switch.rule` 等已知关联字段使用本地资源 ID。

HTTPS 和 HTTPS 回源允许客户选择 `TLSv1`、`TLSv1.1`、`TLSv1.2`、`TLSv1.3`。新配置默认只启用 TLSv1.2/1.3；读取和保存已有配置时保留客户实际选择。

## 网站分组

完整支持：

```text
GET    /site-groups
POST   /site-groups
GET    /site-groups/{id}
PUT    /site-groups/{id}
DELETE /site-groups/{id[,id]}
```

这些接口只管理当前客户的站内分组，不创建、修改或删除 CDNFly 分组。网站写入上游时，服务端会忽略客户分组 ID，并自动归入“当前客户 + 当前上游账号”对应的隐藏网站分组。多个 Arenode 实例共用一个上游账号时，通过 `UPSTREAM_GROUP_NAMESPACE` 生成的不可逆命名空间保持隔离。

## 域名

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/cname-check` | 仅允许检查当前租户网站域名 |
| GET | `/domains` | 先按网站归属过滤，再返回本地域名 ID |
| POST | `/domains` | 使用本地域名 ID 提交 DNS 同步任务 |

网站列表与详情会优先使用上游返回的完整 CNAME。CDNFly v6 的 `cname_domain` 可能是配置 ID，不是域名后缀；当响应只有 `cname_hostname` 与该 ID 时，平台使用管理员为对应上游账户配置的 CNAME 后缀组合完整目标，并缓存到本地网站快照。`/v1/common-sysinfo` 只用于公开展示信息，不参与 CNAME 解析。

## 证书

完整支持：

```text
GET    /certs
POST   /certs
PUT    /certs
GET    /certs/{id}
GET    /certs/{id}?action=download
PUT    /certs/{id}
DELETE /certs/{id[,id]}
```

证书下载直接转发二进制归档，但下载前仍校验证书归属。证书请求中的 `dnsapi` 使用当前租户的本地 DNS API ID。

证书写入只接受 `name`、`des`、`type`、`domain`、`dnsapi`、`key` 和 `cert`。自动证书支持 `lets`、`zerossl`、`buypass`；通配符域名必须选择 DNS API。上传证书使用 `custom`，私钥和证书正文必须同时提供且 PEM 开始、结束标记完整。私钥不会回显，也不会写入本地资源快照。

## DNS API

完整支持：

```text
GET    /dnsapis
POST   /dnsapis
PUT    /dnsapis
GET    /dnsapis/{id}
PUT    /dnsapis/{id}
DELETE /dnsapis/{id[,id]}
```

集合路由 `PUT /dnsapis` 要求每一项提供本地资源 ID，且一次只能操作同一上游账号。成品 UI 仅提供已确认凭据字段且可完整验证的 `DNSPod.cn`、`CloudFlare` 和 `Aliyun`；其他服务商不会以不完整表单暴露。DNS 授权内容不会返回浏览器、写入审计日志或保存到本地资源快照；编辑已有配置时留空凭据会保留上游已保存值，更换服务商时必须重新填写完整凭据。

## CC 防护

以下三类资源均支持集合查询/创建/批量更新，以及详情查询/更新/批量删除：

```text
/cc-filters
/cc-matchs
/cc-rules
```

对应方法为：

```text
GET    /{resource}
POST   /{resource}
PUT    /{resource}
GET    /{resource}/{id}
PUT    /{resource}/{id}
DELETE /{resource}/{id[,id]}
```

CC 规则 `data` 中的 `matcher`、`filter1` 和 `filter2` 必须使用同一租户下匹配器、过滤器的本地 ID。

## ACL 访问控制

当前上游用户界面已提供“ACL 管理”，并实际调用 `/v1/acls`。该接口尚未列入当前 CDNFly v6 用户文档 sitemap，因此平台将其作为经过运行时确认的上游 UI 扩展实现：

```text
GET    /acls
POST   /acls
PUT    /acls
GET    /acls/{id}
PUT    /acls/{id}
DELETE /acls/{id[,id]}
```

ACL 使用本地资源 ID并绑定创建时选择的客户套餐。写入仅接受 `name`、`des`、`default_action`、`reject_code`、`redirect_url`、`enable` 和 `matcher`；`uid`、上游套餐和其他归属字段不会转发。

- 默认动作和规则命中动作只支持 `allow`、`reject`。
- 拒绝码只支持 `403`、`302`；使用 `302` 时必须提供 HTTP 或 HTTPS 跳转 URL。
- 匹配项、操作符和 Header 名称严格限制为当前上游界面实际提供的取值。
- 比较值按字符串数组提交；`exists`、`!exists` 可以不提供比较值，其他操作符至少需要一个值。
- 列表、详情、批量启停和删除均先校验本地归属，其他租户的 ID 不会触发上游请求。

## WAF 防护

平台会在用户登录后探测当前 CDN 服务是否提供官方 `/v1/waf-rules` 接口。上游明确返回 404 时，用户端不显示 WAF 规则库、站点 WAF 编排入口或不可操作按钮；直接调用兼容接口返回 `501`。短暂超时或连接失败不会被误判为永久不支持。

攻击日志同样按当前上游能力探测。官方攻击日志接口明确返回 404 时，用户端隐藏“拦截日志”导航和攻击日志/攻击统计选项，兼容接口返回 `501`；访问日志、实时指标、排行和用量查询不受影响。

完整支持：

```text
GET    /waf-rules
POST   /waf-rules
PUT    /waf-rules
GET    /waf-rules/{id}
PUT    /waf-rules/{id}
DELETE /waf-rules/{id[,id]}
```

列表只包含当前租户创建的规则和 CDNFly 全局规则。全局规则带 `_shared: true`，允许读取和用于网站编排，但写入与删除返回 403。

## 四层转发

四层转发使用本地资源 ID，并绑定到客户购买的具体套餐实例。客户可见的转发分组只保存在 PostgreSQL；写入 CDNFly 时由服务端替换为当前客户的隐藏上游转发分组。创建、更新和监控均按套餐冻结的上游账号路由，不会混用其他上游。

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

转发协议只接受 `tcp` 或 `udp`，负载方式只接受 `rr` 或 `ip_hash`，监听端口必须在 1-65535 内且同一条转发不能重复。上游套餐 ID 由服务端写入；客户不能通过请求覆盖 `user_package`、`uid` 或归属字段。端口额度在写入前校验。

## 监控、日志与用量

以下官方读取接口按当前客户的网站域名、网站本地 ID、四层转发本地 ID 或监听端口限定范围：

```text
GET /monitor/site/access-log
GET /monitor/site/access-log/{id}
GET /monitor/site/attack-log
GET /monitor/site/attack-log/{id}
GET /monitor/site/attack-log/stats
GET /monitor/site/blackip
GET /monitor/site/blackip-count
GET /monitor/site/history-blackip
GET /monitor/site/realtime
GET /monitor/site/top
GET /monitor/site/download-access-log/{jobId}
GET /monitor/stream/realtime
GET /monitor/stream/top
GET /monitor/usage
GET /monitor/usage-count
GET /log/login
GET /log/op
```

上游 v6 前端 bundle 虽声明过 `/monitor/stream/access-log` 方法，但当前服务路由实测返回 `404`，因此本站不将它伪装成可用的四层访问日志接口。

- 网站日志与实时数据先验证域名确属当前客户，再请求对应上游。
- 四层监控只返回当前客户已登记的端口。
- `/monitor/usage` 必须使用 `cate=site` 或 `cate=stream`；`res` 使用本地资源 ID。
- `/monitor/site/top` 只接受官方维度：`top-ip`、`top-country`、`top-province`、`top-isp`、`top-url`、`top-domain`、`top-tls-fp`、`top-referer`。
- 登录日志和操作日志来自本站审计库，不读取共享上游账号日志。
- 访问日志、攻击日志和黑名单接口不支持 `action=export`，也不提供本地 CSV 导出。

## 任务

```text
GET  /jobs
POST /jobs
```

刷新、预热和访问日志下载任务会先校验其中的网站 ID、域名或 URL 属于当前客户，再翻译为上游 ID。一次任务只能发往同一上游和同一套餐。返回给客户的任务 ID 是本地 ID，访问日志下载也必须使用该本地任务 ID。

## 套餐、用量与订单

套餐目录和订单使用本站 PostgreSQL 计费数据，购买通过本站可用余额即时支付，不需要管理员确认。购买前会验证套餐绑定的上游账号与上游套餐仍然可用。

只读目录：

```text
GET /package-groups
GET /package-groups/{id}
GET /packages
GET /packages/{id}
GET /package-ups
GET /package-ups/{id}
GET /traffic-packages
GET /traffic-packages/{id}
```

客户套餐：

```text
GET    /user-packages
POST   /user-packages                  # 余额购买
PUT    /user-packages                  # 自动续费或套餐升降配
GET    /user-packages/{id}             # 支持 ?to_package={planId} 报价
PUT    /user-packages/{id}             # 自动续费或套餐升降配
DELETE /user-packages/{id}             # 无绑定资源时取消
GET    /user-package/{id}/usage
GET    /user-package/{id}/upgrades
POST   /user-package/{id}/upgrades     # 余额购买增值项
GET    /user-package/{id}/upgrades/{upgradeId}
```

升降配请求使用 `{ "id": 用户套餐ID, "package": 目标套餐ID }`。目标套餐必须启用，并与订阅冻结的 `upstream_id`、`upstream_package_id` 完全一致。报价返回 `period`、`curr_price`、`new_price`、`orgin_new_price`、`remain_days`、`diff_price` 及对应的整数分字段；执行时保留原到期时间，余额、订单和套餐更新位于同一事务，完成后立即复检资源额度。

已生效增值权益不能由客户直接减少或删除，因此官方 `PUT /user-package/{id}/upgrades` 和 `DELETE /user-package/{id}/upgrades/{upgradeId}` 返回 `403`。

客户流量包：

```text
GET  /user-traffic-packages
POST /user-traffic-packages            # 余额购买
GET  /user-traffic-packages/{id}
GET  /user-traffic-package-usage
```

已发放流量权益不能由客户直接篡改或删除，因此集合和详情 `PUT`、详情 `DELETE` 返回 `403`。

订单：

```text
GET /orders
GET /orders/{id}
GET /order-count                     # 历史扁平别名；返回 { count, data: [{ time, sum }] }
```

订单详情与统计始终按当前客户过滤。支付宝和微信预下单接口在没有真实支付通道时返回 `501`；当前充值方式为管理员生成的充值码，后续接入支付渠道时再开放对应接口。

## 明确不提供的官方接口

| 接口 | 状态 | 原因 |
| --- | --- | --- |
| `POST /phone-captcha`、`reset_by=phone` | `501` | 没有可验证的短信发送与号码归属服务 |
| `POST /user-certify` | `501` | 没有可验证的实名第三方流程；`GET /user-certify` 只返回未接入状态 |
| `POST /alipay-preorder`、`POST /wxpay-preorder` | `501` | 尚未配置真实支付通道 |
| `GET /node-traffic` | `403` | 节点总流量无法隔离为单个客户的数据 |
| `GET /monitor/stream/access-log` | `404` | 上游 v6 前端 bundle 暴露了调用名，但当前服务路由实测不存在；不能据此伪造四层访问日志 |
| `/messages`、`/messages/{id}`、`/messages/read`、`/messages/sub` | `404` | 工单、平台消息和平台通知已按产品要求完全删除 |
| WAF 与攻击日志接口 | `501`（能力不支持时） | 登录后探测当前 CDN 服务能力；上游明确返回 404 时隐藏对应 UI |

这些接口不会返回伪成功、空白可操作页面或不可兑现的按钮。未在本文列出的 CDNFly 管理员级、节点级或无法租户隔离的接口统一返回 `404` 或相应的明确权限错误。

## 官方目录覆盖

截至当前文档版本，CDNFly v6 用户文档中的公共接口、账户资料、用户默认配置、API Key、网站、网站分组、域名、证书、DNS、CC、WAF、四层转发、网站/四层监控、用量、任务、日志、套餐目录、用户套餐、增值项、流量包和订单均已按上述规则实现。当前上游 UI 额外提供且已实测的 ACL 能力也按租户隔离规则实现。支付、短信、实名、消息和节点总流量按本节明确拒绝，不保留无接口支撑的用户入口。

上游 bundle 中还存在 `/v1/user/policy`、优惠券、共享套餐监控、共享任务/消息日志和 `/v1/forget-password` 等调用字符串。它们未同时满足租户归属、账务闭环或当前本地身份流程的完整语义，因此不会仅凭 bundle 字符串加入接口或界面；找回密码继续使用官方文档中的 `/email-captcha` 与 `/reset-pass` 本地安全流程。

## 查询参数

分页、名称和状态等普通查询参数会转发到 CDNFly。以下可能突破租户边界或改变响应类型的参数始终移除：

```text
uid user_id owner_id internal internal_self action
```

证书详情的 `action=download` 是唯一单独处理的下载操作。访问日志、攻击日志和黑名单接口不会透传 `action=export`，平台不提供 CSV 导出。
