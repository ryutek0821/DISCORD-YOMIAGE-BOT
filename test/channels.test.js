import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import {
  isAutoJoinable,
  humanCount,
  isReadTargetChannel,
  readTargetIdFor,
  waitForBotChannel,
} from "../src/channels.js";

function voiceChannel({ id = "vc1", type = ChannelType.GuildVoice, afkChannelId = null } = {}) {
  return { id, type, guild: { id: "g1", afkChannelId } };
}

function members(list) {
  return new Map(list.map((m, i) => [String(i), m]));
}

test("isAutoJoinable は通常の VC だけを許可する", () => {
  assert.equal(isAutoJoinable(voiceChannel()), true);
  assert.equal(isAutoJoinable(null), false);
  assert.equal(isAutoJoinable(voiceChannel({ type: ChannelType.GuildText })), false);
});

test("isAutoJoinable はステージチャンネルを除外する", () => {
  // ステージでは Bot が audience として suppress され、再生しても誰にも聞こえない
  assert.equal(
    isAutoJoinable(voiceChannel({ type: ChannelType.GuildStageVoice })),
    false
  );
});

test("isAutoJoinable は AFK チャンネルを除外する", () => {
  // AFK に入ると getSession() が truthy になり、通常VCへ移動できなくなる
  assert.equal(
    isAutoJoinable(voiceChannel({ id: "afk", afkChannelId: "afk" })),
    false
  );
  assert.equal(
    isAutoJoinable(voiceChannel({ id: "vc1", afkChannelId: "afk" })),
    true
  );
});

test("humanCount は Bot を数えない", () => {
  const channel = {
    members: members([
      { user: { bot: false } },
      { user: { bot: true } },
      { user: { bot: false } },
    ]),
  };
  assert.equal(humanCount(channel), 2);
  assert.equal(humanCount({ members: members([{ user: { bot: true } }]) }), 0);
  assert.equal(humanCount(null), 0);
  assert.equal(humanCount({}), 0);
});

test("isReadTargetChannel は targets が空なら全チャンネルを対象にする", () => {
  assert.equal(isReadTargetChannel({ id: "c1" }, []), true);
  assert.equal(isReadTargetChannel({ id: "c1" }, undefined), true);
});

test("isReadTargetChannel は完全一致で判定する", () => {
  assert.equal(isReadTargetChannel({ id: "c1" }, ["c1"]), true);
  assert.equal(isReadTargetChannel({ id: "c2" }, ["c1"]), false);
  assert.equal(isReadTargetChannel(null, ["c1"]), false);
});

test("isReadTargetChannel は親chが対象ならスレッドも対象にする", () => {
  const thread = { id: "t1", parentId: "c1", isThread: () => true };
  assert.equal(isReadTargetChannel(thread, ["c1"]), true);
  assert.equal(isReadTargetChannel(thread, ["t1"]), true);
  // 対象外chの配下スレッドは読み上げない
  assert.equal(isReadTargetChannel(thread, ["c2"]), false);
});

test("readTargetIdFor はスレッドなら親chのIDを返す", () => {
  assert.equal(readTargetIdFor({ id: "t1", parentId: "c1", isThread: () => true }), "c1");
  assert.equal(readTargetIdFor({ id: "c1", isThread: () => false }), "c1");
  assert.equal(readTargetIdFor({ id: "c1" }), "c1");
  assert.equal(readTargetIdFor(null), null);
});

function guildWithBotIn(channelId) {
  const me = { voice: { channelId } };
  return { members: { me } };
}

test("waitForBotChannel は Bot が既に対象chにいれば即座に成功する", async () => {
  const guild = guildWithBotIn("vcB");
  const result = await waitForBotChannel(
    { id: "vcB", guild },
    { timeoutMs: 200, intervalMs: 10 }
  );
  assert.equal(result, true);
});

test("waitForBotChannel は移動が完了するまで待つ", async () => {
  const guild = guildWithBotIn("vcA");
  setTimeout(() => {
    guild.members.me.voice.channelId = "vcB";
  }, 30);
  const result = await waitForBotChannel(
    { id: "vcB", guild },
    { timeoutMs: 1000, intervalMs: 5 }
  );
  assert.equal(result, true);
});

test("waitForBotChannel は移動しなければ timeout で失敗する", async () => {
  // VC-A に残ったまま = B 向けの音声が A へ流れる状態。join を成功させてはいけない
  const result = await waitForBotChannel(
    { id: "vcB", guild: guildWithBotIn("vcA") },
    { timeoutMs: 50, intervalMs: 5 }
  );
  assert.equal(result, false);
});

test("waitForBotChannel は Bot の Member が未キャッシュなら検証不能として通す", async () => {
  const result = await waitForBotChannel(
    { id: "vcB", guild: { members: {} } },
    { timeoutMs: 50, intervalMs: 5 }
  );
  assert.equal(result, true);
  assert.equal(await waitForBotChannel({ id: "vcB" }, { timeoutMs: 50 }), false);
});
