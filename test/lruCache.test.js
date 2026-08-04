import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLruCache } from "../src/lruCache.js";

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
});
