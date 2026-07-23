import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import {
  addIgnorePrefix,
  addIgnoreUser,
  getIgnore,
  getUserSettings,
  removeIgnorePrefix,
  removeIgnoreUser,
  setReadBots,
  updateUserSettings,
} from "../store.js";
import { replyLines } from "./replyLines.js";

const ACTION_CHOICES = [
  { name: "追加", value: "add" },
  { name: "削除", value: "remove" },
];

export const data = new SlashCommandBuilder()
  .setName("ignore")
  .setDescription("読み上げない発言を設定します")
  .addSubcommand((s) =>
    s
      .setName("user")
      .setDescription("ユーザーを除外リストへ追加・削除します")
      .addUserOption((o) =>
        o.setName("target").setDescription("対象ユーザー").setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("action")
          .setDescription("操作")
          .setRequired(true)
          .addChoices(...ACTION_CHOICES)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("prefix")
      .setDescription("この文字から始まる発言を除外します")
      .addStringOption((o) =>
        o.setName("value").setDescription("1〜10文字").setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("action")
          .setDescription("操作")
          .setRequired(true)
          .addChoices(...ACTION_CHOICES)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("bots")
      .setDescription("他Botの発言を読み上げるか設定します")
      .addBooleanOption((o) =>
        o.setName("read").setDescription("読み上げる").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("me")
      .setDescription("自分の発言とVC参加・退出通知をミュートします")
      .addBooleanOption((o) =>
        o.setName("mute").setDescription("ミュートする").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s.setName("list").setDescription("現在の除外設定を表示します")
  );

function hasManageGuild(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function reply(interaction, content, extra = {}) {
  await interaction.reply({
    ...extra,
    content,
    flags: MessageFlags.Ephemeral,
  });
}

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (["user", "prefix", "bots"].includes(sub) && !hasManageGuild(interaction)) {
    await reply(interaction, "この操作には「サーバー管理」権限が必要です。");
    return;
  }

  if (sub === "user") {
    const target = interaction.options.getUser("target", true);
    const action = interaction.options.getString("action", true);
    if (target.id === interaction.client.user.id) {
      await reply(interaction, "このBot自身は除外ユーザーに指定できません。");
      return;
    }

    const users = getIgnore(guildId).users;
    const exists = users.includes(target.id);
    if (action === "add") {
      if (exists) {
        await reply(interaction, `${target} は既に除外されています。`, {
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (users.length >= 100) {
        await reply(interaction, "登録できる除外ユーザーは100人までです。");
        return;
      }
      addIgnoreUser(guildId, target.id);
      await reply(interaction, `${target} を除外しました。`, {
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (exists) removeIgnoreUser(guildId, target.id);
    await reply(
      interaction,
      exists ? `${target} の除外を解除しました。` : `${target} は除外されていません。`,
      { allowedMentions: { parse: [] } }
    );
    return;
  }

  if (sub === "prefix") {
    const action = interaction.options.getString("action", true);
    // 前後の空白を落としてから保存する。判定側は content.trimStart() 済みの本文と
    // 突き合わせるため、空白付きで登録すると絶対に一致しなくなる。
    const value = interaction.options.getString("value", true).trim();
    if (!value) {
      await reply(interaction, "プレフィックスに空白のみは指定できません。");
      return;
    }
    if (value.length > 10) {
      await reply(interaction, "プレフィックスは10文字までです。");
      return;
    }

    const prefixes = getIgnore(guildId).prefixes;
    const exists = prefixes.some(
      (prefix) => prefix.toLowerCase() === value.toLowerCase()
    );
    if (action === "add") {
      if (exists) {
        await reply(interaction, `「${value}」は既に登録されています。`);
        return;
      }
      if (prefixes.length >= 20) {
        await reply(interaction, "登録できるプレフィックスは20件までです。");
        return;
      }
      addIgnorePrefix(guildId, value);
      await reply(interaction, `プレフィックス「${value}」を登録しました。`);
      return;
    }

    if (exists) removeIgnorePrefix(guildId, value);
    await reply(
      interaction,
      exists
        ? `プレフィックス「${value}」を削除しました。`
        : `「${value}」は登録されていません。`
    );
    return;
  }

  if (sub === "bots") {
    const readBots = interaction.options.getBoolean("read", true);
    setReadBots(guildId, readBots);
    await reply(
      interaction,
      readBots
        ? "他Botの発言を読み上げます。Bot同士の応答ループに注意してください。"
        : "他Botの発言を読み上げない設定にしました。"
    );
    return;
  }

  if (sub === "me") {
    const mute = interaction.options.getBoolean("mute", true);
    updateUserSettings(interaction.user.id, { mute });
    await reply(
      interaction,
      mute
        ? "あなたの発言とVC参加・退出通知をミュートしました（全サーバー共通）。"
        : "あなたの読み上げミュートを解除しました（全サーバー共通）。"
    );
    return;
  }

  const config = getIgnore(guildId);
  const lines = ["除外ユーザー:"];
  if (config.users.length === 0) lines.push("なし");
  else lines.push(...config.users.map((id) => `<@${id}>`));
  lines.push("", "除外プレフィックス:");
  if (config.prefixes.length === 0) lines.push("なし");
  else lines.push(...config.prefixes.map((prefix) => `「${prefix}」`));
  lines.push(
    "",
    `他Botの発言を読み上げ: ${config.readBots ? "ON" : "OFF"}`,
    `あなたの読み上げミュート: ${
      getUserSettings(interaction.user.id)?.mute === true ? "ON" : "OFF"
    }`
  );
  await replyLines(interaction, lines, { allowedMentions: { parse: [] } });
}
