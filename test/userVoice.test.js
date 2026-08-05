import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, stubFetch, jsonResponse } from "./helpers.js";

useTempDataDir({
  "guildSettings.json": { g1: { speaker: 7 } },
  "userSettings.json": {
    // 個人設定あり (VOICEVOX)
    // pitch は /voice の許容範囲 (-0.15〜0.15) 内の値を使う。範囲外はスキーマ検証が落とす
    100: { speaker: 11, speed: 1.5, pitch: 0.1, intonation: 0.5 },
    // Fish を明示指定したユーザー
    200: { engine: "fish", fishRef: "f".repeat(32), fishEmotion: "happy" },
  },
});

const { resolveUserVoice } = await import("../src/userVoice.js");

const SPEAKERS = [{ name: "s", styles: [{ id: 2 }, { id: 3 }, { id: 5 }] }];

let stub;
afterEach(() => stub?.restore());

describe("個人設定の優先", () => {
  test("/voice の設定をそのまま返す", async () => {
    const v = await resolveUserVoice("100", "g1");
    assert.deepEqual(v, {
      engine: "voicevox",
      speaker: 11,
      fishRef: null,
      fishEmotion: null,
      speed: 1.5,
      pitch: 0.1,
      intonation: 0.5,
    });
  });

  test("個人設定があれば VOICEVOX へ問い合わせない", async () => {
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    await resolveUserVoice("100", "g1");
    assert.equal(stub.calls.length, 0);
  });
});

describe("未設定ユーザーの自動割り当て", () => {
  test("userId から決定論的に決まる (同じ人は常に同じ声)", async () => {
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    const a = await resolveUserVoice("12345678901234567", "g1");
    const b = await resolveUserVoice("12345678901234567", "g1");
    assert.equal(a.speaker, b.speaker);
    // 12345678901234567 % 3 === 1 -> ids[1] === 3
    assert.equal(a.speaker, 3);
  });

  test("速度・pitch・intonation は既定値になる", async () => {
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    const v = await resolveUserVoice("12345678901234567", "g1");
    assert.equal(v.speed, 1.0);
    assert.equal(v.pitch, 0.0);
    assert.equal(v.intonation, 1.0);
    assert.equal(v.engine, "voicevox");
  });
});

describe("Fish 指定ユーザー", () => {
  test("engine=fish でも VOICEVOX の speaker を必ず解決する", async () => {
    // 日次バイト上限を超えたときのフォールバック先として tts.js が使うため
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    const v = await resolveUserVoice("200", "g1");
    assert.equal(v.engine, "fish");
    assert.equal(v.fishRef, "f".repeat(32));
    assert.equal(v.fishEmotion, "happy");
    assert.equal(typeof v.speaker, "number");
    assert.notEqual(v.speaker, null);
  });
});
