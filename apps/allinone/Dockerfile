FROM node:22-bookworm-slim

# Chromium + CJK fonts for the remote browser service.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
	CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app
COPY apps/allinone/package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY apps/allinone/entry.ts ./
COPY apps/browser/server.js ./browser-service.js
COPY apps/web/src ./web-src
COPY apps/web/public ./public

EXPOSE 3000
CMD ["node", "--experimental-strip-types", "entry.ts"]
