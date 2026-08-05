import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { join } from "../player.js";
import { readTargetIdFor } from "../channels.js";
import { updateGuildSettings } from "../store.js";
import { logError } from "../log.js";

export const data = new SlashCommandBuilder()
  .setName("join")
  .setDescription("あなたが参加中のボイスチャンネルに参加して読み上げを開始します");

export async function execute(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    await interaction.reply({
      content: "先にボイスチャンネルに参加してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // join() は Ready 待ちで最大20秒かかりうる。interaction は3秒以内に一次応答しないと
  // 失効する (10062 Unknown interaction) ため、必ず先に defer しておく。
  await interaction.deferReply();
  try {
    await join(channel);
  } catch (err) {
    logError(`${channel.name} への参加に失敗`, err);
    // 権限不足・満員・移動未確認は原因が分かる文言をそのまま返す (管理者が直せるため)。
    await interaction.editReply(
      err?.userFacing
        ? err.message
        : "ボイスチャンネルへの参加に失敗しました。もう一度お試しください。"
    );
    return;
  }
  // スレッドで実行された場合は親chを保存する。スレッドIDのまま保存すると、
  // アーカイブされた時点でどの発言も読み上げ対象に当たらなくなる。
  const readChannelId =
    readTargetIdFor(interaction.channel) ?? interaction.channelId;
  updateGuildSettings(interaction.guildId, { channelId: readChannelId });
  const where =
    readChannelId === interaction.channelId
      ? "このチャンネル"
      : `<#${readChannelId}>`;
  await interaction.editReply(
    `${channel.name} に参加しました。${where}（配下のスレッドを含む）の発言を読み上げます。`
  );
}
