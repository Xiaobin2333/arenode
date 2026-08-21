# 用户与管理员系统

## 自助注册与登录

公开接口：

```text
GET  /api/auth/config
POST /api/auth/register
POST /api/auth/register/verify
POST /api/auth/password/forgot
POST /api/auth/password/reset
POST /api/auth/login
POST /api/auth/logout
```

管理员可在“运行参数”独立控制“允许新用户注册”和“注册时验证邮箱”。关闭注册总开关时入口隐藏且接口返回 403；开启注册但关闭邮箱验证时，`POST /api/auth/register` 直接创建账号；开启邮箱验证时，该接口发送验证码，并由 `/api/auth/register/verify` 完成创建。注册用户名遵循 3-32 位小写字母、数字、点、下划线或连字符规则，密码长度为 10-200 个字符。新客户初始余额为零且不自动获得套餐。

Turnstile 也是独立开关：关闭时不要求挑战；开启后登录、注册以及找回密码的验证码发送请求必须先通过挑战。验证码发送成功前按邮箱和来源 IP 取得冷却锁，并执行小时级上限；发送失败会释放冷却锁。找回密码始终需要邮箱验证码确认身份。登录会话使用 `HttpOnly + SameSite=Strict` Cookie，HTTPS 部署时增加 `Secure`。

## 修改密码

```text
PUT /api/account/password
```

请求需要 `currentPassword` 和 `newPassword`。修改成功后删除该账号全部登录会话，用户必须使用新密码重新登录。管理员重置客户密码也会使该客户全部会话失效。

## 客户管理

管理员接口：

```text
GET,POST   /api/admin/customers
GET,PUT    /api/admin/customers/{id}
DELETE     /api/admin/customers/{id}
PUT        /api/admin/customers/{id}/password
```

客户列表包含当前套餐、网站数、订单数和账号状态，不返回密码摘要、会话或上游 ID。删除客户采用禁用账号方式，保留其网站、交易和审计数据。

旧版 `/api/admin/users` 路由继续保留以兼容已有调用。

## 全租户站点管理

```text
GET,POST       /api/admin/sites
GET,PUT,DELETE /api/admin/sites/{id}
```

管理员可以按客户、域名或源站查询站点，为指定客户创建站点，以及启停和删除站点。管理员代客户创建或启用站点时仍使用该客户的套餐额度，不存在管理员额度旁路。

跨客户能力只存在于独立的 `/api/admin/sites` 路由。普通 `/api/sites` 和 `/api/cdnfly/v1/*` 继续按当前客户所有权查询，管理员通过普通站点接口访问客户站点仍返回 404。

## 兑换码

租户接口：

```text
POST /api/billing/redeem
GET  /api/billing/redemptions
```

管理员接口：

```text
GET,POST   /api/admin/billing/redemption-codes
PUT,DELETE /api/admin/billing/redemption-codes/{id}
GET        /api/admin/billing/redemption-codes/{id}/uses
```

兑换码可以发放套餐、套餐增值项或流量包。管理员可以设置批量数量、每码可用次数、权益数量、标签和有效期。

- 完整兑换码使用约 80 位随机熵生成，只在创建响应中返回一次。
- 数据库只保存规范化兑换码的 SHA-256 摘要和末四位，后台列表无法恢复完整码。
- 同一客户不能重复使用同一兑换码。
- 核销、权益发放、使用次数和零元已支付订单在同一数据库事务中提交。
- 套餐兑换会新增一个独立套餐实例，不替换已有套餐；增值项和流量包要求客户已有生效套餐，并应用到所选实例。
- 兑换记录只返回当前登录租户的数据。

## 余额与充值码

客户接口：

```text
GET  /api/billing/wallet
POST /api/billing/recharge-code
```

管理员接口：

```text
GET  /api/admin/billing/wallets
POST /api/admin/billing/wallets/{userId}/adjust
GET,POST /api/admin/billing/recharge-codes
GET       /api/admin/billing/recharge-codes/{id}/uses
DELETE    /api/admin/billing/recharge-codes/{id}
```

金额统一使用整数分。余额流水只追加不改写；充值码只保存摘要和末四位，完整码仅在创建响应中返回一次。充值码核销、余额增加和流水写入在同一事务完成，同一客户不能重复使用同一码。

## 管理边界

- 平台管理员可以管理客户、套餐、兑换码和客户站点，但不能使用普通租户接口绕过所有权。
- 网站分组、四层转发分组、安全资源、日志、任务和交易记录仍按客户隔离。
- 禁用客户会注销其登录会话；客户 CDN 服务是否停用由管理员站点操作和套餐额度状态分别控制。
