// コマンド構成と、統合で移動した認可ガードの回帰テスト。
//
// /speakers /fishvoice を /voice へ、/ignore を /config へ畳んだとき、
// 「コマンド単位のガード」に丸めると権限が緩む/きつくなる事故が起きやすい。
// /config 直下 (show/set/channels/reset) は誰でも変更できるのに、配下の
// ignore user/prefix/bots だけは ManageGuild が要る、という非対称をここで固定する。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { useTempDataDir } from "./helpers.js";

useTempDataDir();

const { commands, commandMap } = await import("../src/commands/index.js");

// memberPermissions.has() だけを模した最小の interaction。
// reply/editReply の payload を集めて、どの分岐に落ちたかを見る。
function fakeInteraction({
  group = null,
  sub,
  options = {},
  manageGuild = false,
} = {}) {
  const replies = [];
  return {
    replies,
    inGuild: () => true,
    guildId: "g1",
    user: { id: "u1" },
    client: { user: { id: "bot1" } },
    memberPermissions: {
      has: (flag) => manageGuild && flag === PermissionFlagsBits.ManageGuild,
    },
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => sub,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getNumber: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getUser: (name) => options[name] ?? null,
      getChannel: (name) => options[name] ?? null,
    },
    reply: async (payload) => replies.push(payload),
    deferReply: async () => {},
    editReply: async (payload) => replies.push(payload),
    followUp: async (payload) => replies.push(payload),
  };
}

describe("コマンド構成", () => {
  test("トップレベルは6コマンドに絞られている", () => {
    assert.deepEqual(
      commands.map((c) => c.data.toJSON().name).sort(),
      ["config", "dict", "join", "leave", "skip", "voice"]
    );
  });

  test("旧コマンドはトップレベルに残っていない", () => {
    for (const name of ["speakers", "fishvoice", "ignore"]) {
      assert.equal(commandMap.has(name), false, `/${name} が残っている`);
    }
  });

  test("声の設定と一覧は /voice に、除外設定は /config に畳まれている", () => {
    const voice = commands.find((c) => c.data.toJSON().name === "voice").data.toJSON();
    assert.deepEqual(
      voice.options.map((o) => o.name).sort(),
      ["fish", "list", "reset", "set", "show"]
    );
    const fish = voice.options.find((o) => o.name === "fish");
    assert.deepEqual(fish.options.map((o) => o.name).sort(), ["add", "remove"]);

    const config = commands.find((c) => c.data.toJSON().name === "config").data.toJSON();
    const ignore = config.options.find((o) => o.name === "ignore");
    assert.ok(ignore, "/config ignore が無い");
    assert.deepEqual(
      ignore.options.map((o) => o.name).sort(),
      ["bots", "list", "me", "prefix", "user"]
    );
  });

  // 日本語表示のための ja ローカライズ。新しいオプションを足したときの
  // 付け忘れをここで落とす (付け忘れると Discord 上でそこだけ英語になる)。
  test("全サブコマンドとオプションに日本語表示名が付いている", () => {
    const missing = [];
    const walk = (opts, path) => {
      for (const o of opts ?? []) {
        if (!o.name_localizations?.ja) missing.push(`${path} ${o.name}`);
        walk(o.options, `${path} ${o.name}`);
      }
    };
    for (const command of commands) {
      const json = command.data.toJSON();
      walk(json.options, `/${json.name}`);
    }
    assert.deepEqual(missing, []);
  });
});

describe("統合後の認可ガード", () => {
  test("/config set は「サーバー管理」なしでも通る", async () => {
    const interaction = fakeInteraction({ sub: "set", manageGuild: false });
    await commandMap.get("config").execute(interaction);
    assert.equal(interaction.replies.length, 1);
    assert.doesNotMatch(interaction.replies[0].content, /サーバー管理/);
  });

  for (const sub of ["user", "prefix", "bots"]) {
    test(`/config ignore ${sub} は「サーバー管理」を要求する`, async () => {
      const interaction = fakeInteraction({
        group: "ignore",
        sub,
        manageGuild: false,
      });
      await commandMap.get("config").execute(interaction);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].content, /「サーバー管理」権限が必要/);
    });
  }

  // me は個人設定 (userSettings.mute) なので、サーバー設定コマンドの配下でも
  // 一般メンバーが自分に対して実行できなければならない。
  test("/config ignore me は一般メンバーでも通る", async () => {
    const interaction = fakeInteraction({
      group: "ignore",
      sub: "me",
      options: { mute: true },
      manageGuild: false,
    });
    await commandMap.get("config").execute(interaction);
    assert.equal(interaction.replies.length, 1);
    assert.match(interaction.replies[0].content, /ミュートしました/);
  });

  test("/voice fish remove は「サーバー管理」を要求する", async () => {
    const interaction = fakeInteraction({
      group: "fish",
      sub: "remove",
      options: { alias: "yaju" },
      manageGuild: false,
    });
    await commandMap.get("voice").execute(interaction);
    assert.equal(interaction.replies.length, 1);
    assert.match(interaction.replies[0].content, /「サーバー管理」権限が必要/);
  });

  // add は従来どおり全員可 (権限ではなく入力検証で落ちることを確認する)
  test("/voice fish add は権限で弾かれない", async () => {
    const interaction = fakeInteraction({
      group: "fish",
      sub: "add",
      options: { model: "not-a-model", alias: "x" },
      manageGuild: false,
    });
    await commandMap.get("voice").execute(interaction);
    assert.equal(interaction.replies.length, 1);
    assert.doesNotMatch(interaction.replies[0].content, /権限/);
    assert.match(interaction.replies[0].content, /モデルを認識できませんでした/);
  });
});
