// store のスキーマ検証・退避・既定値の扱いを見る。
// store.js は import 時に data/ を読むので、モジュールレベルのキャッシュを跨ぐ
// 検証は store.test.js と別ファイルに分ける (node:test はファイルごとに別プロセス)。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { useTempDataDir } from "./helpers.js";

const dir = useTempDataDir({
  "guildSettings.json": {
    // 旧 updateGuildSettings が既定値まで焼き付けた状態
    g1: {
      channelId: "text1",
      readChannelIds: [],
      announceVoiceState: true,
      readAuthorName: "off",
      maxLength: 50,
      fishDailyBytes: 50000,
    },
    // 既定値しか持たないギルドはエントリごと消える
    g2: { maxLength: 50 },
    g3: { maxLength: 120 },
  },
  "userSettings.json": {
    100: { speaker: "壊れた値" },
    200: { speaker: 5 },
  },
});

const store = await import("../src/store.js");

const readJson = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const corruptFiles = (name) =>
  readdirSync(dir).filter((f) => f.startsWith(`${name}.corrupt-`));

describe("不正データの隔離 (#17)", () => {
  test("壊れたエントリを除去し、元ファイルを退避してから書き戻す", () => {
    assert.equal(store.getUserSettings("100"), null);
    assert.deepEqual(store.getUserSettings("200"), { speaker: 5 });
    // 復旧後の内容で上書きされている
    assert.deepEqual(readJson("userSettings.json"), { 200: { speaker: 5 } });
    // 退避しないと次の save で元の内容が消え、何が壊れていたか分からなくなる
    const backups = corruptFiles("userSettings.json");
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, backups[0]), "utf8")), {
      100: { speaker: "壊れた値" },
      200: { speaker: 5 },
    });
  });

  test("検証を通ったファイルは退避しない", () => {
    assert.deepEqual(corruptFiles("guildSettings.json"), []);
  });
});

describe("既定値を実体化しない (#47)", () => {
  test("起動時に既定値と一致する保存値を落とす", () => {
    const saved = readJson("guildSettings.json");
    assert.deepEqual(saved.g1, { channelId: "text1" });
    assert.equal(Object.hasOwn(saved, "g2"), false);
    assert.deepEqual(saved.g3, { maxLength: 120 });
  });

  test("落としても読み出し値は変わらない (既定値は getter が当てる)", () => {
    const s = store.getGuildSettings("g1");
    assert.equal(s.channelId, "text1");
    assert.equal(s.maxLength, 50);
    assert.equal(s.announceVoiceState, true);
    assert.equal(s.readAuthorName, "off");
    assert.deepEqual(s.readChannelIds, []);
  });

  test("update は patch したキーだけ保存する", () => {
    store.updateGuildSettings("g9", { maxLength: 80 });
    assert.deepEqual(readJson("guildSettings.json").g9, { maxLength: 80 });
    // 既定値と同じ値を明示指定した場合は保存される (prune は起動時だけ)
    store.updateGuildSettings("g9", { readAuthorName: "always" });
    assert.deepEqual(readJson("guildSettings.json").g9, {
      maxLength: 80,
      readAuthorName: "always",
    });
  });

  test("update の戻り値は既定値マージ済みの設定", () => {
    const s = store.updateGuildSettings("g10", { speaker: 7 });
    assert.equal(s.speaker, 7);
    assert.equal(s.maxLength, 50);
  });
});

describe("resetGuildSettings", () => {
  test("/config 管轄のキーだけ消し、channelId と speaker は残す", () => {
    store.updateGuildSettings("g11", {
      channelId: "text2",
      speaker: 9,
      maxLength: 150,
      readAuthorName: "always",
      readChannelIds: ["c1"],
    });
    store.resetGuildSettings("g11");
    // channelId まで消すと読み上げ対象が「全チャンネル」に広がってしまう
    assert.deepEqual(readJson("guildSettings.json").g11, {
      channelId: "text2",
      speaker: 9,
    });
    const s = store.getGuildSettings("g11");
    assert.equal(s.maxLength, 50);
    assert.equal(s.readAuthorName, "off");
    assert.deepEqual(s.readChannelIds, []);
  });

  test("保存が無いギルドでも既定値を返す", () => {
    assert.equal(store.resetGuildSettings("never-seen").maxLength, 50);
  });
});
