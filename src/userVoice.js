import { getUserSettings, getGuildSettings } from "./store.js";
import { getSpeakerIds } from "./voicevox.js";

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
  }

  return { engine, speaker, fishRef, fishEmotion, speed, pitch, intonation };
}
