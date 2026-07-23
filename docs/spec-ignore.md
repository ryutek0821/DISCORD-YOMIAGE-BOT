# 仕様書: `/ignore` — 読み上げ除外フィルタ

- 状態: 実装済み (2026-07-23)
- 関連: [feature-ideas.md](feature-ideas.md) の候補D / [spec-config.md](spec-config.md)

## 1. 背景と目的

現状 `MessageCreate` の入口判定は次の1行しかない（`src/index.js:121`）。

```js
if (!message.guild || message.author.bot) return;
```

そのため、

- 他Botの通知（音楽Botの再生ログ等）を**読ませたくても読めない / 読ませたくない選択もできない**（一律無視）
- 他Bot向けのコマンド（`;play`、`!rank` など）が全部読み上げられてしまう
- 「自分の発言は読まなくていい」「このユーザーの発言は読まなくていい」が実現できない

**目的**: 読み上げたくない発言を、Bot を再起動せずにサーバー管理者と各ユーザーが除外できる状態にする。

## 2. スコープ

### やること

- ギルド単位の除外: ユーザー / プレフィックス / 他Botの読み上げ可否
- 個人単位の除外: 自分の発言（と自分の参加・退出通知）を読み上げない
- それらを操作する `/ignore` コマンド
- `MessageCreate` の判定パイプラインの整理（[spec-config.md](spec-config.md) の対象ch判定と統合）

### やらないこと

- 正規表現・ワイルドカードによる除外（誤爆と ReDoS のリスクに見合わない）
- 「このchだけ除外」（対象chの指定は `/config channels` の領分）
- 語句の伏せ字化・置換（それは `/dict replace` の領分）
- 除外理由のログ/監査

## 3. データ設計

### 3.1 ギルド単位: `data/ignore.json`（新規）

```json
{
  "<guildId>": {
    "users": ["<userId>", "..."],
    "prefixes": [";", "!"],
    "readBots": false
  }
}
```

- ファイルを分けるのは `dictionary.json` と同じ方針（**機能単位で1ファイル**）。
  `guildSettings.json` は「ギルド単位のスカラー設定」、`ignore.json` は「除外リスト」と役割を分ける。
- `readBots` はスカラーだが、意味的に除外フィルタなのでこちら側に置く。
- 保存は既存 `store.js` の `save()`（`.tmp` → `rename`）に乗せる。
- ファイルが無い場合の fallback は `{}`。

上限:

| 項目 | 上限 | 超過時 |
|---|---|---|
| `users` | 100 件 / ギルド | 追加を拒否しメッセージを返す |
| `prefixes` | 20 件 / ギルド | 同上 |
| プレフィックス長 | 1〜10 文字 | 追加を拒否 |

### 3.2 個人単位: `data/userSettings.json`（既存を拡張）

```json
{ "<userId>": { "speaker": 3, "mute": true } }
```

- `mute: true` で自分の発言を読み上げない。
- **全サーバー共通**。既存の `userSettings`（`/voice` の設定）が全サーバー共通なので粒度を揃える。
  「このサーバーだけミュート」は今回は非対応（必要になったら `ignore.json` 側にユーザー登録すればサーバー単位で同じことができる）。
- `/voice reset` は `clearUserSettings()` でエントリごと消すため `mute` も消える。
  これは意図した挙動とし、`/voice reset` の応答文に注記を入れる。

## 4. 読み上げ判定パイプライン（統合後）

`/config` と `/ignore` の両方が `MessageCreate` に手を入れるため、**判定順序をここで確定する**。
両 spec 実装後の `MessageCreate` は次の順に評価する（上ほど安く、上ほど無条件）。

