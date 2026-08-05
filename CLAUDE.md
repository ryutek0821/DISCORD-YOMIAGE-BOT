# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# VOICEVOX Engine + Bot をまとめて起動 (推奨。Bot もコンテナで常駐)
docker compose up -d

# ログ確認 / Bot だけ再起動
docker compose logs -f bot
docker compose restart bot

# コード変更を反映 (再ビルドして起動し直す)
docker compose up -d --build bot

# スラッシュコマンドを Discord に登録 (初回 or コマンド変更時、単発実行)
docker compose run --rm bot npm run deploy

# テスト (node:test。Discord/VOICEVOX/Fish/ffmpeg には一切接続しない)
npm test
npm run test:watch
```

`npm run deploy` は `.env` の `GUILD_IDS` にギルドIDが設定されていればギルド限定(即反映)、空ならグローバル登録(最大1時間遅延)。

### ローカル開発 (コンテナを使わず直接実行する場合)

```bash
docker compose up -d voicevox_engine   # Engine だけ起動
npm start                              # ホストで Bot を起動 (要 Node.js 22.12+)
npm run deploy
```

Bot をコンテナで動かす場合、`VOICEVOX_URL` は compose 側で `http://voicevox_engine:50021` に上書きされる (`.env` の `localhost` 設定はホスト直実行用)。

## 環境変数 (.env)

| 変数 | 必須 | 説明 |
|------|------|------|
| `DISCORD_TOKEN` | 必須 | Bot トークン |
| `CLIENT_ID` | 必須 | Application ID (deploy-commands.js 用) |
| `VOICEVOX_URL` | 任意 | デフォルト `http://localhost:50021` |
| `GUILD_IDS` | 任意 | コマンド登録先ギルドID (カンマ区切り) |
| `READ_CHANNELS` | 任意 | 自動参加時の読み上げ対象ch (`guildId:channelId` カンマ区切り) |
| `FISH_API_KEY` | 任意 | Fish Audio の APIキー。未設定なら Fish は無効化され VOICEVOX のみで動く |
| `FISH_MODEL` | 任意 | デフォルト `s2.1-pro-free`。他に `s2.1-pro` / `s2-pro` / `s1` |
| `FISH_API_URL` | 任意 | デフォルト `https://api.fish.audio` |

Discord Developer Portal で **Message Content Intent** を有効にすること。

## アーキテクチャ

```
src/
├── index.js          # エントリポイント。Discord イベント処理
├── player.js         # VC 接続・音声キュー管理 (guild ごとの sessions Map)
├── tts.js            # TTSエンジンの分岐点 (VOICEVOX / Fish Audio) + Fishの日次バイト上限
├── voicevox.js       # VOICEVOX Engine HTTP クライアント (合成 + ユーザー辞書API)
├── fishAudio.js      # Fish Audio TTS API クライアント (クラウド従量課金、任意)
├── lruCache.js       # 挿入順Mapベースの簡易LRU (各エンジンが個別インスタンスを持つ)
├── textProcessor.js  # メッセージ前処理 (URL/コード/メンション/絵文字/Markdown/草の置換)
├── ignoreFilter.js   # ユーザー・個人ミュート・prefix・Bot発言の除外判定
├── userVoice.js      # 発言者ごとの話者解決ロジック
├── store.js          # JSON ファイル永続化 (data/ ディレクトリ)
├── log.js            # タイムスタンプ付きの簡易ロガー
└── commands/         # スラッシュコマンド群
    ├── index.js      # コマンドを Map にまとめる
    ├── join.js / leave.js
    ├── voice.js      # 個人の話者・速度・声の高さ(pitch)・抑揚(intonation)・Fishボイス/感情設定
    ├── speakers.js   # 利用可能話者一覧表示 (末尾にFishボイスも併記)
    ├── fishvoice.js  # Fish Audio ボイスの add/remove/list (add/removeは要ManageGuild)
    ├── config.js     # ギルド単位の読み上げ挙動設定
    ├── ignore.js     # ギルド/個人の読み上げ除外設定
    ├── replyLines.js # 2000字制限を避けるephemeral分割応答
    └── dict.js       # /dict replace (文字列置換辞書) と /dict word (VOICEVOXユーザー辞書)、
                       # ともに add/remove/list、add/remove は要ManageGuild権限
```

