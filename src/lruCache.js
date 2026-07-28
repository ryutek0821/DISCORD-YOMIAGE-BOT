// 挿入順 Map を使った簡易 LRU。上限を超えたら最古のエントリを捨てる。
// TTS エンジンごとに別インスタンスを持たせる想定 (キー空間が混ざらないようにするため)。
export function createLruCache(max) {
  const cache = new Map();

  return {
    get(key) {
      if (!cache.has(key)) return null;
      const value = cache.get(key);
      cache.delete(key);
      cache.set(key, value); // 使われたものを最新扱いにする
      return value;
    },
    set(key, value) {
      cache.delete(key);
      cache.set(key, value);
      if (cache.size > max) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
      }
    },
  };
}
