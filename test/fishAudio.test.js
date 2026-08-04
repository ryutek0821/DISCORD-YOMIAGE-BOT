import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir } from "./helpers.js";

useTempDataDir();
// supportsEmotion() は import 時の FISH_MODEL を見るので、先に S2 系を明示しておく
process.env.FISH_MODEL = "s2.1-pro-free";
const fish = await import("../src/fishAudio.js");

describe("intonationToTemperature", () => {
  test("VOICEVOX 既定 1.0 は Fish 既定 0.7 に一致する (非回帰の要)", () => {
    assert.equal(fish.intonationToTemperature(1.0), 0.7);
  });

  test("両端は 0.1 / 1.0 に張り付く", () => {
    assert.equal(fish.intonationToTemperature(0), 0.1);
    assert.equal(fish.intonationToTemperature(2.0), 1.0);
  });

  test("折れ線なので中間は単調増加する", () => {
    const xs = [0, 0.5, 1.0, 1.5, 2.0].map(fish.intonationToTemperature);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], `${xs}`);
  });

  test("レンジ外はクランプする", () => {
    assert.equal(fish.intonationToTemperature(-5), 0.1);
    assert.equal(fish.intonationToTemperature(99), 1.0);
  });

  test("数値でなければ null (temperature を送らない = Fish 既定に任せる)", () => {
    assert.equal(fish.intonationToTemperature(undefined), null);
    assert.equal(fish.intonationToTemperature(null), null);
    assert.equal(fish.intonationToTemperature(NaN), null);
    assert.equal(fish.intonationToTemperature("1.0"), null);
  });

  test("キャッシュキーが濁らないよう小数3桁に丸める", () => {
    for (let i = 0; i <= 20; i++) {
      const t = fish.intonationToTemperature(i / 10);
      assert.equal(t, Math.round(t * 1000) / 1000, `intonation=${i / 10}`);
    }
  });
});

describe("applyEmotion", () => {
  test("S2 系ならタグを前置する", () => {
    assert.equal(fish.supportsEmotion(), true);
    assert.equal(fish.applyEmotion("こんにちは", "happy"), "[happy] こんにちは");
  });

  test("感情未指定なら本文をそのまま返す", () => {
    assert.equal(fish.applyEmotion("こんにちは", null), "こんにちは");
    assert.equal(fish.applyEmotion("こんにちは", ""), "こんにちは");
  });
});

describe("parseReferenceId / isReferenceId", () => {
  test("32桁の16進数を reference_id と認める", () => {
    assert.equal(fish.isReferenceId("0042f795e8744feba27460ce426d1500"), true);
    assert.equal(fish.isReferenceId("short"), false);
  });

  test("fish.audio の URL から id を取り出す", () => {
    assert.equal(
      fish.parseReferenceId("https://fish.audio/m/0042f795e8744feba27460ce426d1500/"),
      "0042f795e8744feba27460ce426d1500"
    );
  });

  test("生の id もそのまま通す", () => {
    assert.equal(
      fish.parseReferenceId("0042f795e8744feba27460ce426d1500"),
      "0042f795e8744feba27460ce426d1500"
    );
  });
});

describe("estimateBytes", () => {
  test("UTF-8 バイト数で数える (日次上限の課金カウンタ用)", () => {
    assert.equal(fish.estimateBytes("abc"), 3);
    assert.equal(fish.estimateBytes("あ"), 3);
    assert.equal(fish.estimateBytes("こんにちは"), 15);
  });
});
