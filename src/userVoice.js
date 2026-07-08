import { getUserSettings, getGuildSettings } from "./store.js";
import { getSpeakerIds } from "./voicevox.js";

// 発言者ごとの実効ボイスを解決する。
// - 個人設定 (/voice) があればそれを優先。
// - 話者が未設定なら userId から決定的に割り当てる (同じ人は常に同じ声)。
// - 速度が未設定なら 1.0、声の高さ(ピッチ)は 0.0、抑揚は 1.0。
// - VOICEVOX 不通等で話者一覧が取れない時はギルド既定話者へフォールバック。
export async function resolveUserVoice(userId, guildId) {
  const s = getUserSettings(userId);
  let speaker = s?.speaker;
  const speed = s?.speed ?? 1.0;
  const pitch = s?.pitch ?? 0.0;
  const intonation = s?.intonation ?? 1.0;

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

  return { speaker, speed, pitch, intonation };
}
