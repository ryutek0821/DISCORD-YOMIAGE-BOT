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

// テキストを WAV (Buffer) に合成する。
// format: "wav" を指定しておくと player.js の ffmpeg 動線を VOICEVOX と共通化できる。
export async function synth(text, referenceId, { speed = 1.0 } = {}) {
  if (!isConfigured()) {
    throw new Error("FISH_API_KEY が未設定です");
  }

  const speedScale = clampSpeed(speed);
  const cacheKey = `${referenceId}:${speedScale}:${text}`;
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
      latency: "normal",
    }),
  });

  const wav = Buffer.from(await res.arrayBuffer());
  wavCache.set(cacheKey, wav);
  return wav;
}
