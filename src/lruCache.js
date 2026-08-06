// 挿入順 Map を使った簡易 LRU。件数上限に加えて合計バイト数の上限も掛けられる。
// TTS エンジンごとに別インスタンスを持たせる想定 (キー空間が混ざらないようにするため)。
//
// このモジュールは他の src を import しない (純粋なまま保つ)。ログを出したい呼び出し側
// (voicevox.js / fishAudio.js) が set() の戻り値を見て自分でログを出す。

// 既定のサイズ計測。Buffer ならそのバイト数、それ以外は byteLength を試みて
// 数値化できないものは 0 扱い (サイズ計測できない値でキャッシュ自体を壊さないため)。
function defaultSizeOf(value) {
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value?.byteLength === "number") return value.byteLength;
  return 0;
}

export function createLruCache(
  max,
  { maxBytes = Infinity, maxEntryBytes = Infinity, sizeOf = defaultSizeOf } = {}
) {
  const cache = new Map(); // key -> { value, size }
  let bytes = 0;
  let evictions = 0;
  let skipped = 0;

  function evictOne() {
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    bytes -= oldest.size;
    evictions++;
  }

  return {
    get(key) {
      if (!cache.has(key)) return null;
      const entry = cache.get(key);
      cache.delete(key);
      cache.set(key, entry); // 使われたものを最新扱いにする
      return entry.value;
    },
    set(key, value) {
      const size = sizeOf(value);
      // 1件で予算を食い潰すエントリはそもそも載せない (残り全部を即座に追い出すだけになるため)。
      if (size > maxEntryBytes) {
        skipped++;
        return false;
      }
      const existing = cache.get(key);
      if (existing) bytes -= existing.size;
      cache.delete(key);
      cache.set(key, { value, size });
      bytes += size;
      while (cache.size > max || bytes > maxBytes) {
        evictOne();
      }
      return true;
    },
    clear() {
      cache.clear();
      bytes = 0;
    },
    stats() {
      return { entries: cache.size, bytes, evictions, skipped };
    },
  };
}

// WAV_CACHE_MAX_MB (既定 64) から { maxBytes, maxEntryBytes } を作る。
// 単一エントリの上限は予算の 1/8 — 1件で予算のほとんどを食い潰すと、他の会話の
// キャッシュがほぼ機能しなくなるため。不正値・0以下は既定値に倒す。
export function wavCacheLimits(rawMb = process.env.WAV_CACHE_MAX_MB, defaultMb = 64) {
  const parsed = Number(rawMb);
  const mb = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMb;
  const maxBytes = mb * 1024 * 1024;
  return { maxBytes, maxEntryBytes: Math.floor(maxBytes / 8) };
}
