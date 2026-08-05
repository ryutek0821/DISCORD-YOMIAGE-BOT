// エラーログとエラーメッセージに読み上げ本文が残らないことを見る。
// log.js も store.js も本文を残さない設計なので、ここだけ抜けていると
// Engine が落ちるたびに非公開chの発言がコンテナの標準出力に蓄積する。
import { test, describe, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, stubFetch, jsonResponse } from "./helpers.js";

useTempDataDir();

const { safePath, synth, addUserDictWord } = await import("../src/voicevox.js");

let stub;
afterEach(() => {
  stub?.restore();
  mock.restoreAll();
});

const SECRET = "やっぱりあの件、Bさんには言わないでおこう";

describe("safePath", () => {
  test("クエリの値を伏せ、文字数だけ残す", () => {
    assert.equal(
      safePath(`/audio_query?text=${encodeURIComponent("あいう")}&speaker=3`),
      "/audio_query?text=<redacted:3文字>&speaker=3"
    );
  });

  test("デバッグに要る非機密パラメータは残す", () => {
    assert.equal(safePath("/synthesis?speaker=3"), "/synthesis?speaker=3");
    assert.equal(
      safePath("/user_dict_word?surface=森&pronunciation=モリ&accent_type=1&priority=5"),
      "/user_dict_word?surface=<redacted:1文字>&pronunciation=<redacted:2文字>&accent_type=1&priority=5"
    );
  });

  test("クエリの無いパスはそのまま", () => {
    assert.equal(safePath("/speakers"), "/speakers");
    assert.equal(safePath("/user_dict_word/abc-123"), "/user_dict_word/abc-123");
  });
});

describe("エラー経路に本文が出ない", () => {
  test("synth の失敗メッセージに発言本文が入らない", async () => {
    const errors = mock.method(console, "error", () => {});
    // 5xx なのでリトライも走る = logError も通る
    stub = stubFetch(() => jsonResponse({ detail: `input: ${SECRET}` }, 503));

    await assert.rejects(
      () => synth(SECRET, 3),
      (err) => {
        assert.ok(!err.message.includes(SECRET), "エラーに本文が生で入っている");
        assert.ok(
          !err.message.includes(encodeURIComponent(SECRET)),
          "エラーに本文がURLエンコードで入っている"
        );
        assert.match(err.message, /\/audio_query\?text=<redacted:\d+文字>/);
        // FastAPI の 422 はリクエスト内容を返すので応答本文ごと伏せる
        assert.ok(!err.message.includes("detail"), "応答本文が伏せられていない");
        return true;
      }
    );

    const logged = errors.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.ok(logged.length > 0, "リトライログが出ていない");
    assert.ok(!logged.includes(SECRET));
    assert.ok(!logged.includes(encodeURIComponent(SECRET)));
  });

  test("ユーザー辞書登録の失敗メッセージに語が入らない", async () => {
    stub = stubFetch(() => jsonResponse({}, 500));
    await assert.rejects(
      () => addUserDictWord("秘密の語", "ヒミツノゴ", 0, 5),
      (err) => {
        assert.ok(!err.message.includes("秘密の語"));
        assert.ok(!err.message.includes("ヒミツノゴ"));
        assert.match(err.message, /surface=<redacted:4文字>/);
        return true;
      }
    );
  });
});
