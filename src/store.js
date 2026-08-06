import {
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sanitizeGuildSettings,
  sanitizeUserSettings,
  sanitizeDictionary,
  sanitizeIgnore,
  sanitizeFishVoices,
  sanitizeUserDict,
} from "./schema.js";
import { logError } from "./log.js";

// 既定はリポジトリ直下の data/。テストが本番データを踏まないよう env で差し替えられる
// (Docker 運用では data/ をホストにボリュームマウントするため未設定のままでよい)。
const dataDir =
  process.env.YOMIAGE_DATA_DIR ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const settingsPath = join(dataDir, "guildSettings.json");
const dictPath = join(dataDir, "dictionary.json");
const userSettingsPath = join(dataDir, "userSettings.json");
const userDictPath = join(dataDir, "userDict.json");
const ignorePath = join(dataDir, "ignore.json");
const fishVoicesPath = join(dataDir, "fishVoices.json");

const DEFAULT_SETTINGS = {
  speaker: 3,
  speed: 1.0,
  channelId: null,
  readChannelIds: [],
  announceVoiceState: true,
  readAuthorName: "off",
  maxLength: 50,
  // Fish Audio は従量課金 ($15 / 1M UTF-8 bytes) なので暴走防止の日次上限を持つ。
  // 日本語 3 バイト/字・maxLength 50 字なら 1 発言 ≒ 150 バイト → 約 330 発言/日。
  // 0 は無制限。
  fishDailyBytes: 50000,
};
const DEFAULT_IGNORE = { users: [], prefixes: [], readBots: false };

// 組み込みの Fish Audio ボイス。ユーザー登録分より前に置いてマージするので常に存在する。
const BUILTIN_FISH_VOICES = {
  yaju: { name: "野獣先輩", referenceId: "0042f795e8744feba27460ce426d1500" },
};