| # | 判定 | 該当時 | 由来 |
|---|---|---|---|
| 1 | `!message.guild` | 無視 | 既存 |
| 2 | `message.author.id === client.user.id` | **常に無視** | 新規（ループ防止。`readBots` でも解除されない） |
| 3 | `message.author.bot && !readBots` | 無視 | `/ignore bots` |
| 4 | `getSession(guildId)` が無い | 無視 | 既存 |
| 5 | 対象ch外（`getReadChannelIds()`） | 無視 | `/config channels` |
| 6 | `ignore.users` に発言者が含まれる | 無視 | `/ignore user` |
| 7 | 発言者の `userSettings.mute === true` | 無視 | `/ignore me` |
| 8 | 本文が `ignore.prefixes` のいずれかで始まる | 無視 | `/ignore prefix` |
| 9 | 効果音トリガーに完全一致 | WAV再生して終了 | 既存 |
| 10 | `buildSpeech()` の結果が空 | 無視 | 既存 |
| 11 | — | 発言者名を前置して `enqueue()` | `/config read_author_name` |

- **除外フィルタ(6〜8)は効果音トリガー(9)より前**。除外したユーザーが効果音を鳴らせてしまうのを防ぐ。
- プレフィックス判定は `message.content.trimStart()` に対して行う（**整形前の生テキスト**）。
  `buildSpeech()` はコードブロックやURLを置換してしまうため、置換後だと `` `;play` `` のような入力を取りこぼす。
- プレフィックス比較は大文字小文字を区別しない（`!Rank` と `!rank` を同一視）。

### VoiceStateUpdate 側

参加/退出の読み上げは、次をすべて満たすときだけ行う。

- `announceVoiceState`（`/config`）が true
- 対象メンバーが `ignore.users` に含まれない
- 対象メンバーの `userSettings.mute` が true でない

「自分の発言を読まないでほしい人」は自分の入退室も読まれたくない、という想定。
**自動参加・自動退出そのものの判定は変更しない**（除外ユーザーも VC の在室者としてカウントする）。

## 5. コマンド仕様

```
/ignore user   target:<user> action:<add|remove>     # 要 サーバー管理
/ignore prefix value:<string> action:<add|remove>    # 要 サーバー管理
/ignore bots   read:<bool>                           # 要 サーバー管理
/ignore me     mute:<bool>                           # 誰でも（自分の設定）
/ignore list                                         # 誰でも
```

- サブコマンドはフラット。応答はすべて ephemeral。VOICEVOX を呼ばないので `deferReply` 不要。
- 権限チェックは `dict.js` と同様に `PermissionFlagsBits.ManageGuild`。`me` と `list` は全員可。
- `action` は必須の choice（`追加` / `削除`）。
- `/ignore user` の対象に **Bot 自身を指定されたら拒否**する（`readBots` と役割が重複し混乱するため）。
- `/ignore list` の出力:
  - ユーザーは `<@id>` 形式で表示し、`allowedMentions: { parse: [] }` を付けて**通知を飛ばさない**。
  - 件数が多いときは 1900 字で分割して `followUp`（`dict.js` の `replyLines()` と同じ扱い）。
  - 自分の `mute` 状態も併記する。

### 入力バリデーション（prefix）

| 条件 | 応答 |
|---|---|
| 空文字・空白のみ | `プレフィックスに空白のみは指定できません。` |
| 11文字以上 | `プレフィックスは10文字までです。` |
| 既に登録済み | `「;」は既に登録されています。` |
| 上限20件 | `登録できるプレフィックスは20件までです。` |

## 6. 受け入れ条件

すべて手動確認。`docker compose logs -f bot` を見ながら実施する。

### 既存挙動の非破壊

- [ ] AC-1: 何も設定していないサーバーで、従来どおり人間の発言だけが読み上げられ、他Botの発言は読まれない
- [ ] AC-2: 何も設定していないサーバーで、参加/退出の読み上げが従来どおり動く

### ユーザー除外

- [ ] AC-3: `/ignore user target:@A action:追加` → A の発言が読み上げられない。他の人の発言は読まれる
- [ ] AC-4: A が VC に入退室しても `〇〇が参加しました` が読まれない
- [ ] AC-5: A が効果音トリガー（`やりますねぇ！`）を投稿しても効果音が鳴らない
- [ ] AC-6: `action:削除` で A の読み上げが復活する
- [ ] AC-7: Bot 自身を `target` に指定すると拒否される
- [ ] AC-8: 101人目の追加が拒否される

