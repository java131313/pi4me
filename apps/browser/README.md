# pi-web-browser

远程无头浏览器流式服务：pi-web 网页通过 WebSocket 收画面（CDP screencast JPEG 帧）、回注鼠标键盘，实现在网页里"开浏览器"。Docker 镜像部署（Debian + Chromium + CJK 字体 + Node 服务）。

## 协议

- `GET /healthz` — 健康检查（无需密钥）
- `WS /ws?token=<BROWSER_TOKEN>` — 单个客户端独占：
  - 下行：二进制 = JPEG 帧；文本 JSON = 状态（`ready`/`navigated`/`error`）
  - 上行 JSON：`{type:"navigate",url}` `{type:"click",x,y,button,clickCount}` `{type:"move",x,y}` `{type:"wheel",deltaX,deltaY}` `{type:"key",key}`（playwright 键名/组合如 `Control+a`）`{type:"text",text}` `{type:"resize",width,height}`

限制：单人单客户端；中文输入靠外部写好粘贴（Ctrl/Cmd+V 走 `key` 组合）；浏览器在断开后保留，重启容器才清空。

## 本地跑（Mac 用本机 Chrome 代替 Chromium）

```sh
BROWSER_TOKEN=test PORT=8789 CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node server.js
```

## 部署到 Render

Docker runtime，仓库根目录填 `apps/browser`（自动用其中的 Dockerfile）：

1. Render Dashboard → New → Web Service → `java131313/pi4me`，Root Directory `apps/relay` 同款操作填 `apps/browser`
2. Runtime 选 **Docker**（默认会用 ./Dockerfile），Plan 建议 **Starter 2GB**（免费档 512MB 跑 Chromium 容易 OOM）
3. 环境变量 `BROWSER_TOKEN` = 与 Worker 端一致的值
4. 创建后得到 `https://<name>.onrender.com`，Worker 侧：

```sh
cd apps/web
npx wrangler secret put BROWSER_WS_URL   # wss://<name>.onrender.com
npx wrangler secret put BROWSER_TOKEN    # 与上面相同
npx wrangler deploy
```

不设这两个 secret 时 pi-web 侧自动隐藏"浏览器"按钮。免费档 15 分钟无连接会休眠，浏览器状态丢失；Starter 不休眠。
