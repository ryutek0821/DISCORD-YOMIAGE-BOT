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
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# アプリ本体・効果音 (data/ はボリュームで供給するためコピーしない)
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node sound.wav sound_quiet.wav ./

# node 公式イメージの非rootユーザー (uid 1000) で動かす。メッセージ本文を扱うプロセスと、
# そこから spawn される ffmpeg が root 権限で動かないようにするため。Linux ホストでは
# バインドマウントした data/ の所有者を uid 1000 に合わせる必要がある (CLAUDE.md 参照)。
USER node

CMD ["node", "src/index.js"]
