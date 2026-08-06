import {
  getUserSettings,
  getGuildSettings,
  updateUserSettings,
} from "./store.js";
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

// 自動割り当ての結果を userSettings へ焼き付ける。
// 保存に失敗しても読み上げは続ける (今回は modulo の値をそのまま使い、次の発言で
// また試す)。ここで throw すると drain() がその1件を落とし、ディスクが埋まった
// ときに「特定ユーザーだけ読まれない」という分かりにくい壊れ方をするため。
function freezeAutoSpeaker(userId, speaker) {
  try {
    updateUserSettings(userId, { autoSpeaker: speaker });
  } catch (err) {
    log(`話者の自動割り当ての保存に失敗しました (user: ${userId}): ${err.message}`);
  }
}

// 発言者ごとの実効ボイスを解決する。
// - 個人設定 (/voice) があればそれを優先。
// - 話者が未設定なら userId から決定的に割り当て、結果を autoSpeaker へ凍結する
//   (engine のスタイル数/並び順が変わっても同じ人は同じ声のまま)。
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
    // 一度割り当てた声は凍結済みの値を使う。engine 側の一覧が変われば
    // ids.length も並び順も変わり、modulo の結果が総入れ替わりするため。
    speaker = s?.autoSpeaker ?? null;
    // 凍結した ID が engine から消えていたら (スタイル廃止) 割り当て直す。
    // 残したままだと合成が毎回 422 で落ちて、そのユーザーだけ永久に無音になる。
    if (speaker != null && !(await isKnownSpeaker(speaker))) speaker = null;
    if (speaker == null) {
      try {
        const ids = await getSpeakerIds();
        if (ids.length > 0) {
          speaker = ids[Number(BigInt(userId) % BigInt(ids.length))];
          freezeAutoSpeaker(userId, speaker);
        }
      } catch {
        /* VOICEVOX 不通: 下のフォールバックへ */
      }
    }
    // ギルド既定話者は凍結しない。Engine 不通の間だけの一時的な値なので、
    // 焼き付けると復旧後も全員が既定話者のままになる。
    if (speaker == null) speaker = getGuildSettings(guildId).speaker;
  } else if (!(await isKnownSpeaker(speaker))) {
    // 明示指定でも存在しない ID なら合成が毎回 422 で落ち、そのユーザーの発言が
    // 永久に無音になる。既定話者へ倒して読み上げは続け、直し方をログに残す。
    warnUnknownSpeakerOnce(userId, speaker);
    speaker = getGuildSettings(guildId).speaker;
  }

  return { engine, speaker, fishRef, fishEmotion, speed, pitch, intonation };
}