**データフロー**: `MessageCreate` → Bot/セッション/対象ch/除外フィルタ判定 → 効果音判定 → `textProcessor.buildSpeech()` → 発言者名の前置 → `userVoice.resolveUserVoice()` → `player.enqueue()` → `tts.synthVoice()` → エンジン分岐して `voicevox.synth()` / `fishAudio.synth()` (どちらもWAVキャッシュ有り) → ffmpeg で Opus 変換 → Discord VC 再生

**永続化**: `data/guildSettings.json`・`data/userSettings.json`・`data/dictionary.json`・`data/userDict.json`・`data/ignore.json`・`data/fishVoices.json` にその場で書き込む (DB なし)。書き込みは `.tmp` へ書いてから `rename` するアトミック方式 (直接上書きすると停止タイミング次第で JSON が壊れ、`load()` が黙って既定値に落ちて設定が消えるため)。ランタイム中はインメモリキャッシュを使う。Docker 運用時は `data/` をホストにボリュームマウント (`docker-compose.yml`) するため、コンテナを作り直しても設定は保持される。ただし `voicevox_engine` サービスにはボリュームが無いため、engine コンテナ自体を作り直すと VOICEVOX 側の user_dict は消える (→ 起動時に自動復元、後述)。

## 設計上のポイント

