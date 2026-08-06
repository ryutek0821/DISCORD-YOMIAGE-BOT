// #8: VOICEVOX 復旧後にユーザー辞書を自動で再同期する。
// 起動時に1度 import するだけだと、cold start で Engine の起動が遅れた場合も、
// 運用中に engine だけ再作成した場合も、TTS が復旧しても辞書は Bot の再起動まで戻らない。
//
// 同期の timer と失敗回数はモジュールレベルの状態なのでファイルを分けてある。
import { test, describe, afterEach, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, stubFetch, jsonResponse } from "./helpers.js";

useTempDataDir();
const { reconcileUserDict, startUserDictSync, stopUserDictSync } = await import(
  "../src/userDict.js"
);
const { addUserDictEntry, removeUserDictEntry, getUserDict } = await import(
  "../src/store.js"
);

let stub;

beforeEach(() => {
  for (const e of [...getUserDict()]) removeUserDictEntry(e.word);
});

afterEach(() => {
  stopUserDictSync();
  mock.timers.reset();
  stub?.restore();
  mock.restoreAll();
});

// GET /user_dict が返す形 ({ [uuid]: word情報 })
const remoteDict = (uuids) =>
  Object.fromEntries(uuids.map((u) => [u, { surface: "語", pronunciation: "ゴ" }]));

// Engine 停止は TimeoutError で表す。5xx にすると request() が 200ms/400ms の
// sleep を挟んでリトライし、その setTimeout も mock timers の管理下に入るので、
// 「何回リクエストが飛んだか」を数える邪魔になる (リトライ自体は voicevox.test.js で見ている)。
function timeoutError() {
  const err = new Error("timed out");
  err.name = "TimeoutError";
  throw err;
}

function engine({ dict = {}, down = false } = {}) {
  return stubFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (url.includes("/import_user_dict")) return jsonResponse(null, 204);
    if (url.includes("/user_dict") && method === "GET") {
      if (down) timeoutError();
      return jsonResponse(dict);
    }
    throw new Error(`想定外のリクエスト: ${method} ${url}`);
  });
}

// startUserDictSync() は 0ms の timer を積むので、tick して初回を走らせる
async function startAndRunOnce() {
  startUserDictSync();
  mock.timers.tick(0);
  await settle();
}

const countOf = (stub, fragment) =>
  stub.calls.filter((c) => c.url.includes(fragment)).length;

// mock timers 下で、timer が起こした非同期処理 (fetch stub は即解決) を進める
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

describe("reconcileUserDict", () => {
  test("保存済みが0件なら Engine を叩かない", async () => {
    stub = engine();
    assert.deepEqual(await reconcileUserDict(), { imported: false });
    assert.equal(stub.calls.length, 0);
  });

  test("uuid が Engine 側に揃っていれば import しない", async () => {
    addUserDictEntry("森", "モリ", 0, "uuid-1");
    stub = engine({ dict: remoteDict(["uuid-1"]) });

    assert.deepEqual(await reconcileUserDict(), { imported: false });
    assert.equal(countOf(stub, "/import_user_dict"), 0);
  });

  test("Engine 側から uuid が消えていれば import する (engine 再作成の検知)", async () => {
    addUserDictEntry("森", "モリ", 0, "uuid-1");
    stub = engine({ dict: {} }); // 作り直された engine = 辞書が空

    assert.deepEqual(await reconcileUserDict(), { imported: true, count: 1 });
    assert.equal(countOf(stub, "/import_user_dict"), 1);
  });

  test("Engine 側にだけ有る語では import しない (import は消さないので毎回走ってしまう)", async () => {
    addUserDictEntry("森", "モリ", 0, "uuid-1");
    stub = engine({ dict: remoteDict(["uuid-1", "他所で登録された uuid"]) });

    assert.deepEqual(await reconcileUserDict(), { imported: false });
    assert.equal(countOf(stub, "/import_user_dict"), 0);
  });
});

describe("startUserDictSync", () => {
  test("起動時に Engine が落ちていても、復旧後に import が1回成功する", async () => {
    addUserDictEntry("森", "モリ", 0, "uuid-1");
    mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(console, "error", () => {});
    mock.method(console, "log", () => {});

    let down = true;
    stub = stubFetch((url) => {
      if (url.includes("/import_user_dict")) return jsonResponse(null, 204);
      if (down) timeoutError();
      return jsonResponse({}); // 復旧。作り直された engine なので辞書は空
    });

    await startAndRunOnce();
    assert.equal(countOf(stub, "/import_user_dict"), 0, "落ちている間に import している");

    // 失敗を何度繰り返しても import は走らない
    for (let i = 0; i < 3; i++) {
      mock.timers.tick(300_000);
      await settle();
    }
    assert.equal(countOf(stub, "/import_user_dict"), 0);

    down = false;
    mock.timers.tick(300_000);
    await settle();
    assert.equal(countOf(stub, "/import_user_dict"), 1, "復旧後に import されていない");

    // 復旧後は uuid が揃うわけではない (stub は常に空を返す) が、
    // 少なくとも同期が止まらず、リクエストが多重に走らないことを見る
    const before = stub.calls.length;
    mock.timers.tick(60_000);
    await settle();
    assert.ok(stub.calls.length > before, "復旧後に同期が止まっている");
  });

  test("稼働中に engine だけ再作成されても再 import する", async () => {
    addUserDictEntry("森", "モリ", 0, "uuid-1");
    mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(console, "log", () => {});

    let dict = remoteDict(["uuid-1"]);
    stub = stubFetch((url) => {
      if (url.includes("/import_user_dict")) {
        dict = remoteDict(["uuid-1"]); // import されたら engine 側に戻る
        return jsonResponse(null, 204);
      }
      return jsonResponse(dict);
    });

    await startAndRunOnce();
    assert.equal(countOf(stub, "/import_user_dict"), 0, "揃っているのに import した");

    dict = {}; // engine を作り直した = 辞書が消えた
    mock.timers.tick(60_000);
    await settle();
    assert.equal(countOf(stub, "/import_user_dict"), 1);

    // 復元済みなので次の周期では import しない
    mock.timers.tick(60_000);
    await settle();
    assert.equal(countOf(stub, "/import_user_dict"), 1);
  });

  test("連続失敗でも timer とリクエストが積み上がらない", async () => {
    addUserDictEntry("森", "モリ", 0, "uuid-1");
    mock.timers.enable({ apis: ["setTimeout"] });
    const errors = mock.method(console, "error", () => {});

    stub = engine({ down: true });

    await startAndRunOnce();
    const afterFirst = countOf(stub, "/user_dict");
    assert.equal(afterFirst, 1, "初回の同期が走っていない");

    for (let i = 0; i < 5; i++) {
      mock.timers.tick(300_000);
      await settle();
    }

    // 1周期あたり1リクエスト (GET /user_dict のリトライ分を含む一定数) を超えない
    assert.equal(
      countOf(stub, "/user_dict"),
      afterFirst * 6,
      "同期が多重に走っている"
    );
    assert.equal(errors.mock.calls.length, 1, "失敗のたびにログを出している");
  });

  test("stopUserDictSync 後は動かない", async () => {
    addUserDictEntry("森", "モリ", 0, "uuid-1");
    mock.timers.enable({ apis: ["setTimeout"] });
    stub = engine({ dict: remoteDict(["uuid-1"]) });

    await startAndRunOnce();
    const before = stub.calls.length;

    stopUserDictSync();
    mock.timers.tick(600_000);
    await settle();
    assert.equal(stub.calls.length, before);
  });
});
