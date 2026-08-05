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
| `OPERATOR_IDS` | 任意 | `/dict word` (全サーバー共通辞書) を操作・閲覧できるユーザーID (カンマ区切り)。未設定なら Bot 所有者のみ |
| `FISH_API_KEY` | 任意 | Fish Audio の APIキー。未設定なら Fish は無効化され VOICEVOX のみで動く |
| `FISH_MODEL` | 任意 | デフォルト `s2.1-pro-free`。他に `s2.1-pro` / `s2-pro` / `s1` |
| `FISH_API_URL` | 任意 | デフォルト `https://api.fish.audio` |
| `DEBUG_LOG_TEXT` | 任意 | `1` で VOICEVOX のエラーログに生のパス (読み上げ本文を含む) と応答本文を出す。調査用 |

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
├── channels.js       # チャンネル判定 (自動参加可否・在室人数・読み上げ対象/スレッド親解決・移動完了待ち)
├── ignoreFilter.js   # ユーザー・個人ミュート・prefix・Bot発言の除外判定
├── userVoice.js      # 発言者ごとの話者解決ロジック
├── store.js          # JSON ファイル永続化 (data/ ディレクトリ)
├── schema.js         # 永続 JSON の shape 検証 (store.js が load 時に適用)
├── authorize.js      # /join・/leave の認可と /dict word の運用者判定 (純粋関数)
├── log.js            # タイムスタンプ付きの簡易ロガー
└── commands/         # スラッシュコマンド群
    ├── index.js      # コマンドを Map にまとめ、Guild限定の付与と実行時ガードを一括で掛ける
    ├── join.js / leave.js
    ├── voice.js      # 個人の話者・速度・声の高さ(pitch)・抑揚(intonation)・Fishボイス/感情設定
    ├── speakers.js   # 利用可能話者一覧表示 (末尾にFishボイスも併記)
    ├── fishvoice.js  # Fish Audio ボイスの add/remove/list (add/removeは要ManageGuild)
    ├── config.js     # ギルド単位の読み上げ挙動設定
    ├── ignore.js     # ギルド/個人の読み上げ除外設定
    ├── replyLines.js # 2000字制限を避けるephemeral分割応答
    └── dict.js       # /dict replace (文字列置換辞書、要ManageGuild) と
                       # /dict word (VOICEVOXユーザー辞書、全サーバー共通なので運用者限定)
