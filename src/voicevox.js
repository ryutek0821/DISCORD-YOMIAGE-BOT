import { log, logError } from "./log.js";
import { createLruCache, wavCacheLimits } from "./lruCache.js";

const BASE_URL = process.env.VOICEVOX_URL || "http://localhost:50021";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 一時的な不通に耐えるための短いリトライ (200ms -> 400ms backoff)。
// 4xx (リクエスト自体の問題) はリトライしても無駄なので即座に諦める。
const RETRY_BACKOFF_MS = [200, 400];

// Engine が TCP は生きたまま応答を返さなくなると fetch は永久に待つ。
// そうなると drain() が playing=true のまま止まり、そのギルドのキューが二度と流れないため、
// 必ず上限を設ける (CPU 合成が遅い環境でも足りるよう長めに取る)。
const REQUEST_TIMEOUT_MS = 30_000;

// 読み上げ本文は /audio_query の text、ユーザー辞書の語は /user_dict_word の
// surface / pronunciation として **クエリ文字列に乗る**。エラーメッセージにパスを
// そのまま埋めると、Engine が一時的に落ちるたびに Discord の発言本文が
// URL エンコードされた形でコンテナの標準出力に残り続ける。
// log.js も store.js も本文を残さない設計なので、ここだけ抜けているのは筋が悪い。
const LOGGABLE_QUERY_KEYS = new Set([
  "speaker",
  "accent_type",
  "priority",
  "override",
]);

// 調査用に生のパスを出したいときだけ有効化する
const DEBUG_LOG_TEXT = process.env.DEBUG_LOG_TEXT === "1";

// HTTP status を持つエラー。呼び出し側が「入力の誤り (4xx)」と
// 「Engine の障害 (timeout / 接続失敗 / 5xx)」を区別できるようにするためのもの。
// タイムアウトや接続失敗は status を持たない素の Error のまま投げる。
export class VoicevoxHttpError extends Error {
  constructor(message, { status, detail }) {
    super(message);
    this.name = "VoicevoxHttpError";
    this.status = status;
    // detail は console.error(err) で丸ごと出力されうるので、
    // extractValidationMessage() が通した固定文言しか入れない (下記参照)。
    if (detail) this.detail = detail;
  }
}

export function isInputError(err) {
  return err?.status >= 400 && err.status < 500;
}

