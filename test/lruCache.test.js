import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLruCache, wavCacheLimits } from "../src/lruCache.js";

describe("createLruCache", () => {
  test("未登録キーは null を返す", () => {
    assert.equal(createLruCache(2).get("nope"), null);
  });

  test("上限を超えたら最古を捨てる", () => {
    const c = createLruCache(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    assert.equal(c.get("a"), null);
    assert.equal(c.get("b"), 2);
    assert.equal(c.get("c"), 3);
  });

  test("get したエントリは最新扱いになり退避されない", () => {
    const c = createLruCache(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // a を touch
    c.set("c", 3); // 捨てられるのは b
    assert.equal(c.get("a"), 1);
    assert.equal(c.get("b"), null);
  });

  test("同じキーの再 set でも件数は増えない", () => {
    const c = createLruCache(2);
    c.set("a", 1);
    c.set("a", 2);
    c.set("b", 3);
    assert.equal(c.get("a"), 2);
    assert.equal(c.get("b"), 3);
  });

  test("falsy な値も保持できる", () => {
    const c = createLruCache(2);
    c.set("zero", 0);
    assert.equal(c.get("zero"), 0);
  });

  describe("重み付き (バイト上限)", () => {
    const sizeOf = (v) => v.length; // テスト用に文字列長をバイト数代わりに使う

    test("合計バイト超過で古いエントリが追い出される", () => {
      const c = createLruCache(10, { maxBytes: 10, sizeOf });
      c.set("a", "12345"); // 5 bytes
      c.set("b", "12345"); // 5 bytes, 合計10 (まだ収まる)
      c.set("c", "12345"); // 5 bytes 追加 -> 合計15、a を追い出して10に戻す
      assert.equal(c.get("a"), null);
      assert.equal(c.get("b"), "12345");
      assert.equal(c.get("c"), "12345");
    });

    test("maxEntryBytes 超えの巨大エントリはキャッシュされず set() が false を返す", () => {
      const c = createLruCache(10, { maxBytes: 100, maxEntryBytes: 5, sizeOf });
      assert.equal(c.set("small", "123"), true);
      assert.equal(c.set("big", "123456"), false);
      assert.equal(c.get("big"), null);
      assert.equal(c.get("small"), "123"); // 巨大エントリの拒否で既存分が消えていない
    });

    test("get の LRU 順更新後に正しい方が追い出される", () => {
      const c = createLruCache(10, { maxBytes: 10, sizeOf });
      c.set("a", "12345"); // 5
      c.set("b", "12345"); // 5, 合計10
      c.get("a"); // a を touch して最新扱いに
      c.set("c", "12345"); // 5 追加 -> b が最古なので b を追い出す
      assert.equal(c.get("a"), "12345");
      assert.equal(c.get("b"), null);
      assert.equal(c.get("c"), "12345");
    });

    test("stats() が entries・bytes・evictions・skipped を返す", () => {
      const c = createLruCache(10, { maxBytes: 10, maxEntryBytes: 5, sizeOf });
      assert.deepEqual(c.stats(), { entries: 0, bytes: 0, evictions: 0, skipped: 0 });
      c.set("a", "12345"); // 5 bytes
      c.set("b", "12345"); // 5 bytes, 合計10
      c.set("c", "12345"); // 追い出し発生 (a を追い出す)
      c.set("huge", "123456"); // maxEntryBytes 超過 -> skipped
      assert.deepEqual(c.stats(), { entries: 2, bytes: 10, evictions: 1, skipped: 1 });
    });

    test("既存キーの上書きは古いサイズを引いてから加える", () => {
      const c = createLruCache(10, { maxBytes: 10, sizeOf });
      c.set("a", "12345"); // 5
      c.set("a", "1234567890"); // 10 (上書き。5引いてから10足す=合計10、収まる)
      assert.equal(c.stats().bytes, 10);
      assert.equal(c.get("a"), "1234567890");
    });
  });

  describe("wavCacheLimits", () => {
    test("既定値は 64MB、単一エントリ上限はその1/8", () => {
      const { maxBytes, maxEntryBytes } = wavCacheLimits(undefined);
      assert.equal(maxBytes, 64 * 1024 * 1024);
      assert.equal(maxEntryBytes, (64 * 1024 * 1024) / 8);
    });

    test("不正値・0以下は既定値に倒す", () => {
      assert.equal(wavCacheLimits("abc").maxBytes, 64 * 1024 * 1024);
      assert.equal(wavCacheLimits("0").maxBytes, 64 * 1024 * 1024);
      assert.equal(wavCacheLimits("-5").maxBytes, 64 * 1024 * 1024);
      assert.equal(wavCacheLimits(undefined, 32).maxBytes, 32 * 1024 * 1024);
    });

    test("有効な値は MB からバイトへ変換される", () => {
      const { maxBytes, maxEntryBytes } = wavCacheLimits("16");
      assert.equal(maxBytes, 16 * 1024 * 1024);
      assert.equal(maxEntryBytes, (16 * 1024 * 1024) / 8);
    });
  });
});