```

**データフロー**: `MessageCreate` → Bot/セッション/対象ch/除外フィルタ判定 → 効果音判定 → `textProcessor.buildSpeech()` → 発言者名の前置 → `userVoice.resolveUserVoice()` → `player.enqueue()` → `tts.synthVoice()` → エンジン分岐して `voicevox.synth()` / `fishAudio.synth()` (どちらもWAVキャッシュ有り) → ffmpeg で Opus 変換 → Discord VC 再生

**永続化**: `data/guildSettings.json`・`data/userSettings.json`・`data/dictionary.json`・`data/userDict.json`・`data/ignore.json`・`data/fishVoices.json` にその場で書き込む (DB なし)。書き込みは `.tmp` へ書いてから `rename` するアトミック方式 (直接上書きすると停止タイミング次第で JSON が壊れ、`load()` が黙って既定値に落ちて設定が消えるため)。ランタイム中はインメモリキャッシュを使う。Docker 運用時は `data/` をホストにボリュームマウント (`docker-compose.yml`) するため、コンテナを作り直しても設定は保持される。ただし `voicevox_engine` サービスにはボリュームが無いため、engine コンテナ自体を作り直すと VOICEVOX 側の user_dict は消える (→ 起動時に自動復元、後述)。

読み込み時は JSON の構文だけでなく **shape も検証する** (`schema.js`)。valid JSON でありさえすれば root が `null` でも配列とオブジェクトが入れ替わっていても素通りしていたため、壊れた1件が読み上げ処理中の `TypeError` になり、プロセスが落ちれば同じファイルを読み直す compose restart がそのままクラッシュループになる。検証は**既知キーの型と範囲だけを見て無効なものを落とし、未知キーは残す** (消すと古いバージョンへ戻したとき設定が失われる)。除去が発生したファイルは `.corrupt-<timestamp>` へ**退避してから**復旧後の内容で上書きする — 退避しないと次の `save()` で証拠ごと消える。イベントハンドラは `index.js` の `guard()` で包み、1件の不正データが発生源つきのログで済むようにしてある。

**既定値はファイルに焼き付けない**。`updateGuildSettings()` のベースは保存済みの生の値で、既定値の適用は `getGuildSettings()` に一本化してある。`getGuildSettings()` をベースにすると patch に含まれないキーまで既定値のスナップショットとして保存され、あとで `DEFAULT_SETTINGS` を変えても「一度でも `/join` や `/config` を実行したギルドだけ古い既定値のまま」という差が出て、`/config show` を見ても理由が分からない。既に焼き付いた分は起動時の `pruneDefaultGuildSettings()` が落とす。`/config reset` も既定値を書き込むのではなく `resetGuildSettings()` で保存済みキーを消す方式で、**`channelId` (`/join` が決めた読み上げ元) と `speaker`/`speed` は消さない** (`channelId` まで消すと読み上げ対象が「全チャンネル」に広がる)。

## 設計上のポイント

- **話者の優先順位**: 個人設定 (`/voice`) > `userId % 話者数` による決定論的割り当て > ギルドデフォルト (speaker=3)。速度・pitch・intonation は個人設定がなければ既定値 (1.0 / 0.0 / 1.0)。`userVoice.resolveUserVoice()` が `{ engine, speaker, fishRef, fishEmotion, speed, pitch, intonation }` を返し、`tts.synthVoice()` がエンジンを選んで合成する。**engine が `fish` でも VOICEVOX の `speaker` は必ず解決する** — Fish の日次バイト上限超過時のフォールバック先として必要なため。**明示指定の話者IDも合成前に存在確認する**: 存在しない ID だと合成が毎回 422 で落ち、そのユーザーの発言が永久に無音になるため、既定話者へ倒して読み上げを継続し、直し方をユーザーごと一度だけログに出す。ただし**話者一覧を取得できないときは明示指定を尊重する** (Engine 不通のたびに全ユーザーの声を既定話者へ倒すと総入れ替わりになる)。`/voice speaker:` 側も一覧を取れなければ**操作全体を拒否する** — 検証できないまま保存すると復旧後も無音が続き、speaker だけ捨てて speed 等を保存すると「一部だけ効いた」状態になるため
- **TTSエンジンの二本立て**: 既定は VOICEVOX。`/voice fish:<エイリアス|reference_id>` を明示指定したユーザーだけが Fish Audio ([fish.audio](https://fish.audio)) を使う。`/voice speaker:` と `/voice fish:` は排他 (同時指定はエラー)。**自動ランダム割り当ての対象は VOICEVOX 話者のみ**で Fish は混ぜない (課金と ID 空間が別物のため)。`speed` のレンジは両者 0.5〜2.0 で一致する。`pitch` は VOICEVOX 固有 (`audio_query` のフィールド) で Fish に対応物が無いため無視されるが、`intonation` は `fishAudio.intonationToTemperature()` で Fish の `temperature` に換算して効かせる。`synth()` の呼び出し口を `tts.synthVoice()` の1箇所に集約してあるので、エンジン追加時に `player.js` を触る必要はない
- **Fish の抑揚と感情タグ**: `/voice intonation` (0.0〜2.0) を Fish の `temperature` (0.1〜1.0) へ**折れ線**で換算する (`0→0.1` / `1→0.7` / `2→1.0`)。単純な線形換算だと既定値 1.0 が 0.55 になり、何も設定していない既存ユーザーの声が黙って平坦になるため、VOICEVOX 既定の 1.0 が Fish 既定の 0.7 に一致する形にしてある (未指定時は `temperature` フィールド自体を送らない)。`top_p` は触らない。`/voice fish_emotion` は本文頭に `[happy]` のようなタグを付けて話し方を変えるもので、**S2 系モデル限定** (`s1` に付けると literal に読まれるため `supportsEmotion()` で判定してスキップ)。タグは choices 固定 — 自由入力だとタグとして解釈されない文字列がそのまま読み上げられ、しかも課金バイトに乗る。タグの付与は `fishAudio.applyEmotion()` を `tts.js` から呼ぶ形にしてある: `synth()` の中で付けると課金バイトをタグ抜きで数えて日次上限の判定がずれるため。**VOICEVOX へのフォールバック時はタグなしの本文を使う** (VOICEVOX は `[happy]` をそのまま読む)
- **Fish Audio クライアント**: `POST /v1/tts` に `Authorization: Bearer` と `model` ヘッダを付けて JSON を投げ、`format: "wav"` で受ける。WAV で受けることで `player.js` の ffmpeg 動線を VOICEVOX と完全に共通化している。リトライ方針は `voicevox.js` と同じ (200ms→400ms、4xx は即諦め) だが**タイムアウトは 15 秒**と短い — VOICEVOX の 30 秒はローカル CPU 合成が遅い前提の値で、クラウド API が 15 秒返さないのは障害であり待ってもキューを止めるだけのため。Fish ボイスは `data/fishVoices.json` (全サーバー共通、`alias -> { name, referenceId }`) に登録し、組み込みプリセット (`yaju` = 野獣先輩) は常にマージされて削除できない
- **Fish のコストガード**: Fish は従量課金 ($15 / 1M UTF-8 bytes、`s2.1-pro-free` は 2026-08-31 まで無料) のため、ギルド設定 `fishDailyBytes` (既定 50000、0 は無制限) で1日あたりの送信バイト数に上限を掛ける。カウンタは `tts.js` の in-memory Map (UTC 日付が変われば自動リセット) で**永続化しない** — 設定変更時だけ書き込む `data/` と違い、毎メッセージで fsync するのは割に合わないため。Bot 再起動でリセットされる。上限超過時は無音でスキップせず **VOICEVOX にフォールバック**して読み上げを継続し、警告ログはその日の初回だけ出す。一方 **API エラー/タイムアウト時はフォールバックしない** (既存どおり `drain()` がその1件だけスキップする) — 課金・可用性の問題と、キー不正のような設定ミスを黙って隠さないため
- **自動参加/退出**: `VoiceStateUpdate` イベントで Bot のいない VC に人が入ったら自動参加、**Bot のいる VC** から Bot 以外が全員いなくなったら自動退出 (退出のあった ch が Bot の接続先かを必ず照合する。照合しないと無関係な VC の最後の1人が抜けただけで Bot が蹴り出される)。自動参加の条件は**実際の入室 (`oldState.channelId !== newState.channelId`) に限る** — `newState.channel` は self-mute/deaf/stream の切替でも truthy なので、これを見ないと明示的な `/leave` 直後に居残りメンバーがミュートを押しただけで Bot が戻る。参加先は `channels.js` の `isAutoJoinable()` で絞り、**AFK チャンネルとステージチャンネルは除外する** (AFK に入ると `getSession()` が truthy になって通常VCへ移動できなくなり、ステージでは Bot が audience として suppress され再生しても誰にも聞こえない)。起動時再入室も同じフィルタを通す。`join()` の Ready 待ちの間に最後の1人が抜けることがあるため、**参加直後に在室者を数え直して0人なら畳む** (自動退出は `VoiceStateUpdate` 起点なので、放置すると Bot だけが取り残される)
- **読み上げ対象ch**: `/config channels` の `readChannelIds` が1件以上ならそのリストを優先し、空なら `/join`・自動参加が書く従来の `channelId`、それも無ければ全テキストchを対象にする。`/join` は `readChannelIds` を上書きしない。**自動参加は既存の `channelId` を維持し、未設定のときだけ `READ_CHANNELS` で補完する** (毎回上書きすると、`/join` で `#tts` に絞った設定が全員退出→再入室のたびに消え、`channelId=null` かつ `readChannelIds=[]` = 制限なしとして非公開chまで公開VCへ読み上げてしまう)。**スレッドは親chの設定に従う** — `message.channelId` はスレッドIDになるため ID の完全一致だけだと親chを指定した瞬間に配下スレッドが一切読まれず、スレッドは `addChannelTypes` の対象外で追加もできない。判定は `channels.js` の `isReadTargetChannel()` に集約してある。`/join` をスレッド内で実行した場合は `readTargetIdFor()` で**親chのIDを保存する** (スレッドIDのままだとアーカイブ後に何も読み上げられなくなる)
- **読み上げ挙動設定**: `guildSettings.json` は従来の `speaker` / `speed` / `channelId` に加え、`readChannelIds` (既定`[]`)・`announceVoiceState` (既定`true`)・`readAuthorName` (`off|changed|always`、既定`off`)・`maxLength` (既定50)・`fishDailyBytes` (既定50000)を持つ。発言者名の `changed` 状態はギルド単位のin-memory Mapで、チャンネル/発言者の変化または5分経過で名前を再び付ける
- **除外フィルタ**: 自Botは常に除外。他Botは `ignore.json` の `readBots`、発言者はギルドの `users` と全サーバー共通の `userSettings.mute`、本文は大文字小文字を区別しない前方一致 `prefixes` で判定する。ユーザー/mute/prefix除外は効果音より先に評価し、個人ミュートとギルドのユーザー除外はVC参加・退出通知にも適用する。自動参加/退出の在室者カウントは変えない。`/voice reset` は個人設定エントリごと削除するため `mute` も解除する
- **起動時の自動再入室**: セッションは in-memory のため再起動で消える。`index.js` の `rejoinActiveChannels()` が `ClientReady` 時に、再起動前にいた VC (Discord 側に残る幽霊接続) へ最優先で入り直し、無ければ `READ_CHANNELS` 設定ギルドで人のいる VC に入る (人が居なければ入らない)
- **セッション登録のタイミング**: `player.js` の `join()` は `entersState(Ready)` が成功してから `sessions` に登録する。先に登録すると接続失敗時に死んだセッションが残り、`getSession()` が truthy を返し続けて読み上げ無音・自動参加も不能になる。また `joinVoiceChannel` は同一 guildId の connection を使い回して返すため、リスナー登録は `WeakSet` で一度きりに絞る (毎回張ると積み増しになる)
- **参加前の検証と移動完了の確認**: `doJoin()` は接続前に `channel.joinable` / `speakable` を見て、権限不足・満員なら `userFacing` 付きのエラーで即座に落とす (`/join` はその文言をそのまま返す。汎用文言に潰すと管理者が直せる原因が伝わらない)。さらに **`entersState(Ready)` の成功だけでは移動完了の証明にならない** — VC-A で既に Ready の connection を VC-B へ移す場合、`entersState` は移動前に即解決するため、そのまま session を登録すると B 向けの音声が A へ流れたまま「B に参加しました」と応答してしまう。`channels.js` の `waitForBotChannel()` で **Bot 自身の VoiceState が対象chになるまで待ち**、確認できなければ connection を破棄して失敗扱いにする (Bot の `GuildMember` が未キャッシュのときだけは検証不能として素通しする。ここで失敗にすると全 join が通らなくなるため)
- **コマンドの認可**: 全コマンドは `commands/index.js` で一括して `setContexts(Guild)` を掛け、`commandMap` に入れる時点で `inGuild()` ガードで包む (登録側と実行側の二重化。過去に global 登録した分は再登録するまで DM に残るため、実行時ガードだけが効く期間がある)。個別のコマンドファイルに書かないのは、新しいコマンドで付け忘れないため。**`/join` と `/leave` は VC 操作の認可を通す** (`authorize.js`): Bot 未接続の `/join` と、Bot と同じ VC にいる人の `/join`・`/leave` は従来どおり誰でも可。**別 VC への移動と VC 外からの切断だけ `ManageGuild` または `MoveMembers` を要求する** — 無条件だと別 VC の一般ユーザーが稼働中の読み上げ (session と queue) を奪え、VC 未参加者でも読み上げを止められる。判定は `getSession()` ではなく Bot の VoiceState を見る (幽霊接続も拾うため)。**`/dict word` は運用者専用** — VOICEVOX のユーザー辞書は guildId を持たない全サーバー共通の配列で単一 Engine の全読み上げに効くため、ギルドの `ManageGuild` で許すと Guild A の管理者が Guild B の発音まで書き換えられ、list では他サーバー由来の登録語も読める。`OPERATOR_IDS` (未設定なら Bot 所有者、Team 所有ならそのメンバー) に限定し、閲覧も含めて塞ぐ。ギルド単位の `/dict replace` は従来どおり `ManageGuild`
- **音声キュー**: guild ごとに `player.js` の `sessions` Map で管理。`MAX_QUEUE` (100) を超える enqueue は破棄 (連投対策)。`skip(guildId, all)` で再生中をスキップ (`all=true` でキュー全消し)。合成/再生に失敗した1件は `drain()` がログを出してスキップし、キュー全体は止めない
- **効果音トリガー**: `index.js` の `SOUND_TRIGGERS` Map に完全一致文字列 → WAV ファイルパスを登録すると TTS をスキップして WAV を再生。除外フィルタ通過後にだけ評価する
- **テキスト整形**: `textProcessor.js` でコードブロック/URL/メンション/絵文字の除去に加え、スポイラー(`||text||`、中身は読まず「ネタバレ省略」に置換)・Markdown装飾記号(`**` `__` `~~` `*` `_`、見出し`#`・引用`>`・箇条書き`-`の先頭記号)の除去(中身は読み上げる)・文末/単独の「w/ｗ」連続 (2文字以上) を「笑」に変換 (英単語中の `ww` と**直後がドットの `www.example.com` は対象外**) を行う。**処理順に意味がある**: スポイラーは URL より先に潰す (URL 正規表現が `||https://…||` の閉じ `||` まで飲み込んでスポイラーと認識できなくなるため)。閉じていない ``` フェンスは開始位置から文末まで「コード省略」にする (貼り付け途中のコードや秘密値を読み上げないため)。絵文字除去は `Extended_Pictographic` だけでなく `Regional_Indicator` (国旗)・ZWJ・異体字セレクタ・キーキャップも落とす (本体だけ消えて不可視文字が残ると `!text.trim()` が false になり「添付ファイル」案内が出ない)。末尾の切り捨てはギルド設定 `maxLength` を使い、参照時にも10〜200へクランプする。**切り捨ては必ずコードポイント単位** (`sliceByCodePoint`) — `String#slice` は UTF-16 コードユニット単位なので BMP 外文字 (𝓪 や 𠮷) の途中で切ると孤立サロゲートが残り、`voicevox.js` の `encodeURIComponent` が `URIError` を投げて発言ごと捨てられる。発言者名は `sanitizeName()` (カスタム絵文字記法→名前・絵文字除去・辞書適用・20文字カット、空になれば「誰か」) を通し、本文の切り捨て後に前置する。**VC参加/退出通知も同じ `formatAuthorName()` を使う** (辞書適用だけだとニックネームの記号が延々読まれる)
- **VOICEVOX クライアントの耐性**: `voicevox.js` の `request()` は一時的な不通/5xxに対して200ms→400msのバックオフで最大2回リトライする (4xxは即諦める)。全リクエストに 30 秒のタイムアウトを掛ける (`AbortSignal.timeout`)。タイムアウト時はリトライしない — Engine が応答不能な状態で再挑戦してもキューを止める時間が延びるだけのため。`/user_dict_word` の POST は冪等でないので `retry: false` (5xx を返しつつ登録済みだと別 uuid で二重登録されるため)。`synth()` は `speaker:speed:pitch:intonation:text` をキーにした挿入順Map (上限100件、簡易LRU) でWAVをキャッシュし、同一文言の再合成コストを削減する。`getSpeakerIds()` 失敗時はギルドデフォルト話者にフォールバック。起動時に疎通確認の警告ログを出すが Bot は停止しない
- **ログに読み上げ本文を残さない**: 読み上げ本文は `/audio_query` の `text`、ユーザー辞書の語は `/user_dict_word` の `surface`/`pronunciation` として**クエリ文字列に乗る**。エラーメッセージにパスをそのまま埋めると、Engine が一時的に落ちるたびに Discord の発言本文が URL エンコードされた形でコンテナの標準出力に残り続ける (`log.js` も `store.js` も本文を残さない設計なので、ここだけ抜けているのは筋が悪い)。`safePath()` が値を `<redacted:NN文字>` に置き換え、`speaker`/`accent_type`/`priority`/`override` のような非機密パラメータだけ残す。**FastAPI の 422 はリクエスト内容をそのまま返す**ため、本文由来のデータを送るリクエスト (`/audio_query`・`/user_dict_word`・`sensitiveBody` を立てた `/synthesis`・`/import_user_dict`) は応答本文も伏せる。調査時は `DEBUG_LOG_TEXT=1` で生のパスと応答本文を出せる
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
