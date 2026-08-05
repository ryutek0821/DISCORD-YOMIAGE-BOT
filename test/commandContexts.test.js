// コマンド登録 JSON が Guild 限定になっているかを見る。
// global 登録すると Bot の DM にもコマンドが公開され、DM の /leave が
// guildId=null のまま設定を書けてしまう。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { InteractionContextType } from "discord.js";
import { useTempDataDir } from "./helpers.js";

useTempDataDir();

const { commands, commandMap } = await import("../src/commands/index.js");

describe("スラッシュコマンドの実行コンテキスト", () => {
  test("全コマンドが Guild 限定で登録される", () => {
    assert.ok(commands.length > 0);
    for (const command of commands) {
      const json = command.data.toJSON();
      assert.deepEqual(
        json.contexts,
        [InteractionContextType.Guild],
        `${json.name} が Guild 限定になっていない`
      );
    }
  });

  test("Guild 外の実行は何もせず ephemeral で返す", async () => {
    const replies = [];
    let executed = false;
    const command = commandMap.get("join");
    // execute は commands/index.js 側で包まれているので、元の実装は呼ばれない
    const originalExecute = command.execute;
    assert.equal(typeof originalExecute, "function");

    await command.execute({
      inGuild: () => false,
      reply: async (payload) => replies.push(payload),
      // 実装まで届いたら参照されるはずのプロパティを敢えて壊しておく
      get member() {
        executed = true;
        throw new Error("Guild 外なのに実装が呼ばれた");
      },
    });

    assert.equal(executed, false);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /サーバー内でのみ/);
    assert.ok(replies[0].flags, "ephemeral で返していない");
  });
});
