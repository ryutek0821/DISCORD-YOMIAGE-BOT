// 明示指定された話者IDが存在しない場合の扱い。getSpeakerIds のモジュール内キャッシュを
// 跨ぐのでファイルを分ける (node:test はファイルごとに別プロセス)。
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, stubFetch, jsonResponse } from "./helpers.js";

useTempDataDir({
  "guildSettings.json": { g1: { speaker: 7 } },
  "userSettings.json": {
    // Engine 不通中に /voice speaker:999999 が保存されてしまった状態
    100: { speaker: 999999 },
    200: { speaker: 5 },
  },
});

const { resolveUserVoice } = await import("../src/userVoice.js");

const SPEAKERS = [{ name: "s", styles: [{ id: 3 }, { id: 5 }] }];

let stub;
afterEach(() => stub?.restore());

describe("存在しない話者IDが保存されている場合", () => {
  test("既定話者へ倒して読み上げを継続する", async () => {
    // 倒さないと合成が毎回 422 で落ち、そのユーザーの発言が永久に無音になる
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    assert.equal((await resolveUserVoice("100", "g1")).speaker, 7);
  });

  test("有効なIDはそのまま使う", async () => {
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    assert.equal((await resolveUserVoice("200", "g1")).speaker, 5);
  });
});
