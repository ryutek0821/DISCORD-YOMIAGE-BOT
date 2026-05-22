import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { getSpeakers } from "../voicevox.js";
import { getGuildSettings, updateGuildSettings } from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("話者と読み上げ速度を設定します")
  .addIntegerOption((o) =>
    o
      .setName("speaker")
      .setDescription("話者(スタイル)ID。/speakers で一覧を確認")
      .setMinValue(0)
  )
  .addNumberOption((o) =>
    o
      .setName("speed")
      .setDescription("読み上げ速度 (0.5〜2.0)")
      .setMinValue(0.5)
      .setMaxValue(2.0)
  );

export async function execute(interaction) {
  const speaker = interaction.options.getInteger("speaker");
  const speed = interaction.options.getNumber("speed");

  if (speaker === null && speed === null) {
    const s = getGuildSettings(interaction.guildId);
    await interaction.reply({
      content: `現在の設定: 話者ID=${s.speaker}, 速度=${s.speed}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const patch = {};
  if (speaker !== null) {
    // 指定IDが存在するか検証
    try {
      const speakers = await getSpeakers();
      const valid = speakers.some((sp) =>
        sp.styles.some((st) => st.id === speaker)
      );
      if (!valid) {
        await interaction.reply({
          content: `話者ID ${speaker} は存在しません。/speakers で確認してください。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    } catch {
      // Engine 未起動などは検証スキップ
    }
    patch.speaker = speaker;
  }
  if (speed !== null) patch.speed = speed;

  const updated = updateGuildSettings(interaction.guildId, patch);
  await interaction.reply(
    `設定を更新しました: 話者ID=${updated.speaker}, 速度=${updated.speed}`
  );
}
