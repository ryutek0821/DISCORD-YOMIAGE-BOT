# YOMIAGE-BOT

VOICEVOX Engine を使った Discord 読み上げ Bot。指定したテキストチャンネルの発言を
ボイスチャンネルで読み上げる。

## 機能

- `/join` `/leave` … ボイスチャンネルへの参加・退出（参加時のチャンネルを読み上げ対象に設定）
- 対象チャンネルの発言を順次読み上げ（再生キュー方式）
- `/voice` … 自分の話者・速度・声の高さ・抑揚を設定（全サーバー共通）
- `/speakers` … 利用可能な話者(スタイル)ID の一覧
- `/dict replace|word` … ローカル置換辞書・VOICEVOXユーザー辞書の管理
- `/config` … 対象チャンネル、VC入退室通知、発言者名、最大文字数の設定
- `/ignore` … ユーザー・プレフィックス・Bot発言・自分の読み上げ除外
- URL / コードブロック / 絵文字 / メンションの整形、長文カット
- ボイスチャンネルに人がいなくなったら自動退出

## 必要なもの

- Node.js 20 以上
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

3. VOICEVOX Engine を起動

   ```sh
   docker compose up -d
   curl http://localhost:50021/version   # 疎通確認
   ```

4. 依存をインストール

   ```sh
   npm install
   ```

5. スラッシュコマンドを登録

   ```sh
   npm run deploy
   ```

   `.env` に `GUILD_ID` を設定するとそのサーバーへ即時登録（テストに便利）。
   未設定だとグローバル登録（反映に最大1時間程度）。

6. Bot を起動

   ```sh
   npm start
   ```

## 使い方

ボイスチャンネルに入った状態で `/join` を実行すると、コマンドを打ったテキスト
チャンネルの発言を読み上げる。`/voice` で自分の声、`/config` でサーバーの
読み上げ挙動、`/ignore` で除外条件を変更できる（話者IDは `/speakers` で確認）。

## データ

`data/` 配下のJSONにサーバー設定、個人設定、辞書、除外設定を永続化する
（各ファイルは初回更新時に自動生成）。
