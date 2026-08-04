import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir, fakeMessage } from "./helpers.js";

useTempDataDir({
  "ignore.json": {
    g1: { users: ["banned"], prefixes: [";", "!"], readBots: false },
    g2: { users: [], prefixes: [], readBots: true },
    // 手編集で空文字 prefix が入り込んだ状態 (全発言に前方一致してしまう)
    g3: { users: [], prefixes: ["", "  "], readBots: false },
  },
  "userSettings.json": { muted: { mute: true } },
});

const { isIgnoredMessage, isIgnoredMember } = await import(
  "../src/ignoreFilter.js"
);

const CLIENT = "self";

describe("isIgnoredMessage", () => {
  test("自 Bot の発言は常に除外", () => {
    assert.equal(
      isIgnoredMessage(fakeMessage({ authorId: CLIENT, bot: true }), CLIENT),
      true
    );
  });

  test("他 Bot は readBots=false なら除外、true なら読む", () => {
    const m = (guildId) => fakeMessage({ authorId: "b1", bot: true, guildId });
    assert.equal(isIgnoredMessage(m("g1"), CLIENT), true);
    assert.equal(isIgnoredMessage(m("g2"), CLIENT), false);
  });

  test("ギルドの除外ユーザーを弾く", () => {
    assert.equal(
      isIgnoredMessage(fakeMessage({ authorId: "banned" }), CLIENT),
      true
    );
  });

  test("個人ミュートは全サーバー共通で効く", () => {
    assert.equal(
      isIgnoredMessage(fakeMessage({ authorId: "muted", guildId: "g2" }), CLIENT),
      true
    );
  });

  test("prefix は前方一致・大文字小文字を区別しない", () => {
    const m = (content) => fakeMessage({ content });
    assert.equal(isIgnoredMessage(m(";play foo"), CLIENT), true);
    assert.equal(isIgnoredMessage(m("  !cmd"), CLIENT), true);
    assert.equal(isIgnoredMessage(m("ふつうの発言"), CLIENT), false);
  });

  test("バッククォートで囲われた prefix も除外する", () => {
    assert.equal(
      isIgnoredMessage(fakeMessage({ content: "`;play foo`" }), CLIENT),
      true
    );
  });

  test("空文字 prefix は全発言を止めるので無視する", () => {
    assert.equal(
      isIgnoredMessage(fakeMessage({ content: "ふつうの発言", guildId: "g3" }), CLIENT),
      false
    );
  });
});

describe("isIgnoredMember", () => {
  test("ギルド除外ユーザーと個人ミュートを判定する", () => {
    assert.equal(isIgnoredMember("g1", "banned"), true);
    assert.equal(isIgnoredMember("g2", "muted"), true);
    assert.equal(isIgnoredMember("g1", "someone"), false);
  });
});
