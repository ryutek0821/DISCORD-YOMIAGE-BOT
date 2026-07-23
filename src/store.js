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
const ignorePath = join(dataDir, "ignore.json");

const DEFAULT_SETTINGS = {
  speaker: 3,
  speed: 1.0,
  channelId: null,
  readChannelIds: [],
  announceVoiceState: true,
  readAuthorName: "off",
  maxLength: 50,
};
const DEFAULT_IGNORE = { users: [], prefixes: [], readBots: false };

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

let settings = load(settingsPath); // ギルド単位の読み上げ設定
let dictionary = load(dictPath); // { [guildId]: [{ word, reading }] }
let userSettings = load(userSettingsPath); // 全サーバー共通 { [userId]: { speaker?, speed?, pitch?, intonation?, mute? } }
let userDict = load(userDictPath, []); // 全サーバー共通 [{ uuid, word, reading, accent }] (VOICEVOX ユーザー辞書)
let ignore = load(ignorePath); // { [guildId]: { users, prefixes, readBots } }

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
