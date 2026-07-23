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
```

`npm run deploy` は `.env` の `GUILD_IDS` にギルドIDが設定されていればギルド限定(即反映)、空ならグローバル登録(最大1時間遅延)。

### ローカル開発 (コンテナを使わず直接実行する場合)

```bash
docker compose up -d voicevox_engine   # Engine だけ起動
npm start                              # ホストで Bot を起動 (要 Node.js 20+)
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

Discord Developer Portal で **Message Content Intent** を有効にすること。

## アーキテクチャ

```
src/
├── index.js          # エントリポイント。Discord イベント処理
├── player.js         # VC 接続・音声キュー管理 (guild ごとの sessions Map)
├── voicevox.js       # VOICEVOX Engine HTTP クライアント (合成 + ユーザー辞書API)
├── textProcessor.js  # メッセージ前処理 (URL/コード/メンション/絵文字/Markdown/草の置換)
├── ignoreFilter.js   # ユーザー・個人ミュート・prefix・Bot発言の除外判定
├── userVoice.js      # 発言者ごとの話者解決ロジック
├── store.js          # JSON ファイル永続化 (data/ ディレクトリ)
├── log.js            # タイムスタンプ付きの簡易ロガー
└── commands/         # スラッシュコマンド群
    ├── index.js      # コマンドを Map にまとめる
    ├── join.js / leave.js
    ├── voice.js      # 個人の話者・速度・声の高さ(pitch)・抑揚(intonation)設定
    ├── speakers.js   # 利用可能話者一覧表示
    ├── config.js     # ギルド単位の読み上げ挙動設定
    ├── ignore.js     # ギルド/個人の読み上げ除外設定
    ├── replyLines.js # 2000字制限を避けるephemeral分割応答
    └── dict.js       # /dict replace (文字列置換辞書) と /dict word (VOICEVOXユーザー辞書)、
                       # ともに add/remove/list、add/remove は要ManageGuild権限
```

**データフロー**: `MessageCreate` → Bot/セッション/対象ch/除外フィルタ判定 → 効果音判定 → `textProcessor.buildSpeech()` → 発言者名の前置 → `userVoice.resolveUserVoice()` → `player.enqueue()` → `voicevox.synth()` (WAVキャッシュ有り) → ffmpeg で Opus 変換 → Discord VC 再生

**永続化**: `data/guildSettings.json`・`data/userSettings.json`・`data/dictionary.json`・`data/userDict.json`・`data/ignore.json` にその場で書き込む (DB なし)。書き込みは `.tmp` へ書いてから `rename` するアトミック方式 (直接上書きすると停止タイミング次第で JSON が壊れ、`load()` が黙って既定値に落ちて設定が消えるため)。ランタイム中はインメモリキャッシュを使う。Docker 運用時は `data/` をホストにボリュームマウント (`docker-compose.yml`) するため、コンテナを作り直しても設定は保持される。ただし `voicevox_engine` サービスにはボリュームが無いため、engine コンテナ自体を作り直すと VOICEVOX 側の user_dict は消える (→ 起動時に自動復元、後述)。

## 設計上のポイント

