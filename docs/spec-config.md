# 仕様書: `/config` — 読み上げ挙動のサーバー単位設定

- 状態: 実装済み (2026-07-23)
- 関連: [feature-ideas.md](feature-ideas.md) の候補C / [spec-ignore.md](spec-ignore.md)

## 1. 背景と目的

現状、読み上げの挙動は次のようにハードコード or 固定になっている。

- 読み上げ対象チャンネルは `guildSettings.channelId` の**1つだけ**（`src/index.js:124`）
- VC参加/退出の読み上げは**常時ON**で切れない（`src/index.js:165-172`）
- 本文の最大文字数は `MAX_LENGTH = 50` のモジュール定数（`src/textProcessor.js:3`）
- 発言者が誰なのかは読み上げられない

サーバーごとに人数も使い方も違うため、これらをギルド管理者が調整できるようにする。

**目的**: Bot を再ビルド・再起動せずに、サーバー管理者が読み上げ挙動を調整できる状態にする。

## 2. スコープ

### やること

- ギルド単位設定 4項目（対象ch複数指定 / 参加退出読み上げ / 発言者名読み上げ / 最大文字数）の追加
- それらを操作する `/config` コマンド
- 既存 `data/guildSettings.json` からの無停止移行

### やらないこと

- 個人単位の設定（`/voice` の領分。話者・速度・pitch・intonation は現状のまま）
- 除外フィルタ（`/ignore` の領分 → [spec-ignore.md](spec-ignore.md)）
- `MAX_QUEUE`(100) や VOICEVOX 接続まわりの設定化
- 設定のサーバー間コピー / インポート・エクスポート

## 3. 設定項目

保存先は既存の `data/guildSettings.json`（ギルド単位のスカラー設定はここに集約する）。

| キー | 型 | 既定値 | 範囲・値 | 説明 |
|---|---|---|---|---|
| `readChannelIds` | `string[]` | `[]` | 最大 10 件 | 読み上げ対象テキストch。明示指定用 |
| `announceVoiceState` | `boolean` | `true` | — | VC参加/退出の読み上げ |
| `readAuthorName` | `string` | `"off"` | `off` / `changed` / `always` | 発言者名の読み上げ |
| `maxLength` | `number` | `50` | 10〜200 の整数 | 本文の最大文字数（超過分は `以下略`） |

既存キー `speaker` / `speed` / `channelId` はそのまま残す。

### 3.1 読み上げ対象チャンネルの解決規則

`channelId`（`/join` や自動参加が書き込む従来キー）と `readChannelIds`（管理者の明示指定）を併存させ、
次の優先順で解決する。

```
readChannelIds が1件以上        → そのリストのみ読み上げる
readChannelIds が空 かつ channelId あり → [channelId] のみ読み上げる（現行と同じ）
readChannelIds が空 かつ channelId なし → 全テキストchを読み上げる（現行と同じ）
```

- **`/join` の挙動は変更しない**（従来どおり `channelId` に実行chを書く）。
  `readChannelIds` を明示設定してあるサーバーでは `/join` がそれを上書きしないため、
  管理者の設定が誰かの `/join` で消える事故が起きない。
- 逆に「`/join` したchを読ませたい」だけの従来運用は `readChannelIds` を空のまま使えば従来どおり動く。

### 3.2 発言者名の読み上げ

| 値 | 挙動 |
|---|---|
| `off`（既定） | 本文のみ読む（現行と同じ） |
| `changed` | **直前に読み上げた発言者と異なるとき**だけ名前を前置 |
| `always` | 毎回名前を前置 |

- 読み上げ文の形は `<名前> <本文>`（半角スペース区切り）。
- 名前は `member.displayName`（取れなければ `user.username`）に**読み替え辞書を適用**したもの。
  参加/退出読み上げが既に `applyDictionary()` を通しているのと揃える（`src/index.js:162`）。
- 名前は 20 文字で切り捨てる。
- **本文を `maxLength` で切ってから名前を前置する。** 逆順にすると、名前が長い人の本文だけ削られる。
- `changed` の判定状態は in-memory（ギルド単位: 直前の `channelId` / `userId` / 時刻）。
  最後の読み上げから 5 分以上空いた場合は「変わった」とみなして名前を付ける（会話の区切りで名前を復活させるため）。
  Bot 再起動やセッション消滅で状態が消えるが、影響は「再開後の最初の1発言に名前が付く」だけなので許容する。

### 3.3 最大文字数

- `textProcessor.buildSpeech()` が `getGuildSettings(guildId).maxLength` を参照する。
- `data/guildSettings.json` を手編集された場合に備え、**参照側でも 10〜200 にクランプ**し、
  数値でなければ既定の 50 を使う（不正値で読み上げが全滅しないようにする）。

## 4. コマンド仕様

```
/config show                                   # 現在の設定を表示（全員可）
/config set    [announce_voice_state:<bool>]
               [read_author_name:<off|changed|always>]
               [max_length:<10-200>]           # 指定した項目だけ更新（要 サーバー管理）
/config channels [add:<channel>] [remove:<channel>] [clear:<bool>]
                                               # 対象chの追加/削除/全消し（要 サーバー管理）
/config reset                                  # 上記4項目を既定値へ戻す（要 サーバー管理）
```

