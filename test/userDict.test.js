// #11: Engine (VOICEVOX) と data/userDict.json の整合。
// ここが崩れると Engine 側にだけ残った語が孤児になり、uuid を知る手段が無いので
// どのコマンドからも消せなくなる (全サーバー共通の単一 Engine なので影響も全体に及ぶ)。
import { test, describe, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { useTempDataDir, stubFetch, jsonResponse } from "./helpers.js";

const dataDir = useTempDataDir();
const { addWord, removeWord } = await import("../src/userDict.js");
const { getUserDict, addUserDictEntry } = await import("../src/store.js");

let stub;
afterEach(() => {
  stub?.restore();
  mock.restoreAll();
  rmSync(join(dataDir, "userDict.json.tmp"), { recursive: true, force: true });
});

// method と path だけを見る簡易ルータ。呼ばれた順を calls で確認する。
function engine(handlers) {
  return stubFetch((url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("http://localhost:50021", "");
    const key = `${method} ${path.split("?")[0].replace(/^\/user_dict_word\/.+$/, "/user_dict_word/:uuid")}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`想定外のリクエスト: ${key}`);
    return handler(path);
  });
}

const methodsOf = (stub) =>
  stub.calls.map(
    (c) =>
      `${c.init?.method ?? "GET"} ${c.url
        .replace("http://localhost:50021", "")
        .split("?")[0]
        .replace(/^\/user_dict_word\/.+$/, "/user_dict_word/:uuid")}`
  );

// 「既に登録済み」の状態を作る。Engine を介さず JSON へ直接置くことで、
// テスト間で addWord の呼び出し履歴が混ざらないようにする。
function seed(word = "森", reading = "モリ", uuid = "uuid-1") {
  addUserDictEntry(word, reading, 0, uuid);
}

describe("addWord", () => {
  test("新規は POST し、成功してから JSON へ書く", async () => {
    stub = engine({ "POST /user_dict_word": () => jsonResponse("uuid-new") });
    const result = await addWord("新語", "シンゴ", 0);

    assert.equal(result.updated, false);
    assert.equal(result.uuid, "uuid-new");
    assert.deepEqual(
      getUserDict().find((e) => e.word === "新語"),
      { word: "新語", reading: "シンゴ", accent: 0, uuid: "uuid-new" }
    );
  });

  test("既存語は PUT で uuid ごと書き換える (DELETE+POST を使わない)", async () => {
    seed("森", "モリ");
    stub = engine({ "PUT /user_dict_word/:uuid": () => jsonResponse(null, 204) });

    const result = await addWord("森", "モリモリ", 1);

    assert.equal(result.updated, true);
    assert.equal(result.uuid, "uuid-1", "uuid が変わっている");
    assert.deepEqual(methodsOf(stub), ["PUT /user_dict_word/:uuid"]);
    // DELETE 成功 + POST 失敗で語が消える窓も、DELETE 失敗 + POST 成功で
    // 重複が残る窓も、PUT なら存在しない
    assert.deepEqual(
      getUserDict().find((e) => e.word === "森"),
      { word: "森", reading: "モリモリ", accent: 1, uuid: "uuid-1" }
    );
  });

  test("PUT が 404 なら (Engine 再作成後など) 新規登録へ倒す", async () => {
    seed("森", "モリ");
    stub = engine({
      "PUT /user_dict_word/:uuid": () => jsonResponse({ detail: "not found" }, 404),
      "POST /user_dict_word": () => jsonResponse("uuid-2"),
    });

    const result = await addWord("森", "モリ", 0);

    assert.equal(result.uuid, "uuid-2");
    assert.deepEqual(methodsOf(stub), [
      "PUT /user_dict_word/:uuid",
      "POST /user_dict_word",
    ]);
    assert.equal(getUserDict().filter((e) => e.word === "森").length, 1);
  });

  test("PUT が 404 以外で落ちたら POST へ倒さずそのまま失敗する", async () => {
    seed("森", "モリ");
    stub = engine({
      "PUT /user_dict_word/:uuid": () => jsonResponse({ detail: "boom" }, 500),
    });

    await assert.rejects(() => addWord("森", "モリ", 0), /500/);
    // 握り潰して POST すると、更新前の語と新しい語が Engine 側に二重に残る
    assert.equal(
      getUserDict().find((e) => e.word === "森").reading,
      "モリ",
      "失敗したのに JSON が書き換わっている"
    );
  });

  test("Engine が失敗したら JSON へ書かない", async () => {
    stub = engine({
      "POST /user_dict_word": () => jsonResponse({ detail: "boom" }, 500),
    });
    await assert.rejects(() => addWord("幽霊", "ユウレイ", 0), /500/);
    assert.equal(getUserDict().find((e) => e.word === "幽霊"), undefined);
  });

  test("JSON への保存が失敗したら Engine 側をロールバックする", async () => {
    // .tmp と同名のディレクトリを置いて writeFileSync を失敗させる
    mkdirSync(join(dataDir, "userDict.json.tmp"), { recursive: true });
    mock.method(console, "error", () => {});

    stub = engine({
      "POST /user_dict_word": () => jsonResponse("uuid-orphan"),
      "DELETE /user_dict_word/:uuid": () => jsonResponse(null, 204),
    });

    await assert.rejects(() => addWord("孤児", "コジ", 0));

    assert.deepEqual(methodsOf(stub), [
      "POST /user_dict_word",
      "DELETE /user_dict_word/:uuid", // 追跡できなくなる前に消す
    ]);
    assert.equal(getUserDict().find((e) => e.word === "孤児"), undefined);
  });
});

describe("removeWord", () => {
  test("Engine を先に消してから JSON を消す", async () => {
    seed("森", "モリ");
    stub = engine({ "DELETE /user_dict_word/:uuid": () => jsonResponse(null, 204) });

    assert.deepEqual(await removeWord("森"), { removed: true });
    assert.equal(getUserDict().find((e) => e.word === "森"), undefined);
  });

  test("Engine の DELETE が失敗したら JSON を消さず、成功と偽らない", async () => {
    seed("森", "モリ");
    stub = engine({
      "DELETE /user_dict_word/:uuid": () => jsonResponse({ detail: "boom" }, 500),
    });

    await assert.rejects(() => removeWord("森"), /500/);
    // JSON に残っていれば uuid も残る = 再実行で消せる
    assert.equal(getUserDict().find((e) => e.word === "森").uuid, "uuid-1");
  });

  test("Engine 側に既に無い (404) なら成功として JSON から消す", async () => {
    seed("森", "モリ");
    stub = engine({
      "DELETE /user_dict_word/:uuid": () => jsonResponse({ detail: "not found" }, 404),
    });

    assert.deepEqual(await removeWord("森"), { removed: true });
    assert.equal(getUserDict().find((e) => e.word === "森"), undefined);
  });

  test("未登録の語では Engine を叩かない", async () => {
    stub = engine({});
    assert.deepEqual(await removeWord("未登録"), { removed: false });
    assert.equal(stub.calls.length, 0);
  });
});

describe("直列化", () => {
  test("同じ語への add と remove が交差しない", async () => {
    let releasePost;
    const postStarted = new Promise((r) => (releasePost = r));
    let allowPost;
    const postGate = new Promise((r) => (allowPost = r));

    stub = engine({
      "POST /user_dict_word": async () => {
        releasePost();
        await postGate; // add を途中で止めたまま remove を走らせる
        return jsonResponse("uuid-race");
      },
      "DELETE /user_dict_word/:uuid": () => jsonResponse(null, 204),
    });

    const adding = addWord("競合", "キョウゴウ", 0);
    await postStarted;
    const removing = removeWord("競合");

    allowPost();
    await adding;
    assert.deepEqual(await removing, { removed: true });

    // remove は add の commit 後に走るので、uuid を掴んで DELETE できる。
    // 直列化していないと remove が「未登録」と判断して素通りし、
    // Engine 側の uuid-race が孤児として残る。
    assert.deepEqual(methodsOf(stub), [
      "POST /user_dict_word",
      "DELETE /user_dict_word/:uuid",
    ]);
    assert.equal(getUserDict().find((e) => e.word === "競合"), undefined);
  });

  test("1件失敗しても後続の操作は通る", async () => {
    stub = engine({
      "POST /user_dict_word": (path) =>
        path.includes(encodeURIComponent("失敗"))
          ? jsonResponse({ detail: "boom" }, 500)
          : jsonResponse("uuid-ok"),
    });

    await assert.rejects(() => addWord("失敗", "シッパイ", 0));
    await addWord("成功", "セイコウ", 0);
    assert.equal(getUserDict().find((e) => e.word === "成功").uuid, "uuid-ok");
  });
});