- **話者の優先順位**: 個人設定 (`/voice`) > `userId % 話者数` による決定論的割り当て > ギルドデフォルト (speaker=3)。速度・pitch・intonation は個人設定がなければ既定値 (1.0 / 0.0 / 1.0)。`userVoice.resolveUserVoice()` が `{ speaker, speed, pitch, intonation }` を返し、`voicevox.synth()` の `audio_query` に反映する
- **自動参加/退出**: `VoiceStateUpdate` イベントで Bot のいない VC に人が入ったら自動参加、**Bot のいる VC** から Bot 以外が全員いなくなったら自動退出 (退出のあった ch が Bot の接続先かを必ず照合する。照合しないと無関係な VC の最後の1人が抜けただけで Bot が蹴り出される)
- **読み上げ対象ch**: `/config channels` の `readChannelIds` が1件以上ならそのリストを優先し、空なら `/join`・自動参加が書く従来の `channelId`、それも無ければ全テキストchを対象にする。`/join` は `readChannelIds` を上書きしない
- **読み上げ挙動設定**: `guildSettings.json` は従来の `speaker` / `speed` / `channelId` に加え、`readChannelIds` (既定`[]`)・`announceVoiceState` (既定`true`)・`readAuthorName` (`off|changed|always`、既定`off`)・`maxLength` (既定50)を持つ。発言者名の `changed` 状態はギルド単位のin-memory Mapで、チャンネル/発言者の変化または5分経過で名前を再び付ける
- **除外フィルタ**: 自Botは常に除外。他Botは `ignore.json` の `readBots`、発言者はギルドの `users` と全サーバー共通の `userSettings.mute`、本文は大文字小文字を区別しない前方一致 `prefixes` で判定する。ユーザー/mute/prefix除外は効果音より先に評価し、個人ミュートとギルドのユーザー除外はVC参加・退出通知にも適用する。自動参加/退出の在室者カウントは変えない。`/voice reset` は個人設定エントリごと削除するため `mute` も解除する
- **起動時の自動再入室**: セッションは in-memory のため再起動で消える。`index.js` の `rejoinActiveChannels()` が `ClientReady` 時に、再起動前にいた VC (Discord 側に残る幽霊接続) へ最優先で入り直し、無ければ `READ_CHANNELS` 設定ギルドで人のいる VC に入る (人が居なければ入らない)
- **セッション登録のタイミング**: `player.js` の `join()` は `entersState(Ready)` が成功してから `sessions` に登録する。先に登録すると接続失敗時に死んだセッションが残り、`getSession()` が truthy を返し続けて読み上げ無音・自動参加も不能になる。また `joinVoiceChannel` は同一 guildId の connection を使い回して返すため、リスナー登録は `WeakSet` で一度きりに絞る (毎回張ると積み増しになる)
- **音声キュー**: guild ごとに `player.js` の `sessions` Map で管理。`MAX_QUEUE` (100) を超える enqueue は破棄 (連投対策)。`skip(guildId, all)` で再生中をスキップ (`all=true` でキュー全消し)。合成/再生に失敗した1件は `drain()` がログを出してスキップし、キュー全体は止めない
- **効果音トリガー**: `index.js` の `SOUND_TRIGGERS` Map に完全一致文字列 → WAV ファイルパスを登録すると TTS をスキップして WAV を再生。除外フィルタ通過後にだけ評価する
- **テキスト整形**: `textProcessor.js` でコードブロック/URL/メンション/絵文字の除去に加え、スポイラー(`||text||`、中身は読まず「ネタバレ省略」に置換)・Markdown装飾記号(`**` `__` `~~` `*` `_`、見出し`#`・引用`>`・箇条書き`-`の先頭記号)の除去(中身は読み上げる)・文末/単独の「w/ｗ」連続 (2文字以上) を「笑」に変換 (英単語中の `ww` は対象外) を行う。末尾の切り捨てはギルド設定 `maxLength` を使い、参照時にも10〜200へクランプする。発言者名は辞書適用後20文字で切り、本文の切り捨て後に前置する
- **VOICEVOX クライアントの耐性**: `voicevox.js` の `request()` は一時的な不通/5xxに対して200ms→400msのバックオフで最大2回リトライする (4xxは即諦める)。全リクエストに 30 秒のタイムアウトを掛ける (`AbortSignal.timeout`)。タイムアウト時はリトライしない — Engine が応答不能な状態で再挑戦してもキューを止める時間が延びるだけのため。`/user_dict_word` の POST は冪等でないので `retry: false` (5xx を返しつつ登録済みだと別 uuid で二重登録されるため)。`synth()` は `speaker:speed:pitch:intonation:text` をキーにした挿入順Map (上限100件、簡易LRU) でWAVをキャッシュし、同一文言の再合成コストを削減する。`getSpeakerIds()` 失敗時はギルドデフォルト話者にフォールバック。起動時に疎通確認の警告ログを出すが Bot は停止しない
- **辞書は2系統のハイブリッド構成**: `/dict replace` (既存の文字列置換辞書、`data/dictionary.json`、guildId単位) はどんな表層形/読みでも登録できる代わりに単純な全置換。`/dict word` (VOICEVOXユーザー辞書、`data/userDict.json`、全サーバー共通) は VOICEVOX の形態素解析に単語として正式登録するため読み精度が上がるが、`pronunciation` は全角カタカナのみ受け付ける (`voicevox.js` の `hiraganaToKatakana`/`isKatakana` でひらがな入力を変換・検証)。既存の顔文字/記号系エントリ (`(^^)` 等) はカタカナ化できないため `dictionary.json` 側に残したまま移行していない。`voicevox_engine` コンテナは user_dict を永続化しないため、`index.js` の `ClientReady` で `importUserDict()` により `data/userDict.json` の内容 (登録時にVOICEVOXが発行したuuidを保持) を engine へ再投入し復元する

## スラッシュコマンド追加手順

1. `src/commands/` に新ファイルを作成し `data` (SlashCommandBuilder) と `execute` をエクスポート
2. `src/commands/index.js` の `commands` 配列に追加
3. `npm run deploy` でコマンドを再登録