### プレフィックス除外

- [ ] AC-9: `/ignore prefix value:; action:追加` → `;play xxx` が読み上げられない
- [ ] AC-10: `あ;play` のように途中に含まれる場合は**読み上げられる**（前方一致のみ）
- [ ] AC-11: 先頭に空白がある ` ;play` も除外される（`trimStart` 後に判定）
- [ ] AC-12: `` `;play` ``（インラインコード）も除外される（整形前の生テキストで判定）
- [ ] AC-13: `!Rank` は `!rank` 登録で除外される（大文字小文字を区別しない）
- [ ] AC-14: 空白のみ / 11文字以上 / 重複 / 21件目 がそれぞれ適切なメッセージで拒否される

### Bot発言の読み上げ

- [ ] AC-15: `/ignore bots read:true` → 他Botの発言が読み上げられる
- [ ] AC-16: AC-15 の状態でも**この Bot 自身の発言は読み上げられない**（無限ループが起きない）
- [ ] AC-17: AC-15 の状態で他Botが連投しても `MAX_QUEUE`(100) で頭打ちになり、Bot が落ちない
- [ ] AC-18: `read:false` に戻すと他Botの発言が読まれなくなる

### 個人ミュート

- [ ] AC-19: `/ignore me mute:true` → **すべてのサーバーで**自分の発言が読み上げられない
- [ ] AC-20: 自分の入退室も読み上げられない
- [ ] AC-21: `mute:false` で復活する
- [ ] AC-22: `/voice reset` を実行すると `mute` も解除され、その旨が応答に書かれている

### コマンド・永続化

- [ ] AC-23: サーバー管理権限の無いユーザーは `user` / `prefix` / `bots` を実行できない。`me` / `list` は誰でも実行できる
- [ ] AC-24: `/ignore list` がユーザー・プレフィックス・`readBots`・自分の `mute` をすべて表示し、**メンション通知が飛ばない**
- [ ] AC-25: 100件登録した状態の `/ignore list` が 2000 字制限で失敗せず、分割して表示される
- [ ] AC-26: Bot 再起動後も設定が保持される（`data/ignore.json` / `data/userSettings.json`）
- [ ] AC-27: `data/ignore.json` が存在しない状態から起動しても落ちない（初回起動）
- [ ] AC-28: `data/ignore.json` を壊した状態で起動すると、警告ログを出して空設定で起動する（`load()` の既存挙動）

## 7. 実装方針

### 7.1 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/store.js` | `ignore.json` の load/save、`getIgnore()` / `addIgnoreUser()` / `removeIgnoreUser()` / `addIgnorePrefix()` / `removeIgnorePrefix()` / `setReadBots()` を追加 |
| `src/index.js` | `MessageCreate` を §4 のパイプラインに整理。`VoiceStateUpdate` の読み上げ条件を追加 |
| `src/commands/ignore.js` | **新規**。`/ignore` 本体 |
| `src/commands/replyLines.js` | **新規**。`dict.js` の `replyLines()` を切り出して共有 |
| `src/commands/dict.js` | `replyLines()` を新モジュールから import（挙動不変） |
| `src/commands/voice.js` | `reset` の応答文に「読み上げミュートも解除される」旨を追記 |
| `src/commands/index.js` | `ignore` を `commands` 配列に追加 |
| `README.md` / `CLAUDE.md` | コマンド一覧・設計上の前提を更新 |

### 7.2 `src/store.js`

```js
const ignorePath = join(dataDir, "ignore.json");
let ignore = load(ignorePath); // { [guildId]: { users, prefixes, readBots } }

const DEFAULT_IGNORE = { users: [], prefixes: [], readBots: false };

export function getIgnore(guildId) {
  return { ...DEFAULT_IGNORE, ...(ignore[guildId] || {}) };
}
```

