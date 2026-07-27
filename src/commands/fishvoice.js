import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  getFishVoices,
  addFishVoice,
  removeFishVoice,
  isBuiltinFishVoice,
} from "../store.js";
import { isConfigured as isFishConfigured, isReferenceId } from "../fishAudio.js";
import { replyLines } from "./replyLines.js";

const ALIAS_PATTERN = /^[a-z0-9_-]{1,20}$/;

export const data = new SlashCommandBuilder()
  .setName("fishvoice")
  .setDescription("Fish Audio のボイスを管理します (/voice fish: で選択)")
  .addSubcommand((s) =>
    s.setName("list").setDescription("登録済みの Fish Audio ボイスを一覧表示します")
  )
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Fish Audio のボイスを登録します")
      .addStringOption((o) =>
        o
          .setName("alias")
          .setDescription("呼び出し名 (英小文字・数字・_ - のみ、20文字まで)")
          .setRequired(true)
          .setMaxLength(20)
      )
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("表示名")
          .setRequired(true)
          .setMaxLength(50)
      )
      .addStringOption((o) =>
        o
          .setName("reference_id")
          .setDescription("fish.audio のモデルID (32桁の16進数)")
          .setRequired(true)
          .setMinLength(32)
          .setMaxLength(32)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("登録済みの Fish Audio ボイスを削除します")
      .addStringOption((o) =>
        o.setName("alias").setDescription("削除する呼び出し名").setRequired(true)
      )
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  // add と list は全員可。remove だけ「サーバー管理」権限を要求する。
  // ボイス一覧は全サーバー共通なので、他人が登録したエントリを誰でも消せると
  // 事故ったときに戻せない (追加は上書きで直せるが削除は元IDが分からなくなる)。
  if (sub === "remove") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "削除には「サーバー管理」権限が必要です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (sub === "add") {
    const alias = interaction.options.getString("alias").trim().toLowerCase();
    const name = interaction.options.getString("name").trim();
    const referenceId = interaction.options
      .getString("reference_id")
      .trim()
      .toLowerCase();

    if (!ALIAS_PATTERN.test(alias)) {
      await interaction.reply({
        content: "呼び出し名は英小文字・数字・アンダースコア・ハイフンのみで指定してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!isReferenceId(referenceId)) {
      await interaction.reply({
        content:
          "reference_id は32桁の16進数で指定してください (fish.audio のモデルページURL末尾の文字列)。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    addFishVoice(alias, name, referenceId);
    await interaction.reply({
      content: `登録しました: ${alias} → ${name} (${referenceId})\n\`/voice fish:${alias}\` で使えます。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "remove") {
    const alias = interaction.options.getString("alias").trim().toLowerCase();
    const removed = removeFishVoice(alias);
    if (!removed && isBuiltinFishVoice(alias)) {
      await interaction.reply({
        content: `「${alias}」は組み込みボイスのため削除できません。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: removed
        ? `削除しました: ${alias}`
        : `「${alias}」は登録されていません。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // list
  const voices = Object.entries(getFishVoices());
  const header = isFishConfigured()
    ? "Fish Audio ボイス一覧 (`/voice fish:<呼び出し名>` で選択):"
    : "Fish Audio ボイス一覧 (※ FISH_API_KEY が未設定のため現在は利用できません):";
  const lines = [
    header,
    ...voices.map(
      ([alias, v]) =>
        `${alias}: ${v.name}${isBuiltinFishVoice(alias) ? " (組み込み)" : ""}`
    ),
  ];
  await replyLines(interaction, lines);
}
