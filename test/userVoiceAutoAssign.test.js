// 自動割り当ての凍結 (autoSpeaker) を検証する。
// getSpeakerIds はプロセス内でキャッシュを持ち無効化できないため、
// 「engine の一覧が変わった」状況は事前に userSettings.json へ書いた
// autoSpeaker が現在の modulo 結果と食い違う形で再現している。
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, stubFetch, jsonResponse } from "./helpers.js";

useTempDataDir({
  "guildSettings.json": { g1: { speaker: 7 } },
  "userSettings.json": {
    // userId は 17〜19桁で Number.MAX_SAFE_INTEGER を超える。オブジェクトリテラルの
    // 数値キーは Number 経由で丸められて別IDになるため、必ず文字列で書く
    //
    // 旧バージョンの engine で 5 に割り当てられ、凍結済みのユーザー。
    // 現在の一覧での modulo は 11 になる (下の SPEAKERS と userId から)
    "12345678901234567": { autoSpeaker: 5 },
    // 廃止されたスタイルIDが凍結されたまま残っているユーザー
    "22": { autoSpeaker: 999999 },
    // /voice で明示指定したユーザー (autoSpeaker も残っている)
    "33": { speaker: 3, autoSpeaker: 5 },
  },
});

const { resolveUserVoice } = await import("../src/userVoice.js");
const { getUserSettings } = await import("../src/store.js");

const SPEAKERS = [{ name: "s", styles: [{ id: 2 }, { id: 3 }, { id: 5 }, { id: 11 }] }];

let stub;
afterEach(() => stub?.restore());

describe("自動割り当ての凍結", () => {
  test("初回の割り当てを autoSpeaker へ保存する", async () => {
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    // 12345678901234568 % 4 === 0 -> ids[0] === 2
    const v = await resolveUserVoice("12345678901234568", "g1");
    assert.equal(v.speaker, 2);
    assert.equal(getUserSettings("12345678901234568").autoSpeaker, 2);
  });

  test("凍結済みなら modulo の結果より優先する", async () => {
    // これが効かないと、engine のスタイルが1つ増減しただけで
    // /voice 未設定の全員の声が入れ替わる
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    const v = await resolveUserVoice("12345678901234567", "g1");
    assert.equal(v.speaker, 5, "凍結値をそのまま使う (modulo なら 11)");
  });

  test("凍結した ID が engine から消えていたら割り当て直して凍結し直す", async () => {
    // 残したままだと合成が毎回 422 で落ち、そのユーザーだけ永久に無音になる
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    const v = await resolveUserVoice("22", "g1");
    // 22 % 4 === 2 -> ids[2] === 5
    assert.equal(v.speaker, 5);
    assert.equal(getUserSettings("22").autoSpeaker, 5);
  });

  test("/voice の明示指定は autoSpeaker より優先する", async () => {
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    assert.equal((await resolveUserVoice("33", "g1")).speaker, 3);
  });

  test("凍結値は再解決しても変わらない", async () => {
    stub = stubFetch(() => jsonResponse(SPEAKERS));
    const a = await resolveUserVoice("12345678901234568", "g1");
    const b = await resolveUserVoice("12345678901234568", "g1");
    assert.equal(a.speaker, b.speaker);
  });
});