- 既存の `load()` は壊れた JSON でログを出して fallback するので、AC-28 は追加実装なしで満たせる。
- 追加/削除系は「更新後の配列を返す」形にして、コマンド側で件数上限と重複を判定する。
  上限判定を store に持たせない（コマンド側でユーザー向けメッセージと一体で扱うため）。

### 7.3 判定ヘルパ

判定ロジックは `index.js` に散らさず、専用モジュールに寄せる。

```js
// src/ignoreFilter.js (新規)
// 読み上げ対象外なら true。理由は返さない (ログ不要・ホットパスのため)。
export function isIgnoredMessage(message, clientUserId) { ... }
export function isIgnoredMember(guildId, userId) { ... }  // VoiceStateUpdate 用
```

- `isIgnoredMessage()` は §4 の 2・3・6・7・8 を担当する。
  4(セッション)・5(対象ch) はセッション状態と `/config` の責務なので `index.js` に残す。
- プレフィックス判定は `content.trimStart().toLowerCase()` と `prefix.toLowerCase()` の `startsWith`。
  登録は入力そのまま保存し、比較時に小文字化する（`list` で見たとき登録した形のまま見えるように）。

### 7.4 `src/index.js`

```js
client.on(Events.MessageCreate, async (message) => {
  if (!message.guild) return;
  if (message.author.id === client.user.id) return; // 自分の発言は常に無視 (ループ防止)
  if (isIgnoredMessage(message, client.user.id)) return;
  const session = getSession(message.guild.id);
  if (!session) return;
  // ... 対象ch判定 → 効果音 → buildSpeech → enqueue
});
```

`client.user.id` の判定を `isIgnoredMessage()` の中にも入れて**二重に守る**
（呼び出し順を将来入れ替えられてもループしないようにする）。

### 7.5 実装順序

1. `store.js` に `ignore.json` の読み書きを追加（挙動不変。AC-27/28 を確認）
2. `ignoreFilter.js` + `index.js` のパイプライン整理（AC-1〜2 の非破壊確認を先に行う）
3. `commands/replyLines.js` 切り出し + `dict.js` の差し替え（AC: `/dict list` が従来どおり動くこと）
4. `commands/ignore.js` 追加 + 登録 → `docker compose run --rm bot npm run deploy`
5. `voice.js` の文言追記
6. `README.md` / `CLAUDE.md` 更新

`/config`（[spec-config.md](spec-config.md)）と併せて実装する場合は、
**spec-config の 1〜4 → 本 spec の 1〜2 の順**で `index.js` に入れると、パイプラインの手戻りが無い。

### 7.6 CLAUDE.md に反映すべき前提の変化

- `MessageCreate` の入口が「`author.bot` なら無視」だけではなくなる（§4 のパイプラインを追記）
- 永続化ファイルに `data/ignore.json` が増える
- `userSettings.json` に `mute` キーが増え、`/voice reset` がそれも消すこと
- 効果音トリガーが除外フィルタの**後段**にあること

### 7.7 リスクと対策

| リスク | 対策 |
|---|---|
| `readBots:true` で読み上げBot同士が反応し合い無限ループ | 自Bot(`client.user.id`)を無条件除外（2箇所で二重に判定）。`MAX_QUEUE`(100) が最終的な歯止め。コマンドの応答文にも警告を入れる |
| プレフィックス除外で普通の会話まで消える（例: `!` を登録） | `list` で常に確認できるようにし、`remove` を用意。既定は空 |
| `MessageCreate` ごとの配列走査が増える | ユーザー100件・プレフィックス20件が上限。`users` は `includes` で十分（実測が必要な規模ではない） |
| 除外ユーザーが VC に1人だけ残ると自動退出しない | 仕様どおり（在室判定は変更しない）。`docs` にも明記済み |
| `/dict list` のリファクタで既存の分割ロジックが壊れる | `replyLines()` は**そのまま移動するだけ**。ロジックに手を入れない |
