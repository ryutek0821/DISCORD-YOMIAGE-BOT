import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { getSpeakerIds } from "../voicevox.js";
import {
  getUserSettings,
  updateUserSettings,
  clearUserSettings,
} from "../store.js";
import { resolveUserVoice } from "../userVoice.js";

export const data = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("自分の読み上げ話者と速度を設定します")
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
  )
  .addBooleanOption((o) =>
    o
      .setName("reset")
      .setDescription("自分の設定を消して自動(ランダム割り当て)に戻す")
  );

export async function execute(interaction) {
  const speaker = interaction.options.getInteger("speaker");
  const speed = interaction.options.getNumber("speed");
  const reset = interaction.options.getBoolean("reset");
  const userId = interaction.user.id;

  // 設定をリセットして自動(ランダム割り当て)に戻す
  if (reset) {
    clearUserSettings(userId);
    const eff = await resolveUserVoice(userId, interaction.guildId);
    await interaction.reply({
      content: `自動(ランダム割り当て)に戻しました。現在の声: 話者ID=${eff.speaker}, 速度=${eff.speed}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 引数なし: 自分の実効設定を表示
  if (speaker === null && speed === null) {
    const s = getUserSettings(userId);
    const eff = await resolveUserVoice(userId, interaction.guildId);
    const note = s?.speaker == null ? "（自動割り当て）" : "";
    await interaction.reply({
      content: `あなたの現在の声: 話者ID=${eff.speaker}${note}, 速度=${eff.speed}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const patch = {};
  if (speaker !== null) {
    // 指定IDが存在するか検証
    try {
      const ids = await getSpeakerIds();
      if (!ids.includes(speaker)) {
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

  const updated = updateUserSettings(userId, patch);
  await interaction.reply({
    content: `あなたの声を更新しました: 話者ID=${
      updated.speaker ?? "(自動)"
    }, 速度=${updated.speed ?? 1.0}`,
    flags: MessageFlags.Ephemeral,
  });
}
