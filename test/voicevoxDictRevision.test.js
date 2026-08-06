// #9: ユーザー辞書を変えたら WAV キャッシュを世代ごと捨てる。
// キーは speaker/速度/pitch/抑揚/text だけなので、世代が無いと辞書を直しても
// LRU から追い出されるか Bot 再起動まで旧発音が返り続ける (頻出文ほど直らない)。
//
// wavCache と revision はモジュールレベルの状態なので、確実にリセットするため
// ファイルを分けてある (node:test はファイルごとに別プロセスで走る)。
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, stubFetch, jsonResponse, binaryResponse } from "./helpers.js";

useTempDataDir();
const {
  synth,
  bumpUserDictRevision,
  addUserDictWord,
  deleteUserDictWord,
  updateUserDictWord,
  importUserDict,
} = await import("../src/voicevox.js");

let stub;
afterEach(() => stub?.restore());

const WAV = Buffer.from([0x52, 0x49, 0x46, 0x46]);

// synth 1回につき /audio_query と /synthesis の2リクエスト
function engine({ onSynthesis } = {}) {
  return stubFetch(async (url) => {
    if (url.includes("/audio_query")) return jsonResponse({ accent_phrases: [] });
    if (url.includes("/synthesis")) {
      if (onSynthesis) await onSynthesis();
      return binaryResponse(WAV);
    }
    if (url.includes("user_dict")) return jsonResponse("uuid-1", 200);
    throw new Error(`想定外のリクエスト: ${url}`);
  });
}

const synthCount = (stub) =>
  stub.calls.filter((c) => c.url.includes("/synthesis")).length;

describe("辞書の世代と WAV キャッシュ", () => {
  test("辞書に変更が無ければ同一条件は再合成しない", async () => {
    stub = engine();
    await synth("おはよう", 3);
    await synth("おはよう", 3);
    assert.equal(synthCount(stub), 1, "2回目もEngineへ合成要求が飛んでいる");
  });

  test("単語の登録後は同じ文でも再合成する", async () => {
    stub = engine();
    await synth("神は死んだ", 3);
    assert.equal(synthCount(stub), 1);

    await addUserDictWord("神", "カミ", 0, 5);
    await synth("神は死んだ", 3);
    assert.equal(synthCount(stub), 2, "辞書変更後もキャッシュを返している");
  });

  test("更新・削除・一括投入でも世代が上がる", async () => {
    const cases = [
      ["更新", () => updateUserDictWord("uuid-1", "神", "ゴッド", 0, 5)],
      ["削除", () => deleteUserDictWord("uuid-1")],
      [
        "一括投入",
        () => importUserDict([{ uuid: "uuid-1", word: "神", reading: "カミ", accent: 0 }]),
      ],
    ];
    for (const [label, mutate] of cases) {
      // wavCache はファイル内のテストで共有されるので、文を変えて衝突を避ける
      const text = `神は死んだ (${label})`;
      stub = engine();
      await synth(text, 3);
      await synth(text, 3);
      assert.equal(synthCount(stub), 1, label);

      await mutate();
      await synth(text, 3);
      assert.equal(synthCount(stub), 2, label);
      stub.restore();
    }
  });

  test("空の import では世代を上げない (辞書は変わっていない)", async () => {
    stub = engine();
    await synth("空importの文", 3);
    await importUserDict([]);
    await synth("空importの文", 3);
    assert.equal(synthCount(stub), 1);
  });

  test("合成中に辞書が変わったら、その結果はキャッシュに載せない", async () => {
    let bumped = false;
    stub = engine({
      onSynthesis: async () => {
        // 合成の完了前に辞書が変わる = この WAV は旧世代の読み。
        // clear() だけだと、これが変更後に完了して新世代へ入り直してしまう。
        if (!bumped) {
          bumped = true;
          bumpUserDictRevision();
        }
      },
    });

    await synth("合成中に辞書が変わる文", 3);
    assert.equal(synthCount(stub), 1);

    await synth("合成中に辞書が変わる文", 3);
    assert.equal(synthCount(stub), 2, "旧世代の WAV がキャッシュに残っている");
  });
});
