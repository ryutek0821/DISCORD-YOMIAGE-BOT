import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, stubFetch, jsonResponse, binaryResponse } from "./helpers.js";

useTempDataDir();
const voicevox = await import("../src/voicevox.js");

const SPEAKERS = [
  { name: "四国めたん", styles: [{ name: "ノーマル", id: 2 }, { name: "あまあま", id: 0 }] },
  { name: "ずんだもん", styles: [{ name: "ノーマル", id: 3 }] },
];

let stub;
afterEach(() => stub?.restore());

describe("getSpeakerIds", () => {
  test("全スタイルの id を平坦化し、2回目はキャッシュを返す", async () => {
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    assert.deepEqual(await voicevox.getSpeakerIds(), [2, 0, 3]);
    assert.deepEqual(await voicevox.getSpeakerIds(), [2, 0, 3]);
    assert.equal(stub.calls.length, 1, "2回目は fetch しない");
  });
});

describe("request のリトライ方針", () => {
  test("5xx は backoff してリトライする (最大3回)", async () => {
    stub = stubFetch(() => jsonResponse({ detail: "boom" }, 500));
    await assert.rejects(() => voicevox.getSpeakers(), /500/);
    assert.equal(stub.calls.length, 3);
  });

  test("4xx はリトライせず即諦める", async () => {
    stub = stubFetch(() => jsonResponse({ detail: "bad" }, 422));
    await assert.rejects(() => voicevox.getSpeakers(), /422/);
    assert.equal(stub.calls.length, 1);
  });

  test("TimeoutError はリトライしない (キューを止める時間を延ばさない)", async () => {
    stub = stubFetch(() => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    });
    await assert.rejects(() => voicevox.getSpeakers(), /timed out/);
    assert.equal(stub.calls.length, 1);
  });

  test("1回目が 5xx でも2回目に成功すれば値を返す", async () => {
    stub = stubFetch((_url, _init, n) =>
      n === 1 ? jsonResponse({}, 503) : jsonResponse(SPEAKERS)
    );
    assert.equal((await voicevox.getSpeakers()).length, 2);
    assert.equal(stub.calls.length, 2);
  });
});

describe("isAlive", () => {
  test("/version が返れば true、落ちていれば false", async () => {
    stub = stubFetch(() => jsonResponse({ version: "0.20.0" }));
    assert.equal(await voicevox.isAlive(), true);
    stub.restore();

    stub = stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    assert.equal(await voicevox.isAlive(), false);
  });
});

describe("synth の WAV キャッシュ", () => {
  const wav = Buffer.from("RIFF----WAVEfake");

  test("同一条件の再合成は fetch を発行しない", async () => {
    stub = stubFetch((url) =>
      url.includes("/audio_query")
        ? jsonResponse({ speedScale: 1, pitchScale: 0, intonationScale: 1 })
        : binaryResponse(wav)
    );
    const a = await voicevox.synth("キャッシュ確認", 3);
    const before = stub.calls.length;
    const b = await voicevox.synth("キャッシュ確認", 3);
    assert.equal(stub.calls.length, before, "2回目は fetch しない");
    assert.deepEqual(Buffer.from(a), Buffer.from(b));
  });

  test("パラメータが違えば別キーとして再合成する", async () => {
    stub = stubFetch((url) =>
      url.includes("/audio_query")
        ? jsonResponse({ speedScale: 1, pitchScale: 0, intonationScale: 1 })
        : binaryResponse(wav)
    );
    await voicevox.synth("パラメータ確認", 3, { speedScale: 1.0 });
    const before = stub.calls.length;
    await voicevox.synth("パラメータ確認", 3, { speedScale: 1.5 });
    assert.ok(stub.calls.length > before, "speed が違えば再合成する");
  });
});
