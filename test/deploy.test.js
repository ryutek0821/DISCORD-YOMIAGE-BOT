// deploy.js の回帰テスト。fetch も Discord も一切叩かない。
// rest は { get, put } の呼び出し履歴を記録する単純なフェイクオブジェクト。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseGuildIds,
  parseArgs,
  buildPlan,
  applyPlan,
  discoverRegistrations,
} from "../src/deploy.js";

// get/put の呼び出しをそのまま記録しつつ、渡した挙動を返す最小のフェイク rest。
function fakeRest({ get, put } = {}) {
  const calls = [];
  return {
    calls,
    async get(route) {
      calls.push({ method: "get", route });
      return get ? get(route) : [];
    },
    async put(route, opts) {
      calls.push({ method: "put", route, opts });
      return put ? put(route, opts) : undefined;
    },
  };
}

describe("parseGuildIds", () => {
  test("空文字/undefined は空配列", () => {
    assert.deepEqual(parseGuildIds(""), []);
    assert.deepEqual(parseGuildIds(undefined), []);
  });

  test("空白のみは空配列", () => {
    assert.deepEqual(parseGuildIds("   "), []);
  });

  test("カンマ区切り複数を trim して返す", () => {
    assert.deepEqual(parseGuildIds(" 111 , 222,333 "), ["111", "222", "333"]);
  });

  test("重複と空要素を除去する", () => {
    assert.deepEqual(parseGuildIds("111,,222,111,"), ["111", "222"]);
  });
});

describe("parseArgs", () => {
  test("引数なしは既定値", () => {
    assert.deepEqual(parseArgs([]), { cleanup: false, dryRun: false });
  });

  test("--cleanup を認識する", () => {
    assert.deepEqual(parseArgs(["--cleanup"]), { cleanup: true, dryRun: false });
  });

  test("--dry-run を認識する", () => {
    assert.deepEqual(parseArgs(["--dry-run"]), { cleanup: false, dryRun: true });
  });

  test("両方指定できる", () => {
    assert.deepEqual(parseArgs(["--cleanup", "--dry-run"]), {
      cleanup: true,
      dryRun: true,
    });
  });

  test("未知のフラグは throw する", () => {
    assert.throws(() => parseArgs(["--bogus"]), /不明なオプション/);
  });
});

describe("buildPlan", () => {
  test("guildIds が空なら global 登録、cleanup は空 (registrations 未指定)", () => {
    const plan = buildPlan({ guildIds: [], registrations: null });
    assert.deepEqual(plan.register, [{ scope: "global" }]);
    assert.deepEqual(plan.cleanup, []);
  });

  test("単一ギルド", () => {
    const plan = buildPlan({ guildIds: ["111"], registrations: null });
    assert.deepEqual(plan.register, [{ scope: "guild", guildId: "111" }]);
  });

  test("複数ギルド", () => {
    const plan = buildPlan({ guildIds: ["111", "222"], registrations: null });
    assert.deepEqual(plan.register, [
      { scope: "guild", guildId: "111" },
      { scope: "guild", guildId: "222" },
    ]);
  });

  test("global→guild 切替時、残っている global が cleanup に入る", () => {
    const plan = buildPlan({
      guildIds: ["111"],
      registrations: { global: 5, guilds: [] },
    });
    assert.deepEqual(plan.cleanup, [{ scope: "global", count: 5 }]);
  });

  test("guild→global 切替時、登録済みギルドが全部 cleanup に入る", () => {
    const plan = buildPlan({
      guildIds: [],
      registrations: {
        global: 0,
        guilds: [
          { id: "111", name: "G1", count: 3 },
          { id: "222", name: "G2", count: 4 },
        ],
      },
    });
    assert.deepEqual(plan.cleanup, [
      { scope: "guild", guildId: "111", name: "G1", count: 3 },
      { scope: "guild", guildId: "222", name: "G2", count: 4 },
    ]);
  });

  test("GUILD_IDS から外したギルドだけ cleanup に入り、残っているギルドは入らない", () => {
    const plan = buildPlan({
      guildIds: ["111"],
      registrations: {
        global: 0,
        guilds: [
          { id: "111", name: "G1", count: 3 },
          { id: "222", name: "G2", count: 4 },
        ],
      },
    });
    assert.deepEqual(plan.cleanup, [{ scope: "guild", guildId: "222", name: "G2", count: 4 }]);
  });

  test("registrations 未指定なら cleanup は空 (--cleanup 未指定)", () => {
    const plan = buildPlan({ guildIds: ["111"], registrations: undefined });
    assert.deepEqual(plan.cleanup, []);
  });
});

