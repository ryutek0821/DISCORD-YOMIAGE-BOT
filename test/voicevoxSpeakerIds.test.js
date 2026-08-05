// getSpeakerIds() はモジュールレベルの in-flight Promise / クールダウン状態を持つため、
// 他のテストと同じファイルで動かすと状態が汚染される。node:test はファイルごとに
// 別プロセスで走るので、ファイルを分けるのがまずキャッシュを確実にリセットする手段になる。
//
// さらにこのファイル内でも「成功後は永久にキャッシュを返す」「失敗後は10秒クールダウン」という
// 状態が各シナリオ間で共有されると干渉してしまうため、シナリオごとに ?case=n というクエリ付き
// specifier で動的 import し、モジュールインスタンスそのものを分けて独立させる。
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, stubFetch, jsonResponse } from "./helpers.js";

useTempDataDir();

const SPEAKERS = [
  { name: "四国めたん", styles: [{ name: "ノーマル", id: 2 }, { name: "あまあま", id: 0 }] },
  { name: "ずんだもん", styles: [{ name: "ノーマル", id: 3 }] },
];

let stub;
afterEach(() => stub?.restore());

describe("getSpeakerIds の single-flight とクールダウン", () => {
  test("同時に50回呼んでも /speakers の fetch は1回だけ", async () => {
    const voicevox = await import("../src/voicevox.js?case=concurrent");
    let resolveFetch;
    const gate = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    stub = stubFetch(async () => {
      await gate; // 全呼び出しが揃うまで応答を遅らせ、確実に競合させる
      return jsonResponse(SPEAKERS);
    });

    const calls = Array.from({ length: 50 }, () => voicevox.getSpeakerIds());
    // 呼び出しが積み上がるのを待ってから応答を返す
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveFetch();
    const results = await Promise.all(calls);

    assert.equal(stub.calls.length, 1, "同時呼び出しは1つの fetch に相乗りする");
    for (const r of results) {
      assert.deepEqual(r, [2, 0, 3]);
    }
  });

  test("失敗後のクールダウン中は fetch せず throw する", async () => {
    const voicevox = await import("../src/voicevox.js?case=cooldown");
    stub = stubFetch(() => jsonResponse({ detail: "boom" }, 500));
    await assert.rejects(() => voicevox.getSpeakerIds());
    const callsAfterFailure = stub.calls.length;
    assert.ok(callsAfterFailure > 0);

    // クールダウン中に呼んでも fetch は増えない
    await assert.rejects(
      () => voicevox.getSpeakerIds(),
      /直前に失敗したため/
    );
    assert.equal(stub.calls.length, callsAfterFailure, "クールダウン中は fetch しない");
  });

  test("成功後はクールダウンが解除され、キャッシュを返して fetch しない", async () => {
    const voicevox = await import("../src/voicevox.js?case=success");
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    const ids = await voicevox.getSpeakerIds();
    assert.deepEqual(ids, [2, 0, 3]);
    const before = stub.calls.length;

    const idsAgain = await voicevox.getSpeakerIds();
    assert.deepEqual(idsAgain, [2, 0, 3]);
    assert.equal(stub.calls.length, before, "成功後はキャッシュを返すので fetch しない");
  });
});
