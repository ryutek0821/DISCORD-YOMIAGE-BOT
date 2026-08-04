// #30 / #43 / #44 / #22 / #53 の回帰テスト。
// 辞書の内容がケースごとに違うため、既存の textProcessor.test.js とは別 store を使う。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, fakeMessage } from "./helpers.js";

useTempDataDir({
  "guildSettings.json": { g1: { maxLength: 50 } },
  "dictionary.json": {
    // (A) reading が別エントリの word を含む = 連鎖置換が起きる並び
    chain: [
      { word: "田中", reading: "たなか" },
      { word: "たなか", reading: "タナカさん" },
    ],
    // 最長一致の確認
    longest: [
      { word: "東京", reading: "トウキョウ" },
      { word: "東京都", reading: "トウキョウト" },
    ],
    // 正規表現メタ文字を含む word
    symbols: [
      { word: "(^^)", reading: "にっこり" },
      { word: "a.b", reading: "エーテンビー" },
    ],
    // reading に置換文字列パターンを含む
    dollar: [{ word: "x", reading: "$& $1 $$" }],
    // 増幅パターン
    amplify: [
      { word: "あ", reading: "い".repeat(200) },
      { word: "い", reading: "う".repeat(200) },
      { word: "う", reading: "え".repeat(200) },
    ],
  },
});

const { buildSpeech, applyDictionary, formatAuthorName, sanitizeName } =
  await import("../src/textProcessor.js");

const speak = (content, opts = {}) =>
  buildSpeech(fakeMessage({ content, ...opts }), "g1");

// -------------------------------------------------------------------------
describe("#43 辞書の1パス同時置換", () => {
  test("置換結果は再度置換されない (連鎖置換の防止)", () => {
    assert.equal(
      applyDictionary("田中さんこんにちは", "chain"),
      "たなかさんこんにちは"
    );
  });

  test("最長一致が勝つ", () => {
    assert.equal(applyDictionary("東京都", "longest"), "トウキョウト");
    assert.equal(applyDictionary("東京", "longest"), "トウキョウ");
  });

  test("正規表現メタ文字を含む word はリテラル一致する", () => {
    assert.equal(applyDictionary("やった(^^)ね", "symbols"), "やったにっこりね");
    assert.equal(applyDictionary("a.b", "symbols"), "エーテンビー");
    // `.` がワイルドカードとして効いていれば "aXb" も一致してしまう
    assert.equal(applyDictionary("aXb", "symbols"), "aXb");
  });

  test("reading の $& や $1 が置換パターンとして解釈されない", () => {
    assert.equal(applyDictionary("x", "dollar"), "$& $1 $$");
  });

  test("辞書が空でも例外を投げない", () => {
    assert.equal(applyDictionary("そのまま", "empty"), "そのまま");
  });

  test("増幅しても中間文字列が上限で頭打ちになる", () => {
    const out = applyDictionary("あ".repeat(2000), "amplify");
    assert.ok(out.length <= 4000, `length=${out.length}`);
  });

  test("増幅辞書のギルドでも buildSpeech が完走し maxLength まで切られる", () => {
    const out = buildSpeech(
      fakeMessage({ content: "あ".repeat(2000), guildId: "amplify" }),
      "amplify"
    );
    assert.ok(out.endsWith(" 以下略"));
    assert.equal(Array.from(out.replace(" 以下略", "")).length, 50);
  });
});

// -------------------------------------------------------------------------
describe("#30 コードポイント単位の切り詰め", () => {
  const encodable = (s) => {
    encodeURIComponent(s); // 孤立サロゲートがあれば URIError
    return true;
  };

  test("BMP 外文字の途中で切っても encodeURIComponent が通る", () => {
    assert.ok(encodable(speak("あ" + "𝕒".repeat(30))));
    assert.ok(encodable(speak("𠮷".repeat(40))));
    assert.ok(encodable(speak("国旗" + "🇯🇵".repeat(20))));
  });

  test("maxLength はコードポイント数で数える", () => {
    const out = speak("𠮷".repeat(80));
    assert.equal(Array.from(out.replace(" 以下略", "")).length, 50);
  });

  test("孤立サロゲートが残らない", () => {
    const out = speak("あ" + "𝕒".repeat(30));
    assert.equal(out, out.toWellFormed(), "孤立サロゲートを含まない");
  });

  test("表示名も同様にコードポイント単位で切る", () => {
    const name = formatAuthorName({ displayName: "𝕒".repeat(40) }, null, "g1");
    assert.equal(Array.from(name).length, 20);
    assert.ok(encodable(name));
  });
});

