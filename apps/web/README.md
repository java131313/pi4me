# pi-web

pi 的纯对话网页版：Cloudflare Worker 提供静态聊天 UI 和 `/api/*`，PostgreSQL 存 API Key、对话和响应。没有 coding 工具（Workers 上没有文件系统，跑不了 pi 的 bash/edit）。

## 结构

- `src/worker.ts` — 路由、口令鉴权、`/api/chat`（SSE 流式，落库两条消息）
- `src/db.ts` — pg 访问；三张表在首次请求时自动创建
- `src/llm.ts` — Anthropic / OpenAI 兼容 / Google / Kimi 的 SSE 流。pi-ai 面向 Node，Worker 内直接用 fetch；Kimi For Coding 的端点已内置，只需填 key
- `public/index.html` — 聊天 UI（无构建步骤）

## PG 表

- `api_keys(id, provider, label, api_key, base_url, created_at)` — 每个 provider 最新一条生效；`base_url` 只用于 OpenAI 兼容端点（如 DeepSeek）
- `conversations(id, title, provider, model, created_at, updated_at)`
- `messages(id, conversation_id → cascade, role, content, model, tokens_in, tokens_out, created_at)` — 用户消息和助手响应都在这

## 本地开发

```sh
npm install --ignore-scripts   # 仓库根目录，首次
cd apps/web
# .dev.vars 里已有 DATABASE_URL / PI_WEB_TOKEN
npm run dev                    # = wrangler dev
```

浏览器打开 http://localhost:8787 ，口令 `dev-token-123`（`.dev.vars` 里的 `PI_WEB_TOKEN`）。

## 部署到 Cloudflare

```sh
cd apps/web
npx wrangler login             # 一次性
npx wrangler secret put DATABASE_URL     # 粘贴 postgres 连接串
npx wrangler secret put PI_WEB_TOKEN     # 访问口令
npm run deploy                 # = wrangler deploy
```

Worker 通过 `nodejs_compat` 用 node-postgres 直连 Render PG（TCP+TLS）。数据库在新加坡，访问口令是唯一访问控制，用强随机值。

## Kimi 中继

`api.kimi.com` 的 WAF 拦截 Cloudflare Workers 出口 IP，所以 Kimi 请求线上必须走 [apps/relay](../relay/) 的中继服务。中继部署好后：

```sh
npx wrangler secret put KIMI_RELAY_URL    # https://<service>.onrender.com
npx wrangler secret put KIMI_RELAY_TOKEN  # 与中继的 RELAY_TOKEN 相同
npx wrangler deploy
```

不设这两个变量时 Kimi 直连（本地开发可用；线上会 403）。
