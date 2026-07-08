import { logError } from "./log.js";

const BASE_URL = process.env.VOICEVOX_URL || "http://localhost:50021";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 一時的な不通に耐えるための短いリトライ (200ms -> 400ms backoff)。
// 4xx (リクエスト自体の問題) はリトライしても無駄なので即座に諦める。
const RETRY_BACKOFF_MS = [200, 400];

async function request(path, { method = "GET", body, headers } = {}) {
  const maxAttempts = 1 + RETRY_BACKOFF_MS.length;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, { method, body, headers });
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      lastErr = new Error(`VOICEVOX ${method} ${path} -> ${res.status} ${text}`);
      if (res.status < 500) break; // クライアントエラーはリトライ対象外
    } catch (err) {
      lastErr = err;
    }
    if (attempt < maxAttempts) {
      logError(
        `VOICEVOX ${method} ${path} に失敗、${RETRY_BACKOFF_MS[attempt - 1]}ms後にリトライ (${attempt}/${maxAttempts})`,
        lastErr
      );
      await sleep(RETRY_BACKOFF_MS[attempt - 1]);
    }
  }
  throw lastErr;
}

// 話者一覧を [{ name, styles: [{ name, id }] }] の形で返す
export async function getSpeakers() {
  const res = await request("/speakers");
  return res.json();
}

let speakerIdsCache = null;
// 有効な話者(スタイル)IDの一覧。初回取得後はメモリにキャッシュする。
export async function getSpeakerIds() {
  if (speakerIdsCache) return speakerIdsCache;
  const speakers = await getSpeakers();
  speakerIdsCache = speakers.flatMap((sp) => sp.styles.map((st) => st.id));
  return speakerIdsCache;
}

// 同一条件のテキストを再合成しないための WAV キャッシュ (挿入順 Map、上限超で最古を破棄)
const wavCache = new Map(); // key -> Buffer
const WAV_CACHE_MAX = 100;

function cacheGet(key) {
  if (!wavCache.has(key)) return null;
  const value = wavCache.get(key);
  wavCache.delete(key);
  wavCache.set(key, value); // 使われたものを最新扱いにする (簡易 LRU)
  return value;
}

function cacheSet(key, value) {
  wavCache.delete(key);
  wavCache.set(key, value);
  if (wavCache.size > WAV_CACHE_MAX) {
    const oldestKey = wavCache.keys().next().value;
    wavCache.delete(oldestKey);
  }
}

// テキストを WAV (Buffer) に合成する
export async function synth(
  text,
  speaker,
  { speedScale = 1.0, pitchScale = 0.0, intonationScale = 1.0 } = {}
) {
  const cacheKey = `${speaker}:${speedScale}:${pitchScale}:${intonationScale}:${text}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const queryRes = await request(
    `/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
    { method: "POST" }
  );
  const query = await queryRes.json();
  query.speedScale = speedScale;
  query.pitchScale = pitchScale;
  query.intonationScale = intonationScale;

  const synthRes = await request(`/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/wav" },
    body: JSON.stringify(query),
  });
  const wav = Buffer.from(await synthRes.arrayBuffer());
  cacheSet(cacheKey, wav);
  return wav;
}

export async function isAlive() {
  try {
    await request("/version");
    return true;
  } catch {
    return false;
  }
}

// --- VOICEVOX ユーザー辞書 (単語+読みの正式登録、pronunciation は全角カタカナ必須) ---

// ひらがな -> 全角カタカナ変換 (ユーザーが読みをひらがなで入力しても登録できるように)
export function hiraganaToKatakana(str) {
  return str.replace(/[ぁ-ゖ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

// 全角カタカナのみで構成されているか (VOICEVOX の pronunciation 要件)
export function isKatakana(str) {
  return /^[゠-ヿ]+$/.test(str);
}

// user_dict_word 登録時の共通項目 (固有名詞・平板アクセント寄りのテンプレート)
const USER_DICT_TEMPLATE = {
  context_id: 1348,
  part_of_speech: "名詞",
  part_of_speech_detail_1: "固有名詞",
  part_of_speech_detail_2: "一般",
  part_of_speech_detail_3: "*",
  inflectional_type: "*",
  inflectional_form: "*",
  stem: "*",
  accent_associative_rule: "*",
};

// 登録済みユーザー辞書の一覧を取得 ({ [uuid]: word情報 })
export async function listUserDict() {
  const res = await request("/user_dict");
  return res.json();
}

// ユーザー辞書に単語を追加し、エンジンが発行した UUID を返す
export async function addUserDictWord(surface, pronunciation, accentType = 0, priority = 5) {
  const qs = new URLSearchParams({
    surface,
    pronunciation,
    accent_type: String(accentType),
    priority: String(priority),
  });
  const res = await request(`/user_dict_word?${qs}`, { method: "POST" });
  return res.json(); // uuid 文字列
}

// ユーザー辞書から単語を削除
export async function deleteUserDictWord(uuid) {
  await request(`/user_dict_word/${uuid}`, { method: "DELETE" });
}

// 保存済みエントリ ({ uuid, word, reading, accent }[]) をエンジンへ一括反映する。
// engine コンテナは辞書を永続化しないため、起動時に data/userDict.json から復元するのに使う。
// uuid は addUserDictWord が返したものをそのまま使う想定 (再作成時も同じ uuid で復元されるようにするため)。
export async function importUserDict(entries) {
  if (!entries || entries.length === 0) return;
  const dict = {};
  for (const e of entries) {
    dict[e.uuid] = {
      ...USER_DICT_TEMPLATE,
      surface: e.word,
      yomi: e.reading,
      pronunciation: e.reading,
      accent_type: e.accent ?? 0,
      priority: e.priority ?? 5,
    };
  }
  await request("/import_user_dict?override=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dict),
  });
}