// pydantic の 422 detail は
//   `Value error, <説明>。 [type=value_error, input_value='<入力そのもの>', ...]`
// という形で、input_value に**辞書の語や読み上げ本文がそのまま入る**。
// ここでは `Value error,` と `[type=` に挟まれた説明だけを取り出し、入力値は捨てる。
// パターンに一致しない応答からは何も取り出さない (未知の本文を
// エラーオブジェクトに載せると、それを console.error したときに本文が漏れるため)。
const VALIDATION_MESSAGE_RE = /Value error,\s*(.+?)\s*\[type=/g;
const VALIDATION_MESSAGE_MAX = 200;

export function extractValidationMessage(bodyText) {
  if (!bodyText) return undefined;
  let detail;
  try {
    detail = JSON.parse(bodyText)?.detail;
  } catch {
    return undefined;
  }
  // detail は文字列 (VOICEVOX が整形したもの) と
  // 配列 ([{ msg, loc }]、FastAPI 既定の形) のどちらもありうる
  const texts =
    typeof detail === "string"
      ? [detail]
      : Array.isArray(detail)
        ? detail.map((d) => (typeof d?.msg === "string" ? d.msg : ""))
        : [];
  const found = [];
  for (const text of texts) {
    for (const m of text.matchAll(VALIDATION_MESSAGE_RE)) {
      found.push(m[1].replace(/\s+/g, " ").trim());
    }
  }
  if (found.length === 0) return undefined;
  return found.join(" / ").slice(0, VALIDATION_MESSAGE_MAX);
}

export function safePath(path) {
  if (DEBUG_LOG_TEXT) return path;
  const at = path.indexOf("?");
  if (at === -1) return path;
  const base = path.slice(0, at);
  const parts = [];
  for (const [key, value] of new URLSearchParams(path.slice(at + 1))) {
    parts.push(
      LOGGABLE_QUERY_KEYS.has(key)
        ? `${key}=${value}`
        : `${key}=<redacted:${[...value].length}文字>`
    );
  }
  return parts.length > 0 ? `${base}?${parts.join("&")}` : base;
}

async function request(
  path,
  {
    method = "GET",
    body,
    headers,
    retry = true,
    timeoutMs = REQUEST_TIMEOUT_MS,
    // リクエストボディに本文由来のデータが乗る場合 (合成クエリ・辞書の一括投入)。
    // FastAPI の 422 はリクエスト内容をそのまま返すため、レスポンス本文も伏せる。
    sensitiveBody = false,
  } = {}
) {
  const logPath = safePath(path);
  const hideResponseBody = sensitiveBody || logPath !== path;
  const backoffs = retry ? RETRY_BACKOFF_MS : [];
  const maxAttempts = 1 + backoffs.length;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        body,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      // 本文は伏せる場合でも読み出す。ユーザーへ返す入力エラーの説明を
      // extractValidationMessage() で取り出すのに要る (取り出せるのは固定文言だけ)。
      const bodyText = await res.text().catch(() => "");
      const text = hideResponseBody
        ? "(応答本文は伏せています。DEBUG_LOG_TEXT=1 で表示)"
        : bodyText;
      lastErr = new VoicevoxHttpError(
        `VOICEVOX ${method} ${logPath} -> ${res.status} ${text}`,
        { status: res.status, detail: extractValidationMessage(bodyText) }
      );
      if (res.status < 500) break; // クライアントエラーはリトライ対象外
    } catch (err) {
      lastErr = err;
      // タイムアウトした = Engine が応答不能。同じ待ち時間で再試行しても無駄に
      // キューを止めるだけなので即座に諦める (リトライすると最大3倍待たされる)。
      if (err?.name === "TimeoutError") break;
    }
    if (attempt < maxAttempts) {
      logError(
        `VOICEVOX ${method} ${logPath} に失敗、${backoffs[attempt - 1]}ms後にリトライ (${attempt}/${maxAttempts})`,
        lastErr
      );
      await sleep(backoffs[attempt - 1]);
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
// cache miss 中に同時に呼ばれた分をまとめて1つの fetch に相乗りさせるための Promise。
// これが無いと、Engine 停止中に同時発言があった数だけ /speakers を叩き、
// それぞれがリトライも抱えるためリトライ嵐になる。
let speakerIdsInFlight = null;
// 直近の失敗時刻。この間は fetch 自体を発行せず即座に諦める (クールダウン)。
let speakerIdsFailedAt = 0;
const SPEAKER_IDS_COOLDOWN_MS = 10_000;

// 有効な話者(スタイル)IDの一覧。初回取得後はメモリにキャッシュする。
export async function getSpeakerIds() {
  if (speakerIdsCache) return speakerIdsCache;
  if (speakerIdsInFlight) return speakerIdsInFlight;
  if (Date.now() - speakerIdsFailedAt < SPEAKER_IDS_COOLDOWN_MS) {
    throw new Error(
      "直前に失敗したため話者一覧の取得を控えています (クールダウン中)"
    );
  }
  speakerIdsInFlight = (async () => {
    try {
      const speakers = await getSpeakers();
      speakerIdsCache = speakers.flatMap((sp) => sp.styles.map((st) => st.id));
      speakerIdsFailedAt = 0; // 成功したのでクールダウンは解除
      return speakerIdsCache;
    } catch (err) {
      speakerIdsFailedAt = Date.now();
      throw err;
    } finally {
      speakerIdsInFlight = null;
    }
  })();
  return speakerIdsInFlight;
}

// 同一条件のテキストを再合成しないための WAV キャッシュ。
// 他エンジン (Fish Audio) とは別インスタンスにして、キー空間が混ざらないようにする。
// 件数(100)に加えて合計バイト数にも上限を掛ける (非圧縮 WAV は長文・低速ほど大きく、
// 件数だけの上限だと数百MB常駐しうるため)。
const wavCache = createLruCache(100, wavCacheLimits()); // key -> Buffer

// キャッシュに載らないほど大きい WAV が出た警告は、プロセスで1回だけ出す
// (毎回出すと Engine 不通時の警告と同じくログが埋まるため)。
let warnedCacheOversize = false;
function warnCacheOversizeOnce(byteLength) {
  if (warnedCacheOversize) return;
  warnedCacheOversize = true;
  log(
    `合成した音声が大きすぎてWAVキャッシュに載りません (${Math.round(byteLength / 1024)}KB)。` +
      `WAV_CACHE_MAX_MB を上げるか maxLength を下げてください`
  );
}

// ユーザー辞書を変えると同じ文でも読みが変わるため、キャッシュ済みの WAV は
// もう使えない。キーは speaker/速度/pitch/抑揚/text だけなので、世代を持たないと
// LRU から追い出されるか Bot 再起動まで旧発音が返り続ける (頻出文ほど直らない)。
//
// 世代が追うのは **Engine 側の辞書の状態** なので、Engine を変更する関数
// (add/update/delete/import) の成功直後に上げる。実際には変わっていない場合
// (DELETE の 404 等) に上げてもキャッシュを捨てるだけで害は無い。
let userDictRevision = 0;

export function bumpUserDictRevision() {
  userDictRevision++;
  wavCache.clear();
}

// テキストを WAV (Buffer) に合成する
export async function synth(
  text,
  speaker,
  { speedScale = 1.0, pitchScale = 0.0, intonationScale = 1.0 } = {}
) {
  // 合成開始時点の世代。clear() だけでは、辞書変更の**前に**始まった合成が
  // 変更後に完了して旧発音の WAV を新世代へ入れ直す race が残る。
  const revision = userDictRevision;
  const cacheKey = `${speaker}:${speedScale}:${pitchScale}:${intonationScale}:${text}`;
  const cached = wavCache.get(cacheKey);
  if (cached) return cached;

  const queryRes = await request(
    // 孤立サロゲートが混ざると encodeURIComponent が URIError を投げ、その発言が
    // 丸ごと捨てられる。整形側でも防いでいるが、ここでも最後に均しておく。
    // 手書きの /[\uD800-\uDFFF]/ は正常なペアまで壊すので toWellFormed を使う。
    `/audio_query?text=${encodeURIComponent(text.toWellFormed())}&speaker=${speaker}`,
    { method: "POST" }
  );
  const query = await queryRes.json();
  query.speedScale = speedScale;
  query.pitchScale = pitchScale;
  query.intonationScale = intonationScale;

  const synthRes = await request(`/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/wav" },
    // ボディの audio_query には本文由来の kana / moras が入る
    sensitiveBody: true,
    body: JSON.stringify(query),
  });
  const wav = Buffer.from(await synthRes.arrayBuffer());
  // 合成中に辞書が変わっていたら、この WAV は旧世代の読み。再生には使うが
  // (この発言はもう待たせている) キャッシュには載せない。
  if (revision === userDictRevision && !wavCache.set(cacheKey, wav)) {
    warnCacheOversizeOnce(wav.byteLength);
  }
  return wav;
}

export async function isAlive() {
  try {
    // 起動時の疎通確認なので短く1回だけ。落ちていることを知るのにリトライは要らない。
    await request("/version", { timeoutMs: 5_000, retry: false });
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

// --- 入力検証 (VOICEVOX 0.25.2 の user_dict/model.py と同じ規則) ---
//
// Engine 側で弾かれても 422 になるだけだが、ローカルでも同じ規則を持っておくと
// 往復を1回省けるうえ、どのオプションが悪いのかを具体的に案内できる。
// 規則が食い違ったときに困らないよう、最終的な正は常に Engine の 422 側に置く
// (ここを通っても 422 になりうるので、呼び出し側は必ず isInputError() で分岐すること)。
//
// 出典: voicevox_engine/user_dict/model.py, voicevox_engine/utility/text_utility.py
const PRONUNCIATION_RE = /^[ァ-ヴー]+$/;
const SUTEGANA = ["ァ", "ィ", "ゥ", "ェ", "ォ", "ャ", "ュ", "ョ", "ヮ", "ッ"];
const SUTEGANA_EXCEPT_SOKUON = SUTEGANA.slice(0, -1);

// 複数のカタカナで1モーラを構成するパターン + 1文字1モーラのパターン。
// アクセント型の上限がモーラ数なので、その計算に要る。
const MORA_PATTERN =
  /(?:[イ][ェ]|[ヴ][ャュョ]|[ウクグトド][ゥ]|[テデ][ィェャュョ]|[クグ][ヮ]|[キシチニヒミリギジヂビピ][ェャュョ]|[キニヒミリギビピ][ィ]|[クツフヴグ][ァ]|[ウクスツフヴグズ][ィ]|[ウクツフヴグ][ェォ]|[ァ-ヴー])/g;

export function countMora(pronunciation) {
  return pronunciation.match(MORA_PATTERN)?.length ?? 0;
}

// 問題があればユーザー向けの理由を、無ければ null を返す
export function validatePronunciation(pronunciation) {
  if (!pronunciation) return "読みが空です。";
  if (!PRONUNCIATION_RE.test(pronunciation)) {
    return "発音は有効なカタカナでなくてはいけません。(「・」「ー」以外の記号、ヵ・ヶ・ヷ〜ヺ は使えません)";
  }
  for (let i = 0; i < pronunciation.length; i++) {
    const ch = pronunciation[i];
    const next = pronunciation[i + 1];
    // 「キャット」のように捨て仮名は連続しうるので、「ッ」だけは
    // 「ッ」が連続する場合と「ッ」の後に他の捨て仮名が来る場合のみ無効とする
    if (
      SUTEGANA.includes(ch) &&
      next !== undefined &&
      (SUTEGANA_EXCEPT_SOKUON.includes(next) || (ch === "ッ" && next === "ッ"))
    ) {
      return "無効な発音です。(捨て仮名の連続)";
    }
    if (ch === "ヮ" && i !== 0 && !["ク", "グ"].includes(pronunciation[i - 1])) {
      return "無効な発音です。(「くゎ」「ぐゎ」以外の「ゎ」の使用)";
    }
  }
  return null;
}

export function validateSurface(surface) {
  if (!surface) return "語が空です。";
  if (/[\r\n]/.test(surface)) return "語に改行を含めることはできません。";
  if (surface.includes("\0")) return "語に NULL 文字を含めることはできません。";
  return null;
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
  // 単語登録は冪等ではない。5xx を返しつつ実際には登録済みというケースでリトライすると
  // 別 uuid で二重登録されてしまうため、この POST だけはリトライしない。
  const res = await request(`/user_dict_word?${qs}`, {
    method: "POST",
    retry: false,
  });
  bumpUserDictRevision();
  return res.json(); // uuid 文字列
}

// 登録済みの単語を uuid そのままで書き換える。
// 「DELETE してから POST」だと、DELETE 成功 + POST 失敗で語が消え、
// DELETE 失敗 + POST 成功で重複が残る。PUT ならその窓自体が無い。
// uuid を指定した上書きなので冪等 = 一時的な 5xx はリトライしてよい。
export async function updateUserDictWord(
  uuid,
  surface,
  pronunciation,
  accentType = 0,
  priority = 5
) {
  const qs = new URLSearchParams({
    surface,
    pronunciation,
    accent_type: String(accentType),
    priority: String(priority),
  });
  await request(`/user_dict_word/${uuid}?${qs}`, { method: "PUT" });
  bumpUserDictRevision();
}

// ユーザー辞書から単語を削除する。
// 既に存在しない (404) 場合も「消えている」という結果は同じなので成功として扱う
// — ここを失敗にすると、Engine を作り直した後に JSON 側の語を二度と消せなくなる。
export async function deleteUserDictWord(uuid) {
  try {
    await request(`/user_dict_word/${uuid}`, { method: "DELETE" });
  } catch (err) {
    if (err?.status !== 404) throw err;
  }
  bumpUserDictRevision();
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
    // ボディは辞書の語そのもの
    sensitiveBody: true,
    body: JSON.stringify(dict),
  });
  bumpUserDictRevision();
}