// 壊れたファイルを退避してから復旧後の内容で上書きする。退避しないと
// 次回の save で元の内容が消え、何が壊れていたのか調べる材料が無くなる。
function quarantine(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${path}.corrupt-${stamp}`;
  try {
    copyFileSync(path, dest);
    console.warn(`${path} を ${dest} に退避しました`);
  } catch (err) {
    logError(`${path} の退避に失敗しました`, err);
  }
}

// JSON の構文だけでなく shape も検証する。valid JSON でありさえすれば
// root が null でも配列とオブジェクトが入れ替わっていても素通りしていたため、
// 壊れた1件が読み上げ処理中の TypeError になり得た。
function load(path, sanitize, fallback = {}) {
  if (!existsSync(path)) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // 黙って fallback に落ちると設定が消えたことに気付けないので必ずログに残す
    logError(`${path} を読めなかったため既定値で起動します`, err);
    quarantine(path);
    return fallback;
  }
  const { value, repaired } = sanitize(parsed);
  if (repaired) {
    logError(`${path} に不正なデータがあったため除去しました`, null);
    quarantine(path);
    save(path, value);
  }
  return value;
}

function ensureDir() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

let settings = load(settingsPath, sanitizeGuildSettings); // ギルド単位の読み上げ設定
let dictionary = load(dictPath, sanitizeDictionary); // { [guildId]: [{ word, reading }] }
let userSettings = load(userSettingsPath, sanitizeUserSettings); // 全サーバー共通 { [userId]: { speaker?, autoSpeaker?, speed?, pitch?, intonation?, engine?, fishRef?, fishEmotion?, mute? } }
let userDict = load(userDictPath, sanitizeUserDict, []); // 全サーバー共通 [{ uuid, word, reading, accent }] (VOICEVOX ユーザー辞書)
let ignore = load(ignorePath, sanitizeIgnore); // { [guildId]: { users, prefixes, readBots } }
let fishVoices = load(fishVoicesPath, sanitizeFishVoices); // 全サーバー共通 { [alias]: { name, referenceId } }

// #47: updateGuildSettings が既定値を実体化して保存していた分を起動時に落とす。
// 残したままだと DEFAULT_SETTINGS を変えても「一度でも /join や /config を実行した
// ギルドだけ古い既定値のまま」という差が出て、/config show を見ても理由が分からない。
pruneDefaultGuildSettings();

function pruneDefaultGuildSettings() {
  let changed = false;
  for (const [guildId, entry] of Object.entries(settings)) {
    for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
      if (!Object.hasOwn(entry, key)) continue;
      if (JSON.stringify(entry[key]) !== JSON.stringify(defaultValue)) continue;
      delete entry[key];
      changed = true;
    }
    if (Object.keys(entry).length === 0) {
      delete settings[guildId];
      changed = true;
    }
  }
  if (changed) save(settingsPath, settings);
}

// 直接上書きすると書き込み途中の停止で JSON が壊れ、次回起動時に load() が
// 黙って fallback に落ちて設定が丸ごと消える。一時ファイルへ書いてから
// 同一ディレクトリ内で rename することで、壊れた中間状態を残さない。
function save(path, obj) {
  ensureDir();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

export function getGuildSettings(guildId) {
  // スプレッドは浅いコピーなので、そのままだと readChannelIds の配列参照が
  // DEFAULT_SETTINGS と共有され、呼び出し側が push した瞬間に全ギルドの既定値が汚れる。
  // 配列だけは必ず複製して返す。
  return {
    ...DEFAULT_SETTINGS,
    readChannelIds: [...DEFAULT_SETTINGS.readChannelIds],
    ...(settings[guildId] || {}),
  };
}

// ベースは「保存済みの生の値」であって既定値マージ後の値ではない。
// getGuildSettings() をベースにすると patch に含まれないキーまで既定値のスナップショットと
// してファイルに焼き付き、あとで DEFAULT_SETTINGS を変えても保存済みギルドだけ
// 古い既定値のまま取り残される。既定値の適用は読み出し側に一本化する。
export function updateGuildSettings(guildId, patch) {
  settings[guildId] = { ...(settings[guildId] || {}), ...patch };
  save(settingsPath, settings);
  return getGuildSettings(guildId);
}

// /config reset が既定値へ戻すキー。保存済みの値を消すだけにして、
// DEFAULT_SETTINGS のハードコード重複を作らない。
// channelId (/join が決めた読み上げ元) と speaker / speed は /config の管轄外なので残す
// (channelId まで消すと読み上げ対象が「全チャンネル」に広がってしまう)。
const CONFIG_MANAGED_KEYS = [
  "readChannelIds",
  "announceVoiceState",
  "readAuthorName",
  "maxLength",
  "fishDailyBytes",
];

export function resetGuildSettings(guildId) {
  const current = settings[guildId];
  if (current) {
    for (const key of CONFIG_MANAGED_KEYS) delete current[key];
    if (Object.keys(current).length === 0) delete settings[guildId];
    save(settingsPath, settings);
  }
  return getGuildSettings(guildId);
}

// 管理者が明示した複数chを優先し、未指定なら従来の /join 用 channelId に戻る。
// 空配列は「チャンネル制限なし」を表す。
export function getReadChannelIds(guildId) {
  const current = getGuildSettings(guildId);
  if (Array.isArray(current.readChannelIds) && current.readChannelIds.length > 0) {
    return current.readChannelIds;
  }
  return current.channelId ? [current.channelId] : [];
}

export function getDictionary(guildId) {
  return dictionary[guildId] || [];
}

// 置換辞書のギルドあたり上限。/ignore の users(100) / prefixes(20) と違い辞書には
// 上限が無く、1エントリ reading 200 字と組み合わせると読み上げ整形の中間文字列が
// 際限なく膨らむ。追加できなかったことは呼び出し側に返して伝える。
const DICTIONARY_MAX_ENTRIES = 200;

export function addDictionaryEntry(guildId, word, reading) {
  const list = getDictionary(guildId).filter((e) => e.word !== word);
  if (list.length >= DICTIONARY_MAX_ENTRIES) return false;
  list.push({ word, reading });
  dictionary[guildId] = list;
  save(dictPath, dictionary);
  return true;
}

export { DICTIONARY_MAX_ENTRIES };

export function removeDictionaryEntry(guildId, word) {
  const before = getDictionary(guildId);
  const after = before.filter((e) => e.word !== word);
  dictionary[guildId] = after;
  save(dictPath, dictionary);
  return before.length !== after.length;
}

// 個人の声・ミュート設定 (全サーバー共通、userId 単位)。未設定なら null。
export function getUserSettings(userId) {
  return userSettings[userId] || null;
}

export function updateUserSettings(userId, patch) {
  userSettings[userId] = { ...(userSettings[userId] || {}), ...patch };
  save(userSettingsPath, userSettings);
  return userSettings[userId];
}

export function clearUserSettings(userId) {
  if (!userSettings[userId]) return false;
  delete userSettings[userId];
  save(userSettingsPath, userSettings);
  return true;
}

export function getIgnore(guildId) {
  const current = ignore[guildId] || {};
  return {
    ...DEFAULT_IGNORE,
    ...current,
    users: Array.isArray(current.users) ? current.users : [],
    prefixes: Array.isArray(current.prefixes) ? current.prefixes : [],
  };
}

function updateIgnore(guildId, patch) {
  ignore[guildId] = { ...getIgnore(guildId), ...patch };
  save(ignorePath, ignore);
  return ignore[guildId];
}

export function addIgnoreUser(guildId, userId) {
  const users = [...getIgnore(guildId).users, userId];
  updateIgnore(guildId, { users });
  return users;
}

export function removeIgnoreUser(guildId, userId) {
  const users = getIgnore(guildId).users.filter((id) => id !== userId);
  updateIgnore(guildId, { users });
  return users;
}

export function addIgnorePrefix(guildId, prefix) {
  const prefixes = [...getIgnore(guildId).prefixes, prefix];
  updateIgnore(guildId, { prefixes });
  return prefixes;
}

export function removeIgnorePrefix(guildId, prefix) {
  const normalized = prefix.toLowerCase();
  const prefixes = getIgnore(guildId).prefixes.filter(
    (value) => value.toLowerCase() !== normalized
  );
  updateIgnore(guildId, { prefixes });
  return prefixes;
}

export function setReadBots(guildId, readBots) {
  return updateIgnore(guildId, { readBots });
}

// VOICEVOX ユーザー辞書 (単語+読みの正式登録)。全サーバー共通、guildId では分けない。
export function getUserDict() {
  return userDict;
}

// uuid は VOICEVOX 側が発行したものをそのまま保存する (コンテナ再作成後の復元に使うため)
export function addUserDictEntry(word, reading, accent, uuid) {
  const list = getUserDict().filter((e) => e.word !== word);
  list.push({ word, reading, accent, uuid });
  userDict = list;
  save(userDictPath, userDict);
  return userDict;
}

// 削除したエントリ (uuid を含む) を返す。エンジン側の削除は呼び出し側の責務。
export function removeUserDictEntry(word) {
  const before = getUserDict();
  const entry = before.find((e) => e.word === word) ?? null;
  userDict = before.filter((e) => e.word !== word);
  save(userDictPath, userDict);
  return entry;
}

// --- Fish Audio ボイス (全サーバー共通、alias -> { name, referenceId }) ---

// 組み込みプリセットは常に含める。同じ alias をユーザーが登録した場合はそちらを優先する。
export function getFishVoices() {
  return { ...BUILTIN_FISH_VOICES, ...fishVoices };
}

export function isBuiltinFishVoice(alias) {
  return Object.hasOwn(BUILTIN_FISH_VOICES, alias);
}

export function addFishVoice(alias, name, referenceId) {
  fishVoices[alias] = { name, referenceId };
  save(fishVoicesPath, fishVoices);
  return fishVoices[alias];
}

export function removeFishVoice(alias) {
  if (!Object.hasOwn(fishVoices, alias)) return false;
  delete fishVoices[alias];
  save(fishVoicesPath, fishVoices);
  return true;
}
