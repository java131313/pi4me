# pi-web-kimi-relay

最小转发服务：pi-web Worker → 本服务 → `https://api.kimi.com`。因为 `api.kimi.com` 的 Cloudflare WAF 拦截 Cloudflare Workers 出口 IP，线上 Kimi 调用必须绕这一跳。

- 零依赖 Node（`server.mjs`，约 80 行），流式 SSE 原样透传
- 访问控制：共享密钥头 `x-relay-key`（环境变量 `RELAY_TOKEN`），Timing-safe 比较
- 路径白名单：只转发 `/coding/*`，不是开放代理
- Kimi 的 `Authorization` 头原样透传，中继不存储 key
- `GET /healthz` 健康检查（无需密钥）

## 本地跑

```sh
RELAY_TOKEN=dev-relay-123 PORT=8788 node server.mjs
```

## 部署到 Render（Web Service）

1. Render Dashboard → **New → Web Service**，连接 `java131313/pi4me` 仓库
2. **Root Directory** 填 `apps/relay`，Runtime 选 **Node**，Plan 选 **Free**
3. Build Command 留空（无需构建），Start Command 填 `node server.mjs`（package.json 的 start 也是这个，留空即可）
4. 环境变量：`RELAY_TOKEN` = 与 Worker 端 `KIMI_RELAY_TOKEN` 相同的值
5. 创建后拿到 `https://<service-name>.onrender.com`

部署后 Worker 侧配置（见 apps/web/README.md）：

```sh
cd apps/web
npx wrangler secret put KIMI_RELAY_URL    # https://<service-name>.onrender.com
npx wrangler secret put KIMI_RELAY_TOKEN  # 与 Render 的 RELAY_TOKEN 相同
npx wrangler deploy
```

## 免费档说明

Render 免费实例 15 分钟无请求会休眠，冷启动约 30–50 秒（首次聊天会等一会儿）。可用外部心跳（如 UptimeRobot 每 5 分钟请求 `/healthz`）保持在线，或升级付费档。
