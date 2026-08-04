import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, fakeMessage } from "./helpers.js";

useTempDataDir({
  "guildSettings.json": { g1: { maxLength: 50 } },
  "dictionary.json": {
    g1: [{ word: "VOICEVOX", reading: "ボイスボックス" }],
  },
});

const { buildSpeech, applyDictionary, formatAuthorName } = await import(
  "../src/textProcessor.js"
);

const speak = (content, opts = {}) =>
  buildSpeech(fakeMessage({ content, ...opts }), "g1");

describe("buildSpeech: 除去・置換", () => {
  test("コードブロックとインラインコードを省略する", () => {
    assert.equal(speak("```js\nconst a=1;\n```"), "コード省略");
    assert.equal(speak("これは `code` です"), "これは コード省略 です");
  });

  test("URL を省略する", () => {
    assert.equal(speak("見て https://example.com/a?b=1 ね"), "見て URL省略 ね");
  });

  test("メンションは名前に、解決できなければ除去する", () => {
    assert.equal(
      speak("<@123> やあ", { users: { 123: { username: "たろう" } } }),
      "たろう やあ"
    );
    assert.equal(speak("<@999> やあ"), "やあ");
  });

  test("カスタム絵文字は名前だけ残し、Unicode 絵文字は除去する", () => {
    assert.equal(speak("<:smile:1234> やった"), "smile やった");
    assert.equal(speak("やった😀"), "やった");
  });

  test("スポイラーは中身を読まない", () => {
    assert.equal(speak("犯人は||田中||だ"), "犯人は ネタバレ省略 だ");
  });

  test("Markdown 装飾は記号だけ落として中身は読む", () => {
    assert.equal(speak("**太字**と~~打消~~と*斜体*"), "太字と打消と斜体");
    assert.equal(speak("# 見出し"), "見出し");
    assert.equal(speak("> 引用"), "引用");
    assert.equal(speak("- 箇条書き"), "箇条書き");
  });

  test("添付のみの発言は「添付ファイル」になる", () => {
    assert.equal(speak("", { attachments: 1 }), "添付ファイル");
  });
});

describe("buildSpeech: 草の変換", () => {
  test("末尾・単独の w 連続は「笑」になる", () => {
    assert.equal(speak("うけるww"), "うける笑");
    assert.equal(speak("うけるｗｗｗ"), "うける笑");
  });

  test("英単語の中の ww は変換しない", () => {
    assert.equal(speak("powwow"), "powwow");
  });

  test("w 1文字は変換しない", () => {
    assert.equal(speak("あw"), "あw");
  });
});

describe("applyDictionary", () => {
  test("登録した語を読み替える", () => {
    assert.equal(applyDictionary("VOICEVOX で読む", "g1"), "ボイスボックス で読む");
  });

  test("辞書はギルド単位で分かれている", () => {
    assert.equal(applyDictionary("VOICEVOX", "g2"), "VOICEVOX");
  });

  test("buildSpeech でも辞書が効く", () => {
    assert.equal(speak("VOICEVOX すごい"), "ボイスボックス すごい");
  });
});

describe("上限カット", () => {
  test("maxLength を超えたら「以下略」を付ける", () => {
    const out = speak("あ".repeat(80));
    assert.ok(out.endsWith(" 以下略"), out);
    assert.equal(out.slice(0, 50), "あ".repeat(50));
  });

  test("maxLength は 10〜200 にクランプされる", async () => {
    const { updateGuildSettings } = await import("../src/store.js");
    updateGuildSettings("g1", { maxLength: 5 });
    assert.equal(speak("あ".repeat(30)).replace(" 以下略", "").length, 10);
    updateGuildSettings("g1", { maxLength: 9999 });
    assert.equal(speak("あ".repeat(300)).replace(" 以下略", "").length, 200);
    updateGuildSettings("g1", { maxLength: 50 });
  });
});

describe("formatAuthorName", () => {
  test("displayName を優先し、無ければ username にフォールバックする", () => {
    assert.equal(formatAuthorName({ displayName: "太郎" }, null, "g1"), "太郎");
    assert.equal(formatAuthorName(null, { username: "jiro" }, "g1"), "jiro");
    assert.equal(formatAuthorName(null, null, "g1"), "誰か");
  });

  test("20文字で切り詰める", () => {
    assert.equal(formatAuthorName({ displayName: "あ".repeat(40) }, null, "g1").length, 20);
  });

  test("表示名にも辞書が効く", () => {
    assert.equal(formatAuthorName({ displayName: "VOICEVOX" }, null, "g1"), "ボイスボックス");
  });
});
