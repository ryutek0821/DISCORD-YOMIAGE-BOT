# YOMIAGE-BOT

VOICEVOX Engine を使った Discord 読み上げ Bot。指定したテキストチャンネルの発言を
ボイスチャンネルで読み上げる。

## 機能

- `/join` `/leave` … ボイスチャンネルへの参加・退出（参加時のチャンネルを読み上げ対象に設定）
- 対象チャンネルの発言を順次読み上げ（再生キュー方式）
- `/voice` … 自分の話者・速度・声の高さ・抑揚・Fishの感情を設定（全サーバー共通）
- `/speakers` … 利用可能な話者(スタイル)ID の一覧
- `/dict replace|word` … ローカル置換辞書・VOICEVOXユーザー辞書の管理
- `/config` … 対象チャンネル、VC入退室通知、発言者名、最大文字数の設定
- `/ignore` … ユーザー・プレフィックス・Bot発言・自分の読み上げ除外
- URL / コードブロック / 絵文字 / メンションの整形、長文カット
- ボイスチャンネルに人がいなくなったら自動退出

## 必要なもの

- Node.js 22.12 以上
- Docker（VOICEVOX Engine 起動用）
- Discord Bot（Developer Portal で作成）

## セットアップ

1. Discord Developer Portal で Bot を作成
   - `DISCORD_TOKEN` と Application ID（`CLIENT_ID`）を取得
   - **Privileged Gateway Intents の "Message Content Intent" を ON**
   - OAuth2 で `bot` + `applications.commands` スコープ、`Connect` / `Speak` 権限を付与して招待

2. 環境変数を設定

   ```sh
   cp .env.example .env
   # .env を編集して DISCORD_TOKEN / CLIENT_ID を入力
   ```

ここから先は **(A) 通常運用** と **(B) ローカル開発** のどちらかを選ぶ。
**A と B を同時に実行しないこと** — 同一トークンの Bot プロセスが2つ動くと同じ発言が
2回読み上げられ、VC 接続も奪い合いになる。

### (A) 通常運用（Docker、推奨）

Bot も VOICEVOX Engine もコンテナで常駐させる。`npm install` / `npm start` は不要。

```sh
docker compose up -d                          # Engine + Bot をまとめて起動
curl http://localhost:50021/version           # Engine の疎通確認
docker compose run --rm bot npm run deploy    # スラッシュコマンドを登録（初回 or コマンド変更時）
```

```sh
docker compose logs -f bot        # ログ確認
docker compose restart bot        # Bot だけ再起動
docker compose up -d --build bot  # コード変更を反映（再ビルド）
```

### (B) ローカル開発（コンテナを使わず直接実行）

Bot はホストで直接動かし、VOICEVOX Engine だけコンテナにする。要 Node.js 22.12 以上。

```sh
docker compose up -d voicevox_engine   # Engine だけ起動
npm install                            # 依存をインストール
npm run deploy                         # スラッシュコマンドを登録
npm start                              # Bot を起動
```

### コマンド登録の scope

`npm run deploy`（Docker なら `docker compose run --rm bot npm run deploy`）は
`.env` の `GUILD_IDS`（カンマ区切りで複数指定可）が設定されていればそのサーバーへ
即時登録、空ならグローバル登録（反映に最大1時間程度）になる。

**scope を切り替えても反対側の古い登録は自動では消えない**（例: グローバルで
運用してから `GUILD_IDS` を設定すると、グローバルとギルドの両方にコマンドが
残って二重に見える）。掃除するには `--cleanup` を付ける。

```sh
npm run deploy -- --cleanup --dry-run   # まず対象を確認
npm run deploy -- --cleanup             # 実際に掃除する
```

## 使い方

ボイスチャンネルに入った状態で `/join` を実行すると、コマンドを打ったテキスト
チャンネルの発言を読み上げる。`/voice` で自分の声、`/config` でサーバーの
読み上げ挙動、`/ignore` で除外条件を変更できる（話者IDは `/speakers` で確認）。

## データ

`data/` 配下のJSONにサーバー設定、個人設定、辞書、除外設定を永続化する
（各ファイルは初回更新時に自動生成）。