- サブコマンドはすべてフラット（サブコマンドグループを使わない）。
- 応答はすべて **ephemeral**（`MessageFlags.Ephemeral`）。既存コマンドと揃える。
- 権限チェックは `dict.js` と同じく `interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)`。
  不足時は `この操作には「サーバー管理」権限が必要です。` を ephemeral で返す。
- VOICEVOX への問い合わせが無いので **`deferReply` は不要**（3秒以内に応答できる）。
- `/config set` で1つもオプションが指定されなかった場合は、更新せず `show` と同じ内容を返す。
- `/config channels` は `clear:true` を最優先で処理し、その後 `remove` → `add` の順に適用する。
- `channels` の対象は `addChannelOption` に `ChannelType.GuildText` / `GuildAnnouncement` を指定して絞る。
- `/config reset` は `speaker` / `speed` / `channelId` には触らない（`/voice` と `/join` の領分のため）。

### `/config show` の出力例

```
読み上げ対象ch: #general, #雑談 （明示指定）
VC参加/退出の読み上げ: ON
発言者名の読み上げ: 発言者が変わったときだけ
最大文字数: 50
```

対象chが未設定のときは `読み上げ対象ch: 全チャンネル` または `#<ch名>（/join で設定）` と表示し、
どの規則で読み上げられているかが一目で分かるようにする。

## 5. 受け入れ条件

すべて手動確認（このリポジトリにテストランナーは無い）。確認は
`docker compose up -d --build bot` → `docker compose logs -f bot` で行う。

### 対象チャンネル

- [ ] AC-1: `readChannelIds` 未設定・`channelId` 設定済みのサーバーで、従来どおり当該chのみ読み上げる（**既存挙動の非破壊**）
- [ ] AC-2: `/config channels add:#A` → #A の発言のみ読み上げ、`channelId` が別chでも #A が優先される
- [ ] AC-3: `/config channels add:#B` を追加 → #A と #B の両方を読み上げる
- [ ] AC-4: AC-3 の状態で別ユーザーが `/join` を実行しても、#A/#B の設定は維持される
- [ ] AC-5: `/config channels clear:true` → `channelId` があればそのchのみ、無ければ全chを読み上げる状態に戻る
- [ ] AC-6: 11件目の `add` は拒否され、`登録できる対象chは10件までです。` を返す

### 参加/退出読み上げ

- [ ] AC-7: 既定（未設定）のサーバーで、VC参加時に `〇〇が参加しました` が読まれる（**既存挙動の非破壊**）
- [ ] AC-8: `/config set announce_voice_state:false` → 参加/退出時に何も読まれない。テキスト読み上げは通常どおり動く

### 発言者名

- [ ] AC-9: 既定（`off`）では本文のみ読まれる（**既存挙動の非破壊**）
- [ ] AC-10: `always` で、同じ人が連続発言しても毎回名前が読まれる
- [ ] AC-11: `changed` で、A→A→B と発言したとき、1回目のAとBだけ名前が読まれる
- [ ] AC-12: `changed` で、最後の発言から5分以上空けた同一人物の発言には再び名前が付く
- [ ] AC-13: 表示名が読み替え辞書に登録されている場合、名前部分にも辞書が適用される
- [ ] AC-14: 50文字ちょうどの本文に長い名前が付いても、本文が `以下略` で削られない（名前は文字数計算の外）

### 最大文字数

- [ ] AC-15: 既定では 51 文字目以降が `以下略` になる（**既存挙動の非破壊**）
- [ ] AC-16: `/config set max_length:200` → 200文字まで読み上げる
- [ ] AC-17: `max_length:5` / `max_length:500` はコマンド側で弾かれる（Discord の min/max value）
- [ ] AC-18: `data/guildSettings.json` の `maxLength` を手で `"abc"` や `9999` にしても Bot が落ちず、既定値/上限にクランプされる

### コマンド全般

- [ ] AC-19: サーバー管理権限の無いユーザーの `set` / `channels` / `reset` は拒否される。`show` は誰でも実行できる
- [ ] AC-20: すべての応答が ephemeral で、3秒以内に返る（`10062 Unknown interaction` が出ない）
- [ ] AC-21: Bot を再起動しても設定が保持される（`data/guildSettings.json` に永続化されている）
- [ ] AC-22: 設定変更中に `kill -9` しても `guildSettings.json` が壊れない（既存の `.tmp` → `rename` 経路に乗っている）

## 6. 実装方針

### 6.1 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/store.js` | `DEFAULT_SETTINGS` に4キー追加、`getReadChannelIds()` を追加 |
| `src/textProcessor.js` | `MAX_LENGTH` 定数を廃し、ギルド設定＋クランプに置換。`formatAuthorName()` を追加 |
| `src/index.js` | `MessageCreate` の対象ch判定を差し替え、発言者名の前置を追加。`VoiceStateUpdate` の読み上げを `announceVoiceState` でガード |
| `src/commands/config.js` | **新規**。`/config` 本体 |
| `src/commands/index.js` | `config` を `commands` 配列に追加 |
| `README.md` / `CLAUDE.md` | コマンド一覧・設計上の前提を更新 |

