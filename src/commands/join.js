import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { join } from "../player.js";
import { updateGuildSettings } from "../store.js";

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
  await join(channel);
  updateGuildSettings(interaction.guildId, { channelId: interaction.channelId });
  await interaction.reply(
    `${channel.name} に参加しました。このチャンネルの発言を読み上げます。`
  );
}
