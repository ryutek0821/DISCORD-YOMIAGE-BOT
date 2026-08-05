// getSpeakerIds はモジュール内でキャッシュを持つため、一度でも成功したテストと
// 同居させるとフォールバック経路を通らない。node:test はファイルごとに別プロセスで
// 走るので、Engine 不通のケースはこのファイルに隔離する。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, stubFetch } from "./helpers.js";

useTempDataDir({
  "guildSettings.json": { g1: { speaker: 7 } },
  "userSettings.json": { 100: { speaker: 999999 } },
});

const { resolveUserVoice } = await import("../src/userVoice.js");

describe("VOICEVOX 不通時のフォールバック", () => {
  test("話者一覧が取れなければギルド既定話者に落ちる", async () => {
    const stub = stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const v = await resolveUserVoice("999", "g1");
      assert.equal(v.speaker, 7, "ギルド既定話者へフォールバックする");
      assert.equal(v.engine, "voicevox");
    } finally {
      stub.restore();
    }
  });

  test("一覧が取れないときは明示指定の話者を尊重する", async () => {
    // 存在確認ができないだけで不正とは限らない。Engine 不通のたびに全ユーザーの
    // 明示指定を既定話者へ倒すと、復旧までの間だけ声が総入れ替わりして混乱する。
    const stub = stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    try {
      assert.equal((await resolveUserVoice("100", "g1")).speaker, 999999);
    } finally {
      stub.restore();
    }
  });

  test("ギルド設定も無ければ既定の 3 になる", async () => {
    const stub = stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    try {
      assert.equal((await resolveUserVoice("999", "unknown")).speaker, 3);
    } finally {
      stub.restore();
    }
  });
});