### 6.2 `src/store.js`

```js
const DEFAULT_SETTINGS = {
  speaker: 3,
  speed: 1.0,
  channelId: null,
  readChannelIds: [],
  announceVoiceState: true,
  readAuthorName: "off",
  maxLength: 50,
};

// 読み上げ対象chの解決。空配列は「制限なし(全ch)」を意味する。
// readChannelIds(管理者の明示指定) > channelId(/join が書く従来キー) の優先順。
export function getReadChannelIds(guildId) {
  const s = getGuildSettings(guildId);
  if (Array.isArray(s.readChannelIds) && s.readChannelIds.length > 0) {
    return s.readChannelIds;
  }
  return s.channelId ? [s.channelId] : [];
}
```

`getGuildSettings()` が `{ ...DEFAULT_SETTINGS, ...stored }` を返す実装なので、
**既存の JSON に新キーが無くても自動で既定値が入る**。マイグレーション用の書き換え処理は不要。

### 6.3 `src/textProcessor.js`

- `MAX_LENGTH` を関数内で解決する：

```js
const DEFAULT_MAX_LENGTH = 50;
function resolveMaxLength(guildId) {
  const v = getGuildSettings(guildId).maxLength;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MAX_LENGTH;
  return Math.min(200, Math.max(10, Math.trunc(v)));
}
```

- 発言者名の整形はここに置く（辞書適用と文字数制御は textProcessor の責務）：

```js
const AUTHOR_NAME_MAX = 20;
export function formatAuthorName(member, user, guildId) { /* displayName → 辞書 → 20字カット */ }
```

- `buildSpeech()` のシグネチャは変えない。名前の前置は呼び出し側（`index.js`）で行う。
  「本文の整形」と「誰の発言として読むか」を混ぜないため。

### 6.4 `src/index.js`

対象ch判定：

```js
const targets = getReadChannelIds(message.guild.id);
if (targets.length > 0 && !targets.includes(message.channelId)) return;
```

発言者名（`changed` 判定用の状態はモジュールスコープの Map）：

```js
// guildId -> { channelId, userId, at }  発言者名 "changed" 判定用。
// 再起動で消えるが、影響は再開後の最初の1発言に名前が付くだけなので永続化しない。
const lastSpeaker = new Map();
const AUTHOR_NAME_RESET_MS = 5 * 60_000;
```

- 効果音トリガー（`SOUND_TRIGGERS`）には名前を前置しない。ここも `lastSpeaker` は更新しない。
- 名前を前置したときのみ `lastSpeaker` を更新する…のではなく、**`off` 以外の設定では TTS を積むたびに更新する**。
  そうしないと `changed` で毎回名前が付いてしまう。

参加/退出読み上げ：

```js
if (botChannelId && getGuildSettings(guildId).announceVoiceState) { /* 既存の cameIn/wentOut */ }
```

自動参加・自動退出のロジック自体には触らない（`announceVoiceState` は**読み上げのON/OFFのみ**）。

### 6.5 実装順序

1. `store.js` の設定追加 + `getReadChannelIds()`（この時点では挙動不変。AC-1/7/9/15 を先に確認）
2. `textProcessor.js` の `maxLength` 対応（AC-15〜18）
3. `index.js` の対象ch判定差し替え（AC-1〜5）
4. `index.js` の参加退出ガード + 発言者名（AC-7〜14）
5. `commands/config.js` 追加 + `commands/index.js` 登録 → `docker compose run --rm bot npm run deploy`（AC-19〜22）
6. `README.md` / `CLAUDE.md` 更新

コミットは意図単位で分ける（1〜2 / 3〜4 / 5 / 6）。

### 6.6 CLAUDE.md に反映すべき前提の変化

- 「`MAX_LENGTH` (現在 50 文字)」→ ギルド設定 `maxLength`（既定50、10〜200でクランプ）に変わる
- 読み上げ対象chが単一 `channelId` 前提でなくなる（解決規則を追記）
- VC参加/退出の読み上げが常時ONでなくなる
- `data/guildSettings.json` のスキーマにキーが4つ増える

### 6.7 リスクと対策

| リスク | 対策 |
|---|---|
| `readChannelIds` に消えたchのIDが残り、どのchも読まれなくなる | `/config show` で解決できないIDは `(削除済み: <id>)` と表示し、`channels remove` で消せるようにする |
| `changed` 判定の Map がギルド数ぶん増え続ける | キーはギルドIDのみ・値は3フィールドなので上限はギルド数。掃除しない |
| 発言者名で読み上げが長くなりキューが詰まる | 名前を20字で切る。`maxLength` は本文にのみ適用（仕様どおり） |
| `/config set` の3オプション同時指定で片方だけ保存される | `updateGuildSettings()` に**1回の patch でまとめて渡す**（保存も1回） |
