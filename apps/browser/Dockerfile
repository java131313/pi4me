FROM node:22-bookworm-slim

# Chromium + CJK fonts (Chinese pages render tofu without them).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
	CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY server.js ./

EXPOSE 3300
CMD ["node", "server.js"]
