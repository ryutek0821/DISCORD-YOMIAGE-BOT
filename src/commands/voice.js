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
  .setDescription("自分の読み上げ話者・速度・声の高さ・抑揚を設定します")
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
  .addNumberOption((o) =>
    o
      .setName("pitch")
      .setDescription("声の高さ (-0.15〜0.15、標準0)")
      .setMinValue(-0.15)
      .setMaxValue(0.15)
  )
  .addNumberOption((o) =>
    o
      .setName("intonation")
      .setDescription("抑揚の強さ (0.0〜2.0、標準1.0)")
      .setMinValue(0.0)
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
  const pitch = interaction.options.getNumber("pitch");
  const intonation = interaction.options.getNumber("intonation");
  const reset = interaction.options.getBoolean("reset");
  const userId = interaction.user.id;

  // どの分岐も VOICEVOX への問い合わせ (話者一覧) を挟みうる。Engine の応答が遅いと
  // 3秒の一次応答期限を超えて interaction が失効するため、先に defer しておく。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 設定をリセットして自動(ランダム割り当て)に戻す
  if (reset) {
    clearUserSettings(userId);
    const eff = await resolveUserVoice(userId, interaction.guildId);
    await interaction.editReply(
      `自動(ランダム割り当て)に戻し、読み上げミュートも解除しました。現在の声: 話者ID=${eff.speaker}, 速度=${eff.speed}, 声の高さ=${eff.pitch}, 抑揚=${eff.intonation}`
    );
    return;
  }

  // 引数なし: 自分の実効設定を表示
  if (speaker === null && speed === null && pitch === null && intonation === null) {
    const s = getUserSettings(userId);
    const eff = await resolveUserVoice(userId, interaction.guildId);
    const note = s?.speaker == null ? "（自動割り当て）" : "";
    await interaction.editReply(
      `あなたの現在の声: 話者ID=${eff.speaker}${note}, 速度=${eff.speed}, 声の高さ=${eff.pitch}, 抑揚=${eff.intonation}`
    );
    return;
  }

  const patch = {};
  if (speaker !== null) {
    // 指定IDが存在するか検証
    try {
      const ids = await getSpeakerIds();
      if (!ids.includes(speaker)) {
        await interaction.editReply(
          `話者ID ${speaker} は存在しません。/speakers で確認してください。`
        );
        return;
      }
    } catch {
      // Engine 未起動などは検証スキップ
    }
    patch.speaker = speaker;
  }
  if (speed !== null) patch.speed = speed;
  if (pitch !== null) patch.pitch = pitch;
  if (intonation !== null) patch.intonation = intonation;

  const updated = updateUserSettings(userId, patch);
  await interaction.editReply(
    `あなたの声を更新しました: 話者ID=${
      updated.speaker ?? "(自動)"
    }, 速度=${updated.speed ?? 1.0}, 声の高さ=${updated.pitch ?? 0.0}, 抑揚=${
      updated.intonation ?? 1.0
    }`
  );
}
