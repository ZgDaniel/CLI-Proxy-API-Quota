# CPA Quota

`CLIProxyAPI` / `CPA-backend` 的配额与使用量只读仪表盘。

## 功能

- 通过 CPA 地址 + 管理密钥连接后端，获取配额与使用数据
- 按供应商（Claude / Codex / Gemini CLI / Kimi / Antigravity）分组展示账号
- 单页面查看配额进度条、使用量统计、模型调用详情
- 服务端缓存配额与使用数据，减少刷新压力
- 公开页面（`/`）展示最近一次快照，管理面板（`/admin`）支持登录与强制刷新
- 多渠道告警通知：配额低于阈值时自动推送，支持飞书机器人、Telegram Bot、Qmsg 酱（QQ）、通用 Webhook

## 告警通知

管理面板支持配置配额告警，当账号剩余配额低于设定阈值时自动推送通知。支持以下渠道：

| 渠道 | 配置项 | 获取方式 |
|---|---|---|
| 飞书机器人 | Webhook Token（支持粘贴完整 URL） | 飞书群设置 → 自定义机器人 |
| Telegram Bot | Bot Token + Chat ID | @BotFather 创建 Bot；@userinfobot 获取 Chat ID |
| Qmsg 酱 | Qmsg Key | qmsg.zendee.cn 登录后获取 |
| 通用 Webhook | Webhook URL | 任意支持 POST JSON 的端点 |

支持多级阈值（最多 5 级），可配置刷新间隔（1 分钟 ~ 5 小时）。每个阈值仅在对应的配额重置周期内触发一次告警，避免重复通知。

## 环境变量

复制 `.env.example` 到部署环境并按需修改：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 服务端口 | `4179` |
| `SESSION_SECRET` | 会话 Cookie 签名密钥 | - |
| `USAGE_TTL_SECONDS` | 使用量缓存 TTL | `30` |
| `QUOTA_TTL_SECONDS` | 配额缓存 TTL | `300` |

## 开发

```bash
npm install
SESSION_SECRET=dev-secret npm run dev
```

- 前端：`http://localhost:4178`
- 后端：`http://localhost:4179`

## 生产部署

```bash
npm install
npm run build
SESSION_SECRET=prod-secret NODE_ENV=production npm start
```

部署配置见 `deploy/` 目录下的 systemd 服务文件和 nginx 反向代理配置。

## 项目结构

```
src/
├── client/          # React SPA（Vite + React 19）
│   ├── App.tsx      # 主组件，管理 /admin 和 / 两种路由
│   └── index.css    # 全局样式
├── server/          # Express 5 API（Node, ESM）
│   ├── index.ts     # 路由与会话中间件
│   ├── session.ts   # 内存会话存储，HMAC 签名 Cookie
│   ├── cpaClient.ts # CPA 管理 API 客户端
│   ├── overview.ts  # 核心数据管线：获取 → 解析 → 聚合 → 缓存
│   └── config.ts    # 环境变量读取
└── shared/
    └── types.ts     # 前后端共享的 TypeScript 类型定义
```

## License

Private — All rights reserved.
