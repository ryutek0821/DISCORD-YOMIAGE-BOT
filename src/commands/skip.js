import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { skip } from "../player.js";
import { authorizeSkip, isVoiceOperator } from "../authorize.js";
import { ja } from "./i18n.js";

export const data = new SlashCommandBuilder()
  .setName("skip")
  .setDescription("再生中の読み上げをスキップします")
  .addBooleanOption((option) =>
    option
      .setName("all")
      .setNameLocalizations(ja("キューも消す"))
      .setDescription("ONにするとキューに溜まっている分もまとめて消します")
      .setRequired(false)
  );

export async function execute(interaction) {
  // VC未参加者でも読み上げを止められてしまうため、VC外からのスキップは明示権限に限る。
  const verdict = authorizeSkip({
    botChannelId: interaction.guild?.members?.me?.voice?.channelId ?? null,
    userChannelId: interaction.member?.voice?.channel?.id ?? null,
    privileged: isVoiceOperator(interaction.memberPermissions),
  });
  if (!verdict.allowed) {
    await interaction.reply({
      content: verdict.reason,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const all = interaction.options.getBoolean("all") ?? false;
  const skipped = skip(interaction.guildId, all);
  const content = skipped
    ? all
      ? "再生中の読み上げをスキップし、キューも空にしました。"
      : "再生中の読み上げをスキップしました。"
    : "再生中の読み上げはありません。";
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}
