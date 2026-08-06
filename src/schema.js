// data/*.json のスキーマ検証。
//
// load() は JSON の構文しか見ていなかったため、valid JSON でありさえすれば
// root が null / 配列とオブジェクトの取り違え / null 要素 / 範囲外の数値でも
// そのまま採用されていた。store.js の各 getter は正しい shape を前提に
// スプレッド・property access・filter を行うので、壊れた1件が MessageCreate の
// 処理中に TypeError となり、プロセスが落ちれば同じファイルを読み直す
// compose restart がそのままクラッシュループになる。
//
// 各 sanitize* は { value, repaired } を返す。repaired が true のとき、
// store.js は元ファイルを .corrupt-<timestamp> へ退避してから復旧後の内容を書き戻す
// (退避しないと次回の save で証拠ごと消える)。

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 数値。NaN / Infinity / 範囲外 / (integer 指定時の) 小数は「無効」として undefined。
// 無効値をクランプせず落とすのは、読み出し側が既定値を当てるほうが
// 「壊れた値がそれらしい値として居座る」より原因を追いやすいため。
function num(value, { min, max, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (integer && !Number.isInteger(value)) return undefined;
  if (min !== undefined && value < min) return undefined;
  if (max !== undefined && value > max) return undefined;
  return value;
}

function str(value, { maxLength = 200 } = {}) {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > maxLength) return undefined;
  return value;
}

// Discord のスノーフレークID。数値縛りにはしない (テスト用の短いIDも通したい)。
function id(value) {
  return str(value, { maxLength: 30 });
}

function bool(value) {
  return typeof value === "boolean" ? value : undefined;
}

function oneOf(value, allowed) {
  return allowed.includes(value) ? value : undefined;
}

function strList(value, max) {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set();
  for (const item of value) {
    const s = id(item);
    if (s !== undefined) seen.add(s);
  }
  return [...seen].slice(0, max);
}

// 既知キーだけを検証し、無効なものは落とす。未知キーはそのまま残す
// (どこからも参照されず害が無い一方、消すと古いバージョンへ戻したとき設定が失われるため)。
function sanitizeEntry(entry, rules) {
  const result = { ...entry };
  let repaired = false;
  for (const [key, check] of Object.entries(rules)) {
    if (!Object.hasOwn(result, key)) continue;
    const checked = check(result[key]);
    if (checked === undefined) {
      delete result[key];
      repaired = true;
    } else if (Array.isArray(checked) && Array.isArray(result[key])) {
      // 配列は要素を落としている可能性があるので長さで判定する
      if (checked.length !== result[key].length) repaired = true;
      result[key] = checked;
    } else {
      result[key] = checked;
    }
  }
  return { value: result, repaired };
}

// guildId / userId をキーに持つオブジェクトを一律に処理する。
// entry が object でないギルドは丸ごと落とす (spread した瞬間に壊れるため)。
function sanitizeKeyedObject(raw, sanitizeValue) {
  if (!isPlainObject(raw)) return { value: {}, repaired: raw !== undefined };
  const value = {};
  let repaired = false;
  for (const [key, entry] of Object.entries(raw)) {
    const result = sanitizeValue(entry);
    if (result === null) {
      repaired = true;
      continue;
    }
    if (result.repaired) repaired = true;
    value[key] = result.value;
  }
  return { value, repaired };
}

const GUILD_SETTING_RULES = {
  speaker: (v) => num(v, { min: 0, integer: true }),
  speed: (v) => num(v, { min: 0.5, max: 2.0 }),
  // null は「読み上げ元未設定」を表す正当な保存値 (/leave が書く)
  channelId: (v) => (v === null ? null : id(v)),
  readChannelIds: (v) => strList(v, 10),
  announceVoiceState: bool,
  readAuthorName: (v) => oneOf(v, ["off", "changed", "always"]),
  maxLength: (v) => num(v, { min: 10, max: 200, integer: true }),
  fishDailyBytes: (v) => num(v, { min: 0, integer: true }),
};

export function sanitizeGuildSettings(raw) {
  return sanitizeKeyedObject(raw, (entry) =>
    isPlainObject(entry) ? sanitizeEntry(entry, GUILD_SETTING_RULES) : null
  );
}

const USER_SETTING_RULES = {
  speaker: (v) => num(v, { min: 0, integer: true }),
  // 自動割り当ての結果を凍結したもの。speaker (ユーザーが /voice で選んだ値) とは
  // 別に持つ。混ぜると /voice show が「自動割り当て」を「設定済み」と表示し、
  // /voice reset で戻すべき状態が分からなくなる。
  autoSpeaker: (v) => num(v, { min: 0, integer: true }),
  speed: (v) => num(v, { min: 0.5, max: 2.0 }),
  pitch: (v) => num(v, { min: -0.15, max: 0.15 }),
  intonation: (v) => num(v, { min: 0, max: 2.0 }),
  engine: (v) => oneOf(v, ["voicevox", "fish"]),
  fishRef: (v) => str(v, { maxLength: 100 }),
  fishEmotion: (v) => str(v, { maxLength: 32 }),
  mute: bool,
};

export function sanitizeUserSettings(raw) {
  return sanitizeKeyedObject(raw, (entry) => {
    if (!isPlainObject(entry)) return null;
    const result = sanitizeEntry(entry, USER_SETTING_RULES);
    // 全キーが無効だったエントリは残さない (getUserSettings が {} を返すと
    // 「設定済み」に見えてしまう)
    if (Object.keys(result.value).length === 0) return null;
    return result;
  });
}

export function sanitizeDictionary(raw) {
  return sanitizeKeyedObject(raw, (entries) => {
    if (!Array.isArray(entries)) return null;
    const value = entries.filter(
      (e) =>
        isPlainObject(e) &&
        str(e.word, { maxLength: 100 }) !== undefined &&
        str(e.reading, { maxLength: 200 }) !== undefined
    );
    return { value, repaired: value.length !== entries.length };
  });
}

export function sanitizeIgnore(raw) {
  return sanitizeKeyedObject(raw, (entry) =>
    isPlainObject(entry)
      ? sanitizeEntry(entry, {
          users: (v) => strList(v, 100),
          prefixes: (v) => {
            if (!Array.isArray(v)) return undefined;
            return v.filter((p) => str(p, { maxLength: 100 }) !== undefined);
          },
          readBots: bool,
        })
      : null
  );
}

export function sanitizeFishVoices(raw) {
  return sanitizeKeyedObject(raw, (entry) => {
    if (!isPlainObject(entry)) return null;
    if (
      str(entry.name, { maxLength: 100 }) === undefined ||
      str(entry.referenceId, { maxLength: 100 }) === undefined
    ) {
      return null;
    }
    return { value: { name: entry.name, referenceId: entry.referenceId }, repaired: false };
  });
}

// VOICEVOX ユーザー辞書だけは root が配列。
// 欠けた要素は engine への再投入 (importUserDict) で必ず失敗するので落とす。
export function sanitizeUserDict(raw) {
  if (!Array.isArray(raw)) return { value: [], repaired: raw !== undefined };
  const value = raw.filter(
    (e) =>
      isPlainObject(e) &&
      str(e.uuid, { maxLength: 64 }) !== undefined &&
      str(e.word, { maxLength: 100 }) !== undefined &&
      str(e.reading, { maxLength: 200 }) !== undefined &&
      num(e.accent, { min: 0, integer: true }) !== undefined
  );
  return { value, repaired: value.length !== raw.length };
}