// -------------------------------------------------------------------------
describe("#44(A) www ドメインが「笑」に化けない", () => {
  test("www.google.com はそのまま残る", () => {
    assert.equal(speak("www.google.com を見て"), "www.google.com を見て");
  });

  test("従来の草変換は維持される", () => {
    assert.equal(speak("これは草wwww"), "これは草笑");
    assert.equal(speak("ｗｗｗ"), "笑");
  });

  test("スキーム付き URL は従来どおり省略される", () => {
    assert.equal(speak("https://www.google.com"), "URL省略");
  });

  test("英単語中の ww は変換しない", () => {
    assert.equal(speak("swww"), "swww");
  });
});

describe("#44(B) 国旗絵文字・ZWJ・異体字セレクタの除去", () => {
  const FORBIDDEN = /[\u{1F1E6}-\u{1F1FF}‍︎️⃣]/u;

  for (const input of ["🇯🇵", "👨‍👩‍👧", "1️⃣", "❤️", "国旗 🇯🇵 です"]) {
    test(`${JSON.stringify(input)} に残骸が残らない`, () => {
      const out = speak(input);
      assert.ok(!FORBIDDEN.test(out), `残骸: ${JSON.stringify(out)}`);
    });
  }

  test("絵文字のみ + 添付は「添付ファイル」と読まれる", () => {
    assert.equal(speak("🇯🇵", { attachments: 1 }), "添付ファイル");
    assert.equal(speak("❤️", { attachments: 1 }), "添付ファイル");
  });
});

// -------------------------------------------------------------------------
describe("#22 スポイラーと未閉じコード", () => {
  test("スポイラー内の URL が漏れない (URL 置換より先に潰す)", () => {
    assert.equal(speak("||https://example.com||"), "ネタバレ省略");
  });

  test("通常のスポイラーは従来どおり", () => {
    assert.equal(speak("犯人は||田中||だ"), "犯人は ネタバレ省略 だ");
  });

  test("複数スポイラーをすべて潰す", () => {
    assert.equal(speak("||a||と||b||"), "ネタバレ省略 と ネタバレ省略");
  });

  test("未閉じコードフェンスは文末まで省略する", () => {
    assert.equal(speak("見て\n```js\nconst secret = 'token';"), "見て コード省略");
  });

  test("閉じたコードブロックは従来どおり", () => {
    assert.equal(speak("```js\nconst a=1;\n```"), "コード省略");
  });

  test("インラインコードは従来どおり", () => {
    assert.equal(speak("これは `code` です"), "これは コード省略 です");
  });

  test("コード内の URL も省略に飲まれる", () => {
    assert.equal(speak("```\nhttps://example.com\n```"), "コード省略");
  });

  test("通常 URL と Markdown の既存出力は維持される", () => {
    assert.equal(speak("見て https://example.com/a?b=1 ね"), "見て URL省略 ね");
    assert.equal(speak("**太字**と~~打消~~"), "太字と打消");
  });
});

// -------------------------------------------------------------------------
describe("#53 表示名のサニタイズ", () => {
  test("カスタム絵文字記法は名前部分だけ読む", () => {
    assert.equal(sanitizeName("<:kusa:123456789012345678>", "g1"), "kusa");
  });

  test("絵文字だけの表示名は「誰か」にフォールバックする", () => {
    assert.equal(sanitizeName("🇯🇵❤️😀", "g1"), "誰か");
  });

  test("32文字の日本語は 20 文字で切られる", () => {
    assert.equal(Array.from(sanitizeName("あ".repeat(32), "g1")).length, 20);
  });

  test("通常の表示名は従来どおり", () => {
    assert.equal(sanitizeName("たろう", "g1"), "たろう");
    assert.equal(formatAuthorName({ displayName: "たろう" }, null, "g1"), "たろう");
  });

  test("辞書適用は維持される (spec-config AC-13)", () => {
    assert.equal(sanitizeName("田中", "chain"), "たなか");
  });

  test("null / undefined でも落ちない", () => {
    assert.equal(sanitizeName(null, "g1"), "誰か");
    assert.equal(sanitizeName(undefined, "g1"), "誰か");
  });
});
