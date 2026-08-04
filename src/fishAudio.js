import { logError } from "./log.js";
import { createLruCache } from "./lruCache.js";

// Fish Audio (https://fish.audio) の TTS API クライアント。
// VOICEVOX と違いクラウドの従量課金 API なので、呼び出し前に日次バイト上限を
// 掛ける想定 (tts.js 側で実施)。
const API_URL = process.env.FISH_API_URL || "https://api.fish.audio";
const API_KEY = process.env.FISH_API_KEY || "";

// s2.1-pro-free は 2026-08-31 まで無料 (SLA なし・リクエストがモデル改善に使われる)。
// 期限後や本番運用では .env で s2.1-pro / s2-pro / s1 に切り替える。
const MODEL = process.env.FISH_MODEL || "s2.1-pro-free";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// voicevox.js と同じ方針: 一時的な不通/5xx にだけ短くリトライし、4xx は即諦める。
// Fish 側の 401(キー不正) / 402(未払い) / 422(ボディ不正) はいずれも 4xx なので
// 自動的にリトライ対象から外れる。
const RETRY_BACKOFF_MS = [200, 400];

// VOICEVOX の 30 秒より短くする。あちらはローカル CPU 合成が遅い前提の値だが、
// クラウド API が 15 秒応答を返さないのは障害であって、待ってもキューを止めるだけ。
const REQUEST_TIMEOUT_MS = 15_000;

export function isConfigured() {
  return API_KEY.length > 0;
}

export function getModel() {
  return MODEL;
}

// 課金は UTF-8 バイト数ベース ($15 / 1M bytes)。上限判定にも同じ数え方を使う。
export function estimateBytes(text) {
  return Buffer.byteLength(text, "utf8");
}

export function isReferenceId(value) {
  return /^[0-9a-f]{32}$/.test(value);
}

// fish.audio のモデルURL (https://fish.audio/ja/m/<id>) か生の reference_id から
// ID を取り出す。見つからなければ null。
export function parseReferenceId(input) {
  const raw = String(input ?? "").trim();
  const fromUrl = raw.match(/\/m\/([0-9a-fA-F]{32})/);
  if (fromUrl) return fromUrl[1].toLowerCase();
  if (/^[0-9a-fA-F]{32}$/.test(raw)) return raw.toLowerCase();
  return null;
}

async function request(path, { method = "POST", body, headers } = {}) {
  const maxAttempts = 1 + RETRY_BACKOFF_MS.length;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method,
        body,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          ...headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      lastErr = new Error(`Fish Audio ${method} ${path} -> ${res.status} ${text}`);
      lastErr.status = res.status; // 呼び出し側が 404 とそれ以外を区別できるように
      if (res.status < 500) break; // 401/402/422 等はリトライしても同じ
    } catch (err) {
      lastErr = err;
      if (err?.name === "TimeoutError") break;
    }
    if (attempt < maxAttempts) {
      logError(
        `Fish Audio ${method} ${path} に失敗、${RETRY_BACKOFF_MS[attempt - 1]}ms後にリトライ (${attempt}/${maxAttempts})`,
        lastErr
      );
      await sleep(RETRY_BACKOFF_MS[attempt - 1]);
    }
  }
  throw lastErr;
}

// モデル情報を引く。存在しなければ null、通信不能などは throw。
// 他人のアカウントのモデルでも public / unlist なら取得できる。
export async function getModelInfo(referenceId) {
  try {
    const res = await request(`/model/${referenceId}`, { method: "GET" });
    const m = await res.json();
    return {
      title: m.title ?? "",
      visibility: m.visibility ?? "",
      author: m.author?.nickname ?? "",
      languages: m.languages ?? [],
    };
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

const wavCache = createLruCache(100); // key -> Buffer

function clampSpeed(speed) {
  if (typeof speed !== "number" || !Number.isFinite(speed)) return 1.0;
  return Math.min(2.0, Math.max(0.5, speed));
}

// 非数値なら null を返し、呼び出し側が temperature 自体を送らないようにする。
function clampTemperature(temperature) {
  if (typeof temperature !== "number" || !Number.isFinite(temperature)) return null;
  return Math.min(1.0, Math.max(0.1, temperature));
}

// VOICEVOX の intonation (0.0〜2.0、既定1.0) を Fish の temperature (0.1〜1.0、既定0.7)
// に翻訳する。/voice のつまみを engine ごとに増やさないための換算で、この知識は
// Fish 側の都合なのでここに閉じる。
//
// 単純な線形換算 (intonation/2*0.9+0.1) にすると既定値 1.0 が 0.55 に落ちて、
// 何も設定していない既存ユーザーの声が黙って平坦になってしまう。1.0 が Fish 既定の
// 0.7 に一致する折れ線にして非回帰を守る。
export function intonationToTemperature(intonation) {
  if (typeof intonation !== "number" || !Number.isFinite(intonation)) return null;
  const v = Math.min(2.0, Math.max(0.0, intonation));
  const temperature = v <= 1.0 ? 0.1 + v * 0.6 : 0.7 + (v - 1.0) * 0.3;
  // 折れ線の計算で 0.7000000000000001 のような値になるとキャッシュキーが濁るので丸める
  return Math.round(temperature * 1000) / 1000;
}

// 感情タグ (`[happy]` 等) を解釈するのは S2 系モデルのみ。s1 に付けると
// 「かくかっこハッピー」のように literal に読まれてしまうため判定して外す。
export function supportsEmotion() {
  return MODEL.startsWith("s2");
}

// 本文の先頭に感情タグを付ける。tts.js から呼ぶ:
// synth の中でこっそり付けると、tts.js が課金バイトをタグ抜きで数えてしまい
// 日次上限の判定がずれる (タグ分も UTF-8 バイトとして課金される)。
export function applyEmotion(text, emotion) {
  if (!emotion || !supportsEmotion()) return text;
  return `[${emotion}] ${text}`;
}

// テキストを WAV (Buffer) に合成する。
// format: "wav" を指定しておくと player.js の ffmpeg 動線を VOICEVOX と共通化できる。
export async function synth(text, referenceId, { speed = 1.0, temperature } = {}) {
  if (!isConfigured()) {
    throw new Error("FISH_API_KEY が未設定です");
  }

  const speedScale = clampSpeed(speed);
  const temp = clampTemperature(temperature);
  const cacheKey = `${referenceId}:${speedScale}:${temp ?? "d"}:${text}`;
  const cached = wavCache.get(cacheKey);
  if (cached) return cached;

  const res = await request("/v1/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      model: MODEL,
    },
    body: JSON.stringify({
      text,
      reference_id: referenceId,
      format: "wav",
      prosody: { speed: speedScale },
      // 未指定のときはフィールド自体を送らず Fish の既定 (0.7) に任せる
      ...(temp === null ? {} : { temperature: temp }),
      latency: "normal",
    }),
  });

  const wav = Buffer.from(await res.arrayBuffer());
  wavCache.set(cacheKey, wav);
  return wav;
}
