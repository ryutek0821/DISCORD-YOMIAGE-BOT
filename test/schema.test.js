import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeGuildSettings,
  sanitizeUserSettings,
  sanitizeDictionary,
  sanitizeIgnore,
  sanitizeFishVoices,
  sanitizeUserDict,
} from "../src/schema.js";

describe("root の型が違うファイル", () => {
  test("null / 配列 / 文字列は既定値に落として repaired を立てる", () => {
    for (const bad of [null, [], "x", 1]) {
      const r = sanitizeGuildSettings(bad);
      assert.deepEqual(r.value, {});
      assert.equal(r.repaired, true, `${JSON.stringify(bad)} が repaired にならない`);
    }
    // userDict だけ root が配列。オブジェクトが来たら落とす
    const r = sanitizeUserDict({ a: 1 });
    assert.deepEqual(r.value, []);
    assert.equal(r.repaired, true);
  });

  test("正常なファイルは repaired を立てない", () => {
    const raw = { g1: { speaker: 7, maxLength: 80, readChannelIds: ["c1"] } };
    const r = sanitizeGuildSettings(raw);
    assert.deepEqual(r.value, raw);
    assert.equal(r.repaired, false);
  });
});

describe("guildSettings の値検証", () => {
  test("型・範囲が不正なキーだけを落とす", () => {
    const r = sanitizeGuildSettings({
      g1: {
        speaker: "3", // 文字列
        speed: 9, // 範囲外
        maxLength: 5, // 下限未満
        readAuthorName: "sometimes", // 未知の値
        announceVoiceState: "true", // 文字列
        channelId: 12345, // 数値
        fishDailyBytes: 1.5, // 非整数
      },
    });
    assert.deepEqual(r.value, { g1: {} });
    assert.equal(r.repaired, true);
  });

  test("正当な値と未知キーは残す", () => {
    const r = sanitizeGuildSettings({
      g1: {
        speaker: 3,
        speed: 1.2,
        channelId: null, // /leave が書く正当な値
        readAuthorName: "always",
        maxLength: 200,
        fishDailyBytes: 0,
        futureKey: "残す",
      },
    });
    assert.deepEqual(r.value.g1, {
      speaker: 3,
      speed: 1.2,
      channelId: null,
      readAuthorName: "always",
      maxLength: 200,
      fishDailyBytes: 0,
      futureKey: "残す",
    });
    assert.equal(r.repaired, false);
  });

  test("readChannelIds は文字列だけ残し重複を潰す", () => {
    const r = sanitizeGuildSettings({
      g1: { readChannelIds: ["c1", null, 2, "c1", "c2"] },
    });
    assert.deepEqual(r.value.g1.readChannelIds, ["c1", "c2"]);
    assert.equal(r.repaired, true);
  });

  test("entry がオブジェクトでないギルドは丸ごと落とす", () => {
    const r = sanitizeGuildSettings({ g1: null, g2: ["x"], g3: { speaker: 3 } });
    assert.deepEqual(r.value, { g3: { speaker: 3 } });
    assert.equal(r.repaired, true);
  });
});

describe("userSettings の値検証", () => {
  test("/voice のレンジ外と未知 engine を落とす", () => {
    const r = sanitizeUserSettings({
      100: { speaker: 11, pitch: 0.9, intonation: 3, engine: "azure" },
    });
    assert.deepEqual(r.value, { 100: { speaker: 11 } });
    assert.equal(r.repaired, true);
  });

  test("全キーが無効なユーザーはエントリごと落とす", () => {
    // {} を残すと getUserSettings が「設定済み」を返してしまう
    const r = sanitizeUserSettings({ 100: { speaker: "x" }, 200: null });
    assert.deepEqual(r.value, {});
    assert.equal(r.repaired, true);
  });

  test("mute と Fish 設定は残す", () => {
    const raw = { 100: { mute: true, engine: "fish", fishRef: "abc", fishEmotion: "happy" } };
    const r = sanitizeUserSettings(raw);
    assert.deepEqual(r.value, raw);
    assert.equal(r.repaired, false);
  });
});

describe("dictionary / ignore / fishVoices / userDict の値検証", () => {
  test("置換辞書は word・reading が文字列の要素だけ残す", () => {
    const r = sanitizeDictionary({
      g1: [
        { word: "森", reading: "もり" },
        { word: "", reading: "から" },
        { word: "x" },
        null,
        "文字列",
      ],
      g2: "配列じゃない",
    });
    assert.deepEqual(r.value, { g1: [{ word: "森", reading: "もり" }] });
    assert.equal(r.repaired, true);
  });

  test("ignore は users / prefixes を配列に正す", () => {
    const r = sanitizeIgnore({
      g1: { users: ["1", 2, null], prefixes: "x", readBots: 1 },
    });
    assert.deepEqual(r.value, { g1: { users: ["1"] } });
    assert.equal(r.repaired, true);
  });

  test("fishVoices は name / referenceId が揃った要素だけ残す", () => {
    const r = sanitizeFishVoices({
      ok: { name: "声", referenceId: "abc" },
      ng: { name: "声" },
      bad: null,
    });
    assert.deepEqual(r.value, { ok: { name: "声", referenceId: "abc" } });
    assert.equal(r.repaired, true);
  });

  test("userDict は uuid・word・reading・accent が揃った要素だけ残す", () => {
    // 欠けた要素は importUserDict で必ず失敗する
    const good = { uuid: "u1", word: "森", reading: "モリ", accent: 1 };
    const r = sanitizeUserDict([
      good,
      { uuid: "u2", word: "山", reading: "ヤマ" }, // accent 欠落
      { word: "川", reading: "カワ", accent: 0 }, // uuid 欠落
      null,
    ]);
    assert.deepEqual(r.value, [good]);
    assert.equal(r.repaired, true);
  });
});
