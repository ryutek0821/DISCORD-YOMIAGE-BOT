import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { getGuildSettings, updateGuildSettings } from "../store.js";

const AUTHOR_MODE_LABELS = {
  off: "OFF",
  changed: "発言者が変わったときだけ",
  always: "常に",
};

export const data = new SlashCommandBuilder()
  .setName("config")
  .setDescription("サーバーの読み上げ挙動を設定します")
  .addSubcommand((s) =>
    s.setName("show").setDescription("現在の読み上げ設定を表示します")
  )
  .addSubcommand((s) =>
    s
      .setName("set")
      .setDescription("読み上げ設定を変更します")
      .addBooleanOption((o) =>
        o
          .setName("announce_voice_state")
          .setDescription("VC参加・退出を読み上げる")
      )
      .addStringOption((o) =>
        o
          .setName("read_author_name")
          .setDescription("発言者名を読み上げる条件")
          .addChoices(
            { name: "読み上げない", value: "off" },
            { name: "発言者が変わったときだけ", value: "changed" },
            { name: "常に読み上げる", value: "always" }
          )
      )
      .addIntegerOption((o) =>
        o
          .setName("max_length")
          .setDescription("本文の最大文字数 (10〜200)")
          .setMinValue(10)
          .setMaxValue(200)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("channels")
      .setDescription("読み上げ対象チャンネルを変更します")
      .addChannelOption((o) =>
        o
          .setName("add")
          .setDescription("対象に追加するチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addChannelOption((o) =>
        o
          .setName("remove")
          .setDescription("対象から削除するチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addStringOption((o) =>
        o
          .setName("remove_id")
          .setDescription("削除済みチャンネルをIDで対象から外す")
          .setMinLength(1)
          .setMaxLength(30)
      )
      .addBooleanOption((o) =>
        o.setName("clear").setDescription("明示指定をすべて消す")
      )
  )
  .addSubcommand((s) =>
    s.setName("reset").setDescription("読み上げ設定を既定値に戻します")
  );

function hasManageGuild(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function effectiveMaxLength(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 50;
  return Math.min(200, Math.max(10, Math.trunc(value)));
}

function formatChannel(interaction, id) {
  const channel = interaction.guild?.channels.cache.get(id);
  return channel ? `#${channel.name}` : `(削除済み: ${id})`;
}

function formatSettings(interaction) {
  const settings = getGuildSettings(interaction.guildId);
  let channels;
  if (Array.isArray(settings.readChannelIds) && settings.readChannelIds.length > 0) {
    channels = `${settings.readChannelIds
      .map((id) => formatChannel(interaction, id))
      .join(", ")} （明示指定）`;
  } else if (settings.channelId) {
    channels = `${formatChannel(interaction, settings.channelId)}（/join で設定）`;
  } else {
    channels = "全チャンネル";
  }

  return [
    `読み上げ対象ch: ${channels}`,
    `VC参加/退出の読み上げ: ${settings.announceVoiceState ? "ON" : "OFF"}`,
    `発言者名の読み上げ: ${AUTHOR_MODE_LABELS[settings.readAuthorName] ?? "OFF"}`,
    `最大文字数: ${effectiveMaxLength(settings.maxLength)}`,
  ].join("\n");
}

async function replySettings(interaction, prefix) {
  const content = prefix
    ? `${prefix}\n${formatSettings(interaction)}`
    : formatSettings(interaction);
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "show") {
    await replySettings(interaction);
    return;
  }

  if (!hasManageGuild(interaction)) {
    await interaction.reply({
      content: "この操作には「サーバー管理」権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "set") {
    const announceVoiceState = interaction.options.getBoolean(
      "announce_voice_state"
    );
    const readAuthorName = interaction.options.getString("read_author_name");
    const maxLength = interaction.options.getInteger("max_length");
    const patch = {};
    if (announceVoiceState !== null) patch.announceVoiceState = announceVoiceState;
    if (readAuthorName !== null) patch.readAuthorName = readAuthorName;
    if (maxLength !== null) patch.maxLength = maxLength;
    if (Object.keys(patch).length > 0) updateGuildSettings(interaction.guildId, patch);
    await replySettings(
      interaction,
      Object.keys(patch).length > 0 ? "設定を更新しました。" : null
    );
    return;
  }

  if (sub === "channels") {
    const add = interaction.options.getChannel("add");
    const remove = interaction.options.getChannel("remove");
    const removeId = interaction.options.getString("remove_id");
    const clear = interaction.options.getBoolean("clear") === true;
    const current = getGuildSettings(interaction.guildId);
    let ids = clear
      ? []
      : Array.isArray(current.readChannelIds)
        ? [...current.readChannelIds]
        : [];

    if (remove) ids = ids.filter((id) => id !== remove.id);
    if (removeId) ids = ids.filter((id) => id !== removeId);
    if (add && !ids.includes(add.id)) {
      if (ids.length >= 10) {
        await interaction.reply({
          content: "登録できる対象chは10件までです。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      ids.push(add.id);
    }
    updateGuildSettings(interaction.guildId, { readChannelIds: ids });
    await replySettings(interaction, "読み上げ対象chを更新しました。");
    return;
  }

  updateGuildSettings(interaction.guildId, {
    readChannelIds: [],
    announceVoiceState: true,
    readAuthorName: "off",
    maxLength: 50,
  });
  await replySettings(interaction, "読み上げ設定を既定値に戻しました。");
}
