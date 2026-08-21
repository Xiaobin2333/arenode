# Arenode 文档中心

本目录保存 Arenode 的正式技术文档。项目介绍、快速搭建和基础配置请先阅读根目录 [README](../README.md)。

## 架构与边界

- [架构与实现说明](./ARCHITECTURE.md)：系统组件、数据职责、租户隔离、商业能力与实现约束。
- [CDNFly v6 功能能力矩阵](./API_CAPABILITY_MATRIX.md)：已实现能力、平台本地能力及明确不支持的账号级功能。

## 接口说明

- [网站与安全 API](./API_COMPATIBILITY.md)：网站、分组、证书、DNS API、ACL、CC、WAF 与兼容鉴权。
- [转发与数据 API](./DATA_COMPATIBILITY.md)：四层转发、监控、排行、日志、用量和任务。
- [套餐与交易 API](./BILLING_COMPATIBILITY.md)：套餐、余额、订单、续费、退款、增值项与流量包。
- [用户与管理员系统](./ACCOUNT_ADMIN.md)：注册、登录、MFA、客户管理、审计与管理员权限。

## 部署与验收

- [生产部署验收清单](./DEPLOYMENT_CHECKLIST.md)：配置、密钥、注册安全、租户隔离、计费、备份、恢复和发布检查。
- [安全策略](../SECURITY.md)：漏洞报告方式和生产部署安全要求。
- [贡献指南](../CONTRIBUTING.md)：开发环境、代码要求与 Pull Request 约定。

## 文档约定

- “客户”或“租户”指 Arenode 本地普通用户，不代表 CDNFly 上游账号。
- “上游”指管理员配置的 CDNFly v6 普通用户 API 账号。
- 客户界面中的资源 ID 均为 Arenode 本地 ID；文档明确标注时才表示上游 ID。
- 客户可见的网站和转发分组仅保存在 PostgreSQL，上游只维护每客户的隐藏隔离分组。

接口或行为变更应在同一个 Pull Request 中同步更新对应文档和测试。
