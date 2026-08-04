import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTempDataDir } from "./helpers.js";

const dir = useTempDataDir({
  // 壊れた JSON でも起動でき、既定値に落ちることを確認する
  "guildSettings.json": "{ this is not json",
});

const store = await import("../src/store.js");

const readJson = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("load: 壊れた JSON からの復帰", () => {
  test("パースできなくても既定値で起動する", () => {
    assert.equal(store.getGuildSettings("g1").speaker, 3);
    assert.equal(store.getGuildSettings("g1").maxLength, 50);
  });
});

describe("getGuildSettings", () => {
  test("未設定ギルドは既定値を返す", () => {
    const s = store.getGuildSettings("unknown");
    assert.equal(s.speed, 1.0);
    assert.equal(s.readAuthorName, "off");
    assert.equal(s.announceVoiceState, true);
    assert.equal(s.fishDailyBytes, 50000);
    assert.deepEqual(s.readChannelIds, []);
  });

  test("既定値オブジェクトは呼び出しごとに別インスタンス (書き換え漏れ防止)", () => {
    const a = store.getGuildSettings("x");
    a.readChannelIds.push("dirty");
    assert.deepEqual(store.getGuildSettings("x").readChannelIds, []);
  });
});

describe("save: アトミック書き込み", () => {
  test("更新は即ファイルに反映され、.tmp を残さない", () => {
    store.updateGuildSettings("g1", { speaker: 42 });
    assert.equal(readJson("guildSettings.json").g1.speaker, 42);
    assert.equal(existsSync(join(dir, "guildSettings.json.tmp")), false);
  });

  test("読み直しても値が保持される", () => {
    store.updateGuildSettings("g1", { maxLength: 120 });
    assert.equal(store.getGuildSettings("g1").maxLength, 120);
    assert.equal(readJson("guildSettings.json").g1.maxLength, 120);
  });
});

describe("辞書 (置換辞書)", () => {
  test("追加・取得・削除ができる", () => {
    store.addDictionaryEntry("g1", "草", "くさ");
    assert.deepEqual(store.getDictionary("g1"), [{ word: "草", reading: "くさ" }]);
    store.removeDictionaryEntry("g1", "草");
    assert.deepEqual(store.getDictionary("g1"), []);
  });

  test("同じ語を再登録しても重複しない", () => {
    store.addDictionaryEntry("g1", "草", "くさ");
    store.addDictionaryEntry("g1", "草", "そう");
    assert.equal(store.getDictionary("g1").length, 1);
    assert.equal(store.getDictionary("g1")[0].reading, "そう");
    store.removeDictionaryEntry("g1", "草");
  });
});

describe("ユーザー設定", () => {
  test("patch がマージされる", () => {
    store.updateUserSettings("u1", { speaker: 5 });
    store.updateUserSettings("u1", { speed: 1.5 });
    assert.equal(store.getUserSettings("u1").speaker, 5);
    assert.equal(store.getUserSettings("u1").speed, 1.5);
  });

  test("clear はエントリごと消すので mute も解除される", () => {
    store.updateUserSettings("u2", { mute: true, speaker: 1 });
    assert.equal(store.getUserSettings("u2").mute, true);
    store.clearUserSettings("u2");
    assert.equal(store.getUserSettings("u2")?.mute, undefined);
  });
});

describe("Fish ボイス", () => {
  test("組み込みプリセットは常に存在する", () => {
    assert.equal(store.getFishVoices().yaju.name, "野獣先輩");
    assert.equal(store.isBuiltinFishVoice("yaju"), true);
  });

  test("追加分は組み込みとマージされる", () => {
    store.addFishVoice("test", "テスト", "a".repeat(32));
    const all = store.getFishVoices();
    assert.equal(all.test.referenceId, "a".repeat(32));
    assert.ok(all.yaju);
    store.removeFishVoice("test");
    assert.equal(store.getFishVoices().test, undefined);
  });
});

describe("除外設定", () => {
  test("未設定ギルドは既定値", () => {
    const ig = store.getIgnore("fresh");
    assert.deepEqual(ig, { users: [], prefixes: [], readBots: false });
  });

  test("ユーザー・prefix の追加と削除、readBots の切替", () => {
    store.addIgnoreUser("g9", "u9");
    store.addIgnorePrefix("g9", "!");
    store.setReadBots("g9", true);
    let ig = store.getIgnore("g9");
    assert.deepEqual(ig.users, ["u9"]);
    assert.deepEqual(ig.prefixes, ["!"]);
    assert.equal(ig.readBots, true);

    store.removeIgnoreUser("g9", "u9");
    store.removeIgnorePrefix("g9", "!");
    ig = store.getIgnore("g9");
    assert.deepEqual(ig.users, []);
    assert.deepEqual(ig.prefixes, []);
  });
});

describe("getReadChannelIds", () => {
  test("readChannelIds があればそれを、無ければ channelId を返す", () => {
    store.updateGuildSettings("gc", { channelId: "legacy" });
    assert.deepEqual(store.getReadChannelIds("gc"), ["legacy"]);
    store.updateGuildSettings("gc", { readChannelIds: ["a", "b"] });
    assert.deepEqual(store.getReadChannelIds("gc"), ["a", "b"]);
  });
});
