import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { leave } from "../player.js";
import { authorizeLeave, isVoiceOperator } from "../authorize.js";
import { updateGuildSettings } from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("leave")
  .setDescription("ボイスチャンネルから退出します");

export async function execute(interaction) {
  // VC未参加者でも読み上げを止められてしまうため、VC外からの切断は明示権限に限る。
  const verdict = authorizeLeave({
    botChannelId: interaction.guild?.members?.me?.voice?.channelId ?? null,
    userChannelId: interaction.member?.voice?.channelId ?? null,
    privileged: isVoiceOperator(interaction.memberPermissions),
  });
  if (!verdict.allowed) {
    await interaction.reply({
      content: verdict.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const left = leave(interaction.guildId);
  // 実際に退出したときだけ読み上げ元をリセットする (未接続なら書くこともない)
  if (left) updateGuildSettings(interaction.guildId, { channelId: null });
  await interaction.reply({
    content: left ? "退出しました。" : "参加していません。",
    flags: left ? undefined : MessageFlags.Ephemeral,
  });
}
