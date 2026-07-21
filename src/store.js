import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logError } from "./log.js";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const settingsPath = join(dataDir, "guildSettings.json");
const dictPath = join(dataDir, "dictionary.json");
const userSettingsPath = join(dataDir, "userSettings.json");
const userDictPath = join(dataDir, "userDict.json");

const DEFAULT_SETTINGS = { speaker: 3, speed: 1.0, channelId: null };

function load(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // 黙って fallback に落ちると設定が消えたことに気付けないので必ずログに残す
    logError(`${path} を読めなかったため既定値で起動します`, err);
    return fallback;
  }
}

function ensureDir() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

let settings = load(settingsPath); // { [guildId]: { speaker, speed, channelId } }
let dictionary = load(dictPath); // { [guildId]: [{ word, reading }] }
let userSettings = load(userSettingsPath); // 全サーバー共通 { [userId]: { speaker?, speed? } }
let userDict = load(userDictPath, []); // 全サーバー共通 [{ uuid, word, reading, accent }] (VOICEVOX ユーザー辞書)

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
  return { ...DEFAULT_SETTINGS, ...(settings[guildId] || {}) };
}

export function updateGuildSettings(guildId, patch) {
  settings[guildId] = { ...getGuildSettings(guildId), ...patch };
  save(settingsPath, settings);
  return settings[guildId];
}

export function getDictionary(guildId) {
  return dictionary[guildId] || [];
}

export function addDictionaryEntry(guildId, word, reading) {
  const list = getDictionary(guildId).filter((e) => e.word !== word);
  list.push({ word, reading });
  dictionary[guildId] = list;
  save(dictPath, dictionary);
}

export function removeDictionaryEntry(guildId, word) {
  const before = getDictionary(guildId);
  const after = before.filter((e) => e.word !== word);
  dictionary[guildId] = after;
  save(dictPath, dictionary);
  return before.length !== after.length;
}

// 個人の話者設定 (全サーバー共通、userId 単位)。未設定なら null。
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
