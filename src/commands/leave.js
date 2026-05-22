import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { leave } from "../player.js";
import { updateGuildSettings } from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("leave")
  .setDescription("ボイスチャンネルから退出します");

export async function execute(interaction) {
  const left = leave(interaction.guildId);
  updateGuildSettings(interaction.guildId, { channelId: null });
  await interaction.reply({
    content: left ? "退出しました。" : "参加していません。",
    flags: left ? undefined : MessageFlags.Ephemeral,
  });
}