describe("applyPlan", () => {
  test("register は body で PUT され、cleanup は body:[] で PUT される", async () => {
    const rest = fakeRest();
    const plan = {
      register: [{ scope: "guild", guildId: "111" }],
      cleanup: [{ scope: "global", count: 2 }],
    };
    const body = [{ name: "join" }];
    await applyPlan(rest, { clientId: "app1", body, plan, log: () => {} });

    const puts = rest.calls.filter((c) => c.method === "put");
    assert.equal(puts.length, 2);
    assert.deepEqual(puts[0].opts, { body });
    assert.deepEqual(puts[1].opts, { body: [] });
  });

  test("register が cleanup より先に呼ばれる", async () => {
    const rest = fakeRest();
    const order = [];
    const plan = {
      register: [{ scope: "global" }],
      cleanup: [{ scope: "guild", guildId: "111", count: 1 }],
    };
    await applyPlan(rest, {
      clientId: "app1",
      body: [],
      plan,
      log: (msg) => order.push(msg),
    });
    assert.match(order[0], /登録/);
    assert.match(order[1], /削除/);
  });

  test("dryRun: true では rest が一度も呼ばれない", async () => {
    const rest = fakeRest();
    const plan = {
      register: [{ scope: "global" }],
      cleanup: [{ scope: "guild", guildId: "111", count: 1 }],
    };
    const logs = [];
    await applyPlan(rest, {
      clientId: "app1",
      body: [{ name: "join" }],
      plan,
      dryRun: true,
      log: (msg) => logs.push(msg),
    });
    assert.equal(rest.calls.length, 0);
    assert.ok(logs.every((l) => l.startsWith("[dry-run]")));
  });
});

describe("discoverRegistrations", () => {
  test("ギルド一覧と件数を返し、count===0 のギルドは除外される", async () => {
    const rest = fakeRest({
      get(route) {
        if (route === "/applications/app1/commands") return [1, 2, 3];
        if (route === "/users/@me/guilds") {
          return [
            { id: "111", name: "G1" },
            { id: "222", name: "G2" },
          ];
        }
        if (route === "/applications/app1/guilds/111/commands") return [1, 2];
        if (route === "/applications/app1/guilds/222/commands") return [];
        throw new Error(`unexpected route: ${route}`);
      },
    });

    const result = await discoverRegistrations(rest, "app1");
    assert.equal(result.global, 3);
    assert.deepEqual(result.guilds, [{ id: "111", name: "G1", count: 2 }]);
  });

  test("個別ギルドのGETが失敗してもスキップして続行する", async () => {
    const rest = fakeRest({
      get(route) {
        if (route === "/applications/app1/commands") return [];
        if (route === "/users/@me/guilds") {
          return [
            { id: "111", name: "G1" },
            { id: "222", name: "G2" },
          ];
        }
        if (route === "/applications/app1/guilds/111/commands") {
          throw new Error("Missing Access");
        }
        if (route === "/applications/app1/guilds/222/commands") return [1];
        throw new Error(`unexpected route: ${route}`);
      },
    });

    const result = await discoverRegistrations(rest, "app1");
    assert.equal(result.global, 0);
    assert.deepEqual(result.guilds, [{ id: "222", name: "G2", count: 1 }]);
  });
});
