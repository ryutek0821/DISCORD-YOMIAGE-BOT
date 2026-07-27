import { log, logError } from "./log.js";
import { getGuildSettings } from "./store.js";
import { synth as voicevoxSynth } from "./voicevox.js";
import * as fishAudio from "./fishAudio.js";

// TTS エンジンの分岐点。player.js からはここだけを呼ぶ。
//
// Fish Audio はクラウドの従量課金 API なので、ここで日次バイト上限を掛ける。
// カウンタは永続化しない: 設定変更時だけ書き込む data/ と違い、毎メッセージで
// fsync するのは割に合わない。Bot 再起動でリセットされる仕様とする。
const dailyUsage = new Map(); // guildId -> { day, bytes, warned }

function today() {
  return new Date().toISOString().slice(0, 10); // UTC 基準。日付が変われば自動リセット
}

function getUsage(guildId) {
  const day = today();
  const current = dailyUsage.get(guildId);
  if (current?.day === day) return current;
  const fresh = { day, bytes: 0, warned: false };
  dailyUsage.set(guildId, fresh);
  return fresh;
}

function addUsage(guildId, bytes) {
  getUsage(guildId).bytes += bytes;
}

// 上限に収まっていれば true。0 は無制限。
function withinDailyLimit(guildId, bytes) {
  const limit = getGuildSettings(guildId).fishDailyBytes;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return true;
  return getUsage(guildId).bytes + bytes <= limit;
}

// テスト・表示用
export function getFishUsage(guildId) {
  const { day, bytes } = getUsage(guildId);
  return { day, bytes };
}

export function useFish(voice) {
  return (
    voice?.engine === "fish" && Boolean(voice.fishRef) && fishAudio.isConfigured()
  );
}

// voice = { engine, speaker, fishRef, speed, pitch, intonation }
// 返り値は WAV の Buffer。合成に失敗した場合は throw し、player.js 側でその 1 件だけ
// スキップされる (Fish の API エラー時に VOICEVOX へ勝手に切り替えたりはしない)。
export async function synthVoice(guildId, text, voice) {
  if (useFish(voice)) {
    const bytes = fishAudio.estimateBytes(text);
    if (withinDailyLimit(guildId, bytes)) {
      const wav = await fishAudio.synth(text, voice.fishRef, { speed: voice.speed });
      // 成功したぶんだけ計上する (失敗したリクエストは課金されない想定)
      addUsage(guildId, bytes);
      return wav;
    }
    // 上限超過。無音でスキップせず VOICEVOX で読み上げを継続する。
    const usage = getUsage(guildId);
    if (!usage.warned) {
      usage.warned = true;
      logError(
        `Fish Audio の日次バイト上限に達したため VOICEVOX へフォールバックします (guild: ${guildId}, ${usage.bytes}/${getGuildSettings(guildId).fishDailyBytes} bytes)`
      );
    }
  }

  return voicevoxSynth(text, voice.speaker, {
    speedScale: voice.speed,
    pitchScale: voice.pitch,
    intonationScale: voice.intonation,
  });
}

// 起動時に Fish Audio の設定状況を 1 行残す (未設定でも Bot は VOICEVOX のみで動く)
export function logFishStatus() {
  if (fishAudio.isConfigured()) {
    log(`Fish Audio: 設定あり (model=${fishAudio.getModel()})`);
  } else {
    log("Fish Audio: 未設定 (FISH_API_KEY 未指定のため VOICEVOX のみで動作します)");
  }
}