- **話者の優先順位**: 個人設定 (`/voice`) > `userId % 話者数` による決定論的割り当て > ギルドデフォルト (speaker=3)。速度・pitch・intonation は個人設定がなければ既定値 (1.0 / 0.0 / 1.0)。`userVoice.resolveUserVoice()` が `{ engine, speaker, fishRef, fishEmotion, speed, pitch, intonation }` を返し、`tts.synthVoice()` がエンジンを選んで合成する。**engine が `fish` でも VOICEVOX の `speaker` は必ず解決する** — Fish の日次バイト上限超過時のフォールバック先として必要なため
- **TTSエンジンの二本立て**: 既定は VOICEVOX。`/voice fish:<エイリアス|reference_id>` を明示指定したユーザーだけが Fish Audio ([fish.audio](https://fish.audio)) を使う。`/voice speaker:` と `/voice fish:` は排他 (同時指定はエラー)。**自動ランダム割り当ての対象は VOICEVOX 話者のみ**で Fish は混ぜない (課金と ID 空間が別物のため)。`speed` のレンジは両者 0.5〜2.0 で一致する。`pitch` は VOICEVOX 固有 (`audio_query` のフィールド) で Fish に対応物が無いため無視されるが、`intonation` は `fishAudio.intonationToTemperature()` で Fish の `temperature` に換算して効かせる。`synth()` の呼び出し口を `tts.synthVoice()` の1箇所に集約してあるので、エンジン追加時に `player.js` を触る必要はない
- **Fish の抑揚と感情タグ**: `/voice intonation` (0.0〜2.0) を Fish の `temperature` (0.1〜1.0) へ**折れ線**で換算する (`0→0.1` / `1→0.7` / `2→1.0`)。単純な線形換算だと既定値 1.0 が 0.55 になり、何も設定していない既存ユーザーの声が黙って平坦になるため、VOICEVOX 既定の 1.0 が Fish 既定の 0.7 に一致する形にしてある (未指定時は `temperature` フィールド自体を送らない)。`top_p` は触らない。`/voice fish_emotion` は本文頭に `[happy]` のようなタグを付けて話し方を変えるもので、**S2 系モデル限定** (`s1` に付けると literal に読まれるため `supportsEmotion()` で判定してスキップ)。タグは choices 固定 — 自由入力だとタグとして解釈されない文字列がそのまま読み上げられ、しかも課金バイトに乗る。タグの付与は `fishAudio.applyEmotion()` を `tts.js` から呼ぶ形にしてある: `synth()` の中で付けると課金バイトをタグ抜きで数えて日次上限の判定がずれるため。**VOICEVOX へのフォールバック時はタグなしの本文を使う** (VOICEVOX は `[happy]` をそのまま読む)
- **Fish Audio クライアント**: `POST /v1/tts` に `Authorization: Bearer` と `model` ヘッダを付けて JSON を投げ、`format: "wav"` で受ける。WAV で受けることで `player.js` の ffmpeg 動線を VOICEVOX と完全に共通化している。リトライ方針は `voicevox.js` と同じ (200ms→400ms、4xx は即諦め) だが**タイムアウトは 15 秒**と短い — VOICEVOX の 30 秒はローカル CPU 合成が遅い前提の値で、クラウド API が 15 秒返さないのは障害であり待ってもキューを止めるだけのため。Fish ボイスは `data/fishVoices.json` (全サーバー共通、`alias -> { name, referenceId }`) に登録し、組み込みプリセット (`yaju` = 野獣先輩) は常にマージされて削除できない
- **Fish のコストガード**: Fish は従量課金 ($15 / 1M UTF-8 bytes、`s2.1-pro-free` は 2026-08-31 まで無料) のため、ギルド設定 `fishDailyBytes` (既定 50000、0 は無制限) で1日あたりの送信バイト数に上限を掛ける。カウンタは `tts.js` の in-memory Map (UTC 日付が変われば自動リセット) で**永続化しない** — 設定変更時だけ書き込む `data/` と違い、毎メッセージで fsync するのは割に合わないため。Bot 再起動でリセットされる。上限超過時は無音でスキップせず **VOICEVOX にフォールバック**して読み上げを継続し、警告ログはその日の初回だけ出す。一方 **API エラー/タイムアウト時はフォールバックしない** (既存どおり `drain()` がその1件だけスキップする) — 課金・可用性の問題と、キー不正のような設定ミスを黙って隠さないため
- **自動参加/退出**: `VoiceStateUpdate` イベントで Bot のいない VC に人が入ったら自動参加、**Bot のいる VC** から Bot 以外が全員いなくなったら自動退出 (退出のあった ch が Bot の接続先かを必ず照合する。照合しないと無関係な VC の最後の1人が抜けただけで Bot が蹴り出される)
- **読み上げ対象ch**: `/config channels` の `readChannelIds` が1件以上ならそのリストを優先し、空なら `/join`・自動参加が書く従来の `channelId`、それも無ければ全テキストchを対象にする。`/join` は `readChannelIds` を上書きしない
- **読み上げ挙動設定**: `guildSettings.json` は従来の `speaker` / `speed` / `channelId` に加え、`readChannelIds` (既定`[]`)・`announceVoiceState` (既定`true`)・`readAuthorName` (`off|changed|always`、既定`off`)・`maxLength` (既定50)・`fishDailyBytes` (既定50000)を持つ。発言者名の `changed` 状態はギルド単位のin-memory Mapで、チャンネル/発言者の変化または5分経過で名前を再び付ける
- **除外フィルタ**: 自Botは常に除外。他Botは `ignore.json` の `readBots`、発言者はギルドの `users` と全サーバー共通の `userSettings.mute`、本文は大文字小文字を区別しない前方一致 `prefixes` で判定する。ユーザー/mute/prefix除外は効果音より先に評価し、個人ミュートとギルドのユーザー除外はVC参加・退出通知にも適用する。自動参加/退出の在室者カウントは変えない。`/voice reset` は個人設定エントリごと削除するため `mute` も解除する
- **起動時の自動再入室**: セッションは in-memory のため再起動で消える。`index.js` の `rejoinActiveChannels()` が `ClientReady` 時に、再起動前にいた VC (Discord 側に残る幽霊接続) へ最優先で入り直し、無ければ `READ_CHANNELS` 設定ギルドで人のいる VC に入る (人が居なければ入らない)
- **セッション登録のタイミング**: `player.js` の `join()` は `entersState(Ready)` が成功してから `sessions` に登録する。先に登録すると接続失敗時に死んだセッションが残り、`getSession()` が truthy を返し続けて読み上げ無音・自動参加も不能になる。また `joinVoiceChannel` は同一 guildId の connection を使い回して返すため、リスナー登録は `WeakSet` で一度きりに絞る (毎回張ると積み増しになる)
- **音声キュー**: guild ごとに `player.js` の `sessions` Map で管理。`MAX_QUEUE` (100) を超える enqueue は破棄 (連投対策)。`skip(guildId, all)` で再生中をスキップ (`all=true` でキュー全消し)。合成/再生に失敗した1件は `drain()` がログを出してスキップし、キュー全体は止めない
- **効果音トリガー**: `index.js` の `SOUND_TRIGGERS` Map に完全一致文字列 → WAV ファイルパスを登録すると TTS をスキップして WAV を再生。除外フィルタ通過後にだけ評価する
- **テキスト整形**: `textProcessor.js` でコードブロック/URL/メンション/絵文字の除去に加え、スポイラー(`||text||`、中身は読まず「ネタバレ省略」に置換)・Markdown装飾記号(`**` `__` `~~` `*` `_`、見出し`#`・引用`>`・箇条書き`-`の先頭記号)の除去(中身は読み上げる)・文末/単独の「w/ｗ」連続 (2文字以上) を「笑」に変換 (英単語中の `ww` と**直後がドットの `www.example.com` は対象外**) を行う。**処理順に意味がある**: スポイラーは URL より先に潰す (URL 正規表現が `||https://…||` の閉じ `||` まで飲み込んでスポイラーと認識できなくなるため)。閉じていない ``` フェンスは開始位置から文末まで「コード省略」にする (貼り付け途中のコードや秘密値を読み上げないため)。絵文字除去は `Extended_Pictographic` だけでなく `Regional_Indicator` (国旗)・ZWJ・異体字セレクタ・キーキャップも落とす (本体だけ消えて不可視文字が残ると `!text.trim()` が false になり「添付ファイル」案内が出ない)。末尾の切り捨てはギルド設定 `maxLength` を使い、参照時にも10〜200へクランプする。**切り捨ては必ずコードポイント単位** (`sliceByCodePoint`) — `String#slice` は UTF-16 コードユニット単位なので BMP 外文字 (𝓪 や 𠮷) の途中で切ると孤立サロゲートが残り、`voicevox.js` の `encodeURIComponent` が `URIError` を投げて発言ごと捨てられる。発言者名は `sanitizeName()` (カスタム絵文字記法→名前・絵文字除去・辞書適用・20文字カット、空になれば「誰か」) を通し、本文の切り捨て後に前置する。**VC参加/退出通知も同じ `formatAuthorName()` を使う** (辞書適用だけだとニックネームの記号が延々読まれる)
- **VOICEVOX クライアントの耐性**: `voicevox.js` の `request()` は一時的な不通/5xxに対して200ms→400msのバックオフで最大2回リトライする (4xxは即諦める)。全リクエストに 30 秒のタイムアウトを掛ける (`AbortSignal.timeout`)。タイムアウト時はリトライしない — Engine が応答不能な状態で再挑戦してもキューを止める時間が延びるだけのため。`/user_dict_word` の POST は冪等でないので `retry: false` (5xx を返しつつ登録済みだと別 uuid で二重登録されるため)。`synth()` は `speaker:speed:pitch:intonation:text` をキーにした挿入順Map (上限100件、簡易LRU) でWAVをキャッシュし、同一文言の再合成コストを削減する。`getSpeakerIds()` 失敗時はギルドデフォルト話者にフォールバック。起動時に疎通確認の警告ログを出すが Bot は停止しない
- **辞書は2系統のハイブリッド構成**: `/dict replace` (既存の文字列置換辞書、`data/dictionary.json`、guildId単位) はどんな表層形/読みでも登録できる。**全エントリを1本の正規表現にまとめた1パス同時置換**で、word は長い順に並べて最長一致を担保し、正規表現エスケープしてリテラル一致させる (`(^^)` のような記号エントリがあるため)。逐次置換だと reading が別エントリの word を含んだときに置換結果が再度置換され、登録順で結果が変わるうえ、連鎖すると中間文字列が指数的に膨らんでプロセスごと落ちる。保険として置換後 4000 文字で頭打ちにし、ギルドあたり 200 件の登録上限も設けている。`/dict word` (VOICEVOXユーザー辞書、`data/userDict.json`、全サーバー共通) は VOICEVOX の形態素解析に単語として正式登録するため読み精度が上がるが、`pronunciation` は全角カタカナのみ受け付ける (`voicevox.js` の `hiraganaToKatakana`/`isKatakana` でひらがな入力を変換・検証)。既存の顔文字/記号系エントリ (`(^^)` 等) はカタカナ化できないため `dictionary.json` 側に残したまま移行していない。`voicevox_engine` コンテナは user_dict を永続化しないため、`index.js` の `ClientReady` で `importUserDict()` により `data/userDict.json` の内容 (登録時にVOICEVOXが発行したuuidを保持) を engine へ再投入し復元する

## テスト

`test/` に `node:test` の回帰テストを置く (`npm test`)。CI (`.github/workflows/ci.yml`) が PR と main への push で `npm ci --engine-strict` → 構文チェック → `npm test` → `npm audit --omit=dev --audit-level=high` → `docker build` まで回す。

- **外部依存には一切接続しない**。Discord/VOICEVOX/Fish Audio/ffmpeg を叩かず決定論的に完了する
- `store.js` は `YOMIAGE_DATA_DIR` で読み書き先を差し替えられる。`test/helpers.js` の `useTempDataDir()` が一時ディレクトリを作って env にセットするので、**`src/store.js` を import する前に呼ぶこと** (store は import 時に JSON を読む)
- HTTP は `test/helpers.js` の `stubFetch()` で `globalThis.fetch` を差し替える。`voicevox.js`/`fishAudio.js` は呼び出し時に `fetch` を解決するので、本番コードを触らずにモックできる
- `getSpeakerIds()` のようなモジュールレベルのキャッシュを跨ぐ検証は**ファイルを分ける**。`node:test` はファイルごとに別プロセスで走るため、これがキャッシュを確実にリセットする唯一の手段 (`test/userVoiceFallback.test.js` がその例)

## スラッシュコマンド追加手順

1. `src/commands/` に新ファイルを作成し `data` (SlashCommandBuilder) と `execute` をエクスポート
2. `src/commands/index.js` の `commands` 配列に追加
3. `npm run deploy` でコマンドを再登録

## エージェント運用ルール

Claude Code / Codex はこのリポジトリで PR を直接作らない。変更が必要だと判断したら
`.github/ISSUE_TEMPLATE/agent-proposal.yml` の形式で issue を起票し、そこで止まる
（実装・ブランチ作成・PR は人が明示的に指示してから）。
詳細は `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` の「GitHub 運用方針」を参照。

## Docker 運用

- **engine イメージはタグ固定**: `docker-compose.yml` は `voicevox/voicevox_engine:cpu-0.25.2` に固定してある。バージョンを上げるときは、上げる前に `curl -s localhost:50021/speakers | jq '[.[].styles[].id]'` を記録し、更新後に件数と並び順を比較する。変わっていれば `/voice` 未設定ユーザーの自動割り当て (`userVoice.js` の `userId % ids.length`) が総入れ替わりするので、事前にユーザーへ周知するか各自 `/voice speaker:` で固定してもらう。廃止されたスタイルIDを保存済みのユーザーは既定話者へフォールバックする（起動後のログに警告が出る）。
- **Bot は非rootで動く**: コンテナは uid 1000 (`node`) で実行される。macOS の Docker Desktop はバインドマウントをホストユーザーへマップするため `data/` はそのままで動くが、**Linux ホスト（Raspberry Pi 等）へ移設する場合は先に `sudo chown -R 1000:1000 data` が必要**。忘れると読み込みだけは成功して書き込みが失敗するため、`/config` や `/dict` が黙って効かない状態になり気付きにくい。
- **ログは 10MB × 3 世代でローテート**: 両サービスに `logging` を設定済み。`logging` は再作成が必要な項目なので、変更を反映するには `docker compose up -d` でコンテナを作り直す（engine を作り直すと VOICEVOX 側の user_dict は消えるが、Bot 起動時の復元処理が入れ直す）。
- 反映コマンド: `docker compose up -d --build`（engine 再作成 + bot 再ビルド）。確認は `docker inspect yomiage_bot --format '{{.HostConfig.LogConfig}}'` と `docker exec yomiage_bot id`（`uid=1000(node)` になること）。
