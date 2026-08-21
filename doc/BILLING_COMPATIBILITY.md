# 套餐与交易 API 兼容层

套餐与交易状态全部保存在本分销系统，不调用 CDNFly 上游的套餐、余额、订单或支付接口。接口使用平台登录 Cookie 鉴权，客户只能读取和操作自己的订阅、增值项、流量包与订单。

## 资源口径

仅执行三项套餐限制：

| 资源 | 统计方式 |
| --- | --- |
| 加速域名数 | 当前套餐实例所绑定网站的域名数量 |
| 月流量 | 当前自然月内，仅按该套餐实例所绑定网站和四层转发的上游 ID 查询 |
| HTTP / 转发端口 | 同一套餐实例内，网站非标准 HTTP/HTTPS 监听端口与四层转发监听端口共用一个额度；标准端口 `80/443` 不计入 |

`NULL` 表示不限。带宽峰值和连接数不限制。一个客户可以持有多个同时生效的套餐实例，网站与四层转发必须绑定其中一个实例，各实例独立统计额度。某个实例超出任一有限额度后，系统只暂停绑定到该实例且正在运行的网站和四层转发；升级、购买增值项/流量包或进入新流量周期后，也只恢复由该实例配额机制暂停的资源。

## 默认套餐

| 套餐 | 价格 | 域名 | 月流量 | HTTP / 转发端口 |
| --- | ---: | ---: | ---: | ---: |
| 试用版 | ¥3 | 1 | 10 GiB | 0 |
| 体验版 | ¥5 | 3 | 30 GiB | 0 |
| 普惠版 | ¥28 | 8 | 100 GiB | 3 |
| 基础版 | ¥48 | 15 | 512 GiB | 8 |
| 高级版 | ¥68 | 30 | 1024 GiB | 15 |
| 终极版 | ¥98 | 不限 | 不限 | 不限 |

新注册或由管理员创建的客户初始余额为零，不自动获得任何套餐。客户可通过充值码增加余额，管理员也可直接调整余额或手动分配套餐；分配新套餐不会取消已有的有效套餐。

## 租户兼容接口

基地址为 `/api/cdnfly/v1`，成功响应为 `{ "code": 0, "data": ... }`。

```text
GET    /package-groups
GET    /package-groups/{id}
GET    /packages
GET    /packages/{id}
GET    /package-ups
GET    /package-ups/{id}

GET    /user-packages
POST   /user-packages
PUT    /user-packages                  # 自动续费或套餐升降配
GET    /user-packages/{id}             # 支持 to_package 报价
PUT    /user-packages/{id}             # 自动续费或套餐升降配
DELETE /user-packages/{id}
GET    /user-package/{id}/usage

GET    /user-package/{id}/upgrades
POST   /user-package/{id}/upgrades
PUT    /user-package/{id}/upgrades
GET    /user-package/{id}/upgrades/{upgradeId}
DELETE /user-package/{id}/upgrades/{upgradeId}

GET    /traffic-packages
GET    /traffic-packages/{id}
GET    /user-traffic-packages
POST   /user-traffic-packages
PUT    /user-traffic-packages
GET    /user-traffic-packages/{id}
PUT    /user-traffic-packages/{id}
DELETE /user-traffic-packages/{id}
GET    /user-traffic-package-usage

GET    /orders
GET    /orders/{id}
GET    /order-count
POST   /alipay-preorder
POST   /wxpay-preorder
```

套餐升降配按剩余有效天数和两个套餐的每日价格折算差额。只允许切换到启用且上游账号、上游套餐映射均相同的目标套餐；升级从余额扣款，降级退回余额，订阅到期时间保持不变。钱包流水、订单和订阅更新在同一数据库事务中完成，重复提交已生效的目标套餐不会再次扣款，变更后立即执行额度暂停或恢复。

购买套餐、增值项和流量包均使用账户余额，在数据库事务中完成余额扣减、不可变流水、订单支付和权益发放，成功后立即生效，无需管理员确认。余额不足时整个事务回滚，不创建订单或订阅。增值项与流量包必须指定当前客户自己的套餐实例。支付宝/微信预下单在未配置可验证支付渠道时返回 HTTP 501，不创建伪订单。已购流量包和已生效增值权益不能由客户直接改量或删除，增加权益必须再次购买。

所有详情接口都同时按资源 ID 和当前客户 ID 查询。其他客户的 ID 返回 HTTP 404，不会泄露该资源是否存在。

## 管理员接口

基地址为 `/api/admin/billing`：

```text
GET,POST       /plans
PUT,DELETE     /plans/{id}
GET,POST       /groups
PUT,DELETE     /groups/{id}
GET,POST       /upgrades
PUT,DELETE     /upgrades/{id}
GET,POST       /traffic-packages
PUT,DELETE     /traffic-packages/{id}
GET,POST       /subscriptions
PUT,DELETE     /subscriptions/{id}
GET            /orders
GET            /usage
POST           /enforce
```

目录删除采用停用方式，保留历史订单、订阅和已购权益。`PUT /orders/{id}` 明确返回 HTTP 405，因为余额订单已经即时支付，不存在确认步骤。套餐只能分配给 `role=user` 的客户，不能分配给平台管理员。仍绑定网站或转发的套餐实例不能取消或设为到期，必须先把资源迁移到该客户的其他有效套餐。

套餐分组是管理员维护的全局销售目录；网站分组和四层转发分组不是套餐分组，它们分别使用本地资源 ID 和 `owner_id` 按客户隔离，跨客户读取、修改或关联均返回 404。

## 自动执行

服务启动后立即执行一次不含流量同步的额度检查，此后每五分钟同步租户范围内的月流量并执行额度。管理员也可以调用 `POST /api/admin/billing/enforce` 手动触发。某个租户或某个资源调用上游失败时会记录失败并在下次调度重试，不会放宽其他租户的隔离边界。

套餐、增值项和流量包还可以通过本地兑换码直接发放，接口与安全规则见 [ACCOUNT_ADMIN.md](./ACCOUNT_ADMIN.md)。兑换会生成 `channel=redemption` 的零元已支付订单，便于管理员统一追踪交易来源。
