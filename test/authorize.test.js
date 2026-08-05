import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import {
  authorizeJoin,
  authorizeLeave,
  authorizeSkip,
  isVoiceOperator,
  isOperator,
  parseOperatorIds,
  resolveOwnerIds,
} from "../src/authorize.js";

// interaction.memberPermissions を最小限だけ模す
function perms(...flags) {
  return { has: (flag) => flags.includes(flag) };
}

describe("isVoiceOperator", () => {
  test("ManageGuild か MoveMembers があれば true", () => {
    assert.equal(isVoiceOperator(perms(PermissionFlagsBits.ManageGuild)), true);
    assert.equal(isVoiceOperator(perms(PermissionFlagsBits.MoveMembers)), true);
    assert.equal(isVoiceOperator(perms(PermissionFlagsBits.SendMessages)), false);
    assert.equal(isVoiceOperator(null), false);
  });
});

describe("authorizeJoin", () => {
  test("VC未参加なら拒否する", () => {
    const r = authorizeJoin({ botChannelId: null, userChannelId: null, privileged: true });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /ボイスチャンネルに参加/);
  });

  test("Bot 未接続なら一般ユーザーでも呼べる", () => {
    assert.deepEqual(
      authorizeJoin({ botChannelId: null, userChannelId: "vcA", privileged: false }),
      { allowed: true }
    );
  });

  test("同じVCなら一般ユーザーでも呼べる", () => {
    assert.deepEqual(
      authorizeJoin({ botChannelId: "vcA", userChannelId: "vcA", privileged: false }),
      { allowed: true }
    );
  });

  test("別VCへの移動は権限が要る", () => {
    // 無条件に許すと、別VCの一般ユーザーが稼働中の読み上げを奪える
    const denied = authorizeJoin({
      botChannelId: "vcA",
      userChannelId: "vcB",
      privileged: false,
    });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /権限が必要/);
    assert.deepEqual(
      authorizeJoin({ botChannelId: "vcA", userChannelId: "vcB", privileged: true }),
      { allowed: true }
    );
  });
});

describe("authorizeLeave", () => {
  test("Bot 未接続なら通す (呼び出し側が「参加していません」を返す)", () => {
    assert.deepEqual(
      authorizeLeave({ botChannelId: null, userChannelId: null, privileged: false }),
      { allowed: true }
    );
  });

  test("同じVCにいれば一般ユーザーでも切断できる", () => {
    assert.deepEqual(
      authorizeLeave({ botChannelId: "vcA", userChannelId: "vcA", privileged: false }),
      { allowed: true }
    );
  });

  test("VC外からの切断は権限が要る", () => {
    for (const userChannelId of [null, "vcB"]) {
      const denied = authorizeLeave({
        botChannelId: "vcA",
        userChannelId,
        privileged: false,
      });
      assert.equal(denied.allowed, false, `${userChannelId} で拒否されない`);
      assert.match(denied.reason, /権限が必要/);
    }
    assert.deepEqual(
      authorizeLeave({ botChannelId: "vcA", userChannelId: null, privileged: true }),
      { allowed: true }
    );
  });
});

describe("authorizeSkip", () => {
  test("Bot 未接続なら通す (呼び出し側が「読み上げていません」を返す)", () => {
    assert.deepEqual(
      authorizeSkip({ botChannelId: null, userChannelId: null, privileged: false }),
      { allowed: true }
    );
  });

  test("同じVCにいれば一般ユーザーでもスキップできる", () => {
    assert.deepEqual(
      authorizeSkip({ botChannelId: "vcA", userChannelId: "vcA", privileged: false }),
      { allowed: true }
    );
  });

  test("別VCからのスキップは権限が要る", () => {
    const denied = authorizeSkip({
      botChannelId: "vcA",
      userChannelId: "vcB",
      privileged: false,
    });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /権限が必要/);
  });

  test("別VCでも特権があればスキップできる", () => {
    assert.deepEqual(
      authorizeSkip({ botChannelId: "vcA", userChannelId: "vcB", privileged: true }),
      { allowed: true }
    );
  });
});

describe("運用者の判定 (/dict word)", () => {
  test("parseOperatorIds は空白と空要素を落とす", () => {
    assert.deepEqual([...parseOperatorIds(" 1, 2 ,,3 ")], ["1", "2", "3"]);
    assert.equal(parseOperatorIds("").size, 0);
    assert.equal(parseOperatorIds(undefined).size, 0);
  });

  test("resolveOwnerIds は User 所有と Team 所有の両方を扱う", () => {
    assert.deepEqual(resolveOwnerIds({ owner: { id: "u1" } }), ["u1"]);
    assert.deepEqual(
      resolveOwnerIds({ owner: { members: new Map([["t1", {}], ["t2", {}]]) } }),
      ["t1", "t2"]
    );
    assert.deepEqual(resolveOwnerIds({}), []);
    assert.deepEqual(resolveOwnerIds(null), []);
  });

  test("OPERATOR_IDS があればそれだけを許可する", () => {
    const operatorIds = parseOperatorIds("1,2");
    assert.equal(isOperator("1", { operatorIds, ownerIds: ["owner"] }), true);
    // allowlist を設定したら所有者も含めて明示が要る
    assert.equal(isOperator("owner", { operatorIds, ownerIds: ["owner"] }), false);
  });

  test("OPERATOR_IDS 未設定なら Bot 所有者だけ", () => {
    const operatorIds = parseOperatorIds("");
    assert.equal(isOperator("owner", { operatorIds, ownerIds: ["owner"] }), true);
    assert.equal(isOperator("other", { operatorIds, ownerIds: ["owner"] }), false);
    assert.equal(isOperator(undefined, { operatorIds, ownerIds: ["owner"] }), false);
    // 所有者を取得できなかった場合は誰も通さない
    assert.equal(isOperator("owner", { operatorIds, ownerIds: [] }), false);
  });
});
