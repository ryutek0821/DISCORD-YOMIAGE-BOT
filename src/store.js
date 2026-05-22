import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const settingsPath = join(dataDir, "guildSettings.json");
const dictPath = join(dataDir, "dictionary.json");

const DEFAULT_SETTINGS = { speaker: 3, speed: 1.0, channelId: null };

function load(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function ensureDir() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

let settings = load(settingsPath); // { [guildId]: { speaker, speed, channelId } }
let dictionary = load(dictPath); // { [guildId]: [{ word, reading }] }

function save(path, obj) {
  ensureDir();
  writeFileSync(path, JSON.stringify(obj, null, 2));
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
