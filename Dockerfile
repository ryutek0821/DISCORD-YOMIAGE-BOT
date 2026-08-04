# --- builder: native モジュール (@discordjs/opus, sodium-native) をビルド ---
FROM node:22-slim AS builder

WORKDIR /app

# native ビルドに必要なツール
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

# --- runtime: ビルド済み node_modules とアプリ本体のみ ---
FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# builder からビルド済み依存をコピー
COPY --from=builder /app/node_modules ./node_modules

# アプリ本体・効果音 (data/ はボリュームで供給するためコピーしない)
COPY package.json ./
COPY src ./src
COPY sound.wav sound_quiet.wav ./

CMD ["node", "src/index.js"]
