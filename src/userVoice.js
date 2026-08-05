import { getUserSettings, getGuildSettings } from "./store.js";
import { getSpeakerIds } from "./voicevox.js";
import { log } from "./log.js";

// 話者一覧が取れないときは「知らない」と断定しない。Engine 不通のたびに
// 全ユーザーの明示指定を既定話者へ倒すと、声が総入れ替わりして混乱するため。
async function isKnownSpeaker(speaker) {
  try {
    const ids = await getSpeakerIds();
    return ids.length === 0 || ids.includes(speaker);
  } catch {
    return true;
  }
}

// 発言のたびに出すと1人の不正設定でログが埋まるので、ユーザーごとに一度だけ。
const warnedUnknownSpeakers = new Set();
function warnUnknownSpeakerOnce(userId, speaker) {
  if (warnedUnknownSpeakers.has(userId)) return;
  warnedUnknownSpeakers.add(userId);
  log(
    `話者ID ${speaker} (user: ${userId}) は存在しないため既定話者で読み上げます。/voice reset か /voice speaker: で設定し直してください`
  );
}

// 発言者ごとの実効ボイスを解決する。
// - 個人設定 (/voice) があればそれを優先。
// - 話者が未設定なら userId から決定的に割り当てる (同じ人は常に同じ声)。
// - 速度が未設定なら 1.0、声の高さ(ピッチ)は 0.0、抑揚は 1.0。
// - VOICEVOX 不通等で話者一覧が取れない時はギルド既定話者へフォールバック。
//
// engine が "fish" でも VOICEVOX の speaker は必ず解決しておく。
// Fish の日次バイト上限を超えたときのフォールバック先として tts.js が使うため。
// 自動割り当ての対象は VOICEVOX の話者のみで、Fish は明示選択したユーザーだけが使う。
//
// intonation は engine ごとに解釈が違う (VOICEVOX は intonationScale、Fish は
// temperature へ換算) ので、ここでは engine を問わず生の値を返し、翻訳は
// fishAudio.intonationToTemperature() に任せる。pitch は Fish に対応物が無く無視される。
export async function resolveUserVoice(userId, guildId) {
  const s = getUserSettings(userId);
  let speaker = s?.speaker;
  const speed = s?.speed ?? 1.0;
  const pitch = s?.pitch ?? 0.0;
  const intonation = s?.intonation ?? 1.0;
  const engine = s?.engine ?? "voicevox";
  const fishRef = s?.fishRef ?? null;
  const fishEmotion = s?.fishEmotion ?? null;

  if (speaker == null) {
    try {
      const ids = await getSpeakerIds();
      if (ids.length > 0) {
        speaker = ids[Number(BigInt(userId) % BigInt(ids.length))];
      }
    } catch {
      /* VOICEVOX 不通: 下のフォールバックへ */
    }
    if (speaker == null) speaker = getGuildSettings(guildId).speaker;
  } else if (!(await isKnownSpeaker(speaker))) {
    // 明示指定でも存在しない ID なら合成が毎回 422 で落ち、そのユーザーの発言が
    // 永久に無音になる。既定話者へ倒して読み上げは続け、直し方をログに残す。
    warnUnknownSpeakerOnce(userId, speaker);
    speaker = getGuildSettings(guildId).speaker;
  }

  return { engine, speaker, fishRef, fishEmotion, speed, pitch, intonation };
}
