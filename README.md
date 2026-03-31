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
| `SCHEDULER_CPA_BASE_URL` | 调度器 CPA 后端地址（可选，不设则登录后自动持久化） | - |
| `SCHEDULER_CPA_MANAGEMENT_KEY` | 调度器 CPA 管理密钥（可选，不设则登录后自动持久化） | - |

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

## Agent 必读

- **公共页面自动刷新**依赖后台调度器，调度器凭据通过以下优先级获取：环境变量 `SCHEDULER_CPA_BASE_URL` + `SCHEDULER_CPA_MANAGEMENT_KEY` > 持久化文件 `.data/scheduler-credentials.json` > 内存 session。首次部署后访问 `/admin` 登录一次即可自动持久化凭据，之后服务重启也不影响公共页面刷新。
- **调度器启动时立即刷新一次**，不等第一个间隔周期，确保公共页面在服务重启后尽快有数据。
- **告警配置（阈值、渠道、刷新间隔）存储在内存中**，服务重启后重置为默认值（刷新间隔 300 秒）。如需持久化需后续扩展。
- **残留进程会导致端口冲突**：部署或重启时确保旧进程已完全退出（`ps aux | grep dist/server/server/index`），否则新进程无法正常绑定端口。
- **`.data/`** 目录存放调度器持久化凭据，已在 `.gitignore` 中排除，不应提交到仓库。
- **前端公共页面状态机**：`loadPublicOverview()` 即使请求失败（如 404）也会进入 `'public'` 状态，确保轮询定时器正常启动，后续请求成功后数据会自动填充。
- **`tick()` 中 `buildOverview()` 失败会打印日志**（`[scheduler] buildOverview failed: ...`），不会静默吞掉错误。排查公共页面不刷新时，先查 `journalctl -u cpa-quota.service` 中是否有该日志。
- **`Restart=always`**：systemd 配置为无条件重启，进程正常退出也会被拉起。如不希望此行为，改为 `Restart=on-failure`。

## License

Private — All rights reserved.
