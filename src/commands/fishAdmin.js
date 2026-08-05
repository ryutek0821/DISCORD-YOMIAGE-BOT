// /voice fish add|remove — Fish Audio ボイスの登録・削除 (旧 /fishvoice)。
// 一覧は /voice list に統合したのでここには持たない。
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { addFishVoice, removeFishVoice, isBuiltinFishVoice } from "../store.js";
import {
  isConfigured as isFishConfigured,
  parseReferenceId,
  getModelInfo,
} from "../fishAudio.js";
import { logError } from "../log.js";
import { ja } from "./i18n.js";

const ALIAS_PATTERN = /^[a-z0-9_-]{1,20}$/;

export const fishGroup = (g) =>
  g
    .setName("fish")
    .setNameLocalizations(ja("fishボイス"))
    .setDescription("Fish Audio のボイスを登録・削除します")
    .addSubcommand((s) =>
      s
        .setName("add")
        .setNameLocalizations(ja("追加"))
        .setDescription("Fish Audio のボイスを登録します (URLを貼るだけでOK)")
        .addStringOption((o) =>
          o
            .setName("model")
            .setNameLocalizations(ja("モデル"))
            .setDescription("fish.audio のモデルURL、または32桁のモデルID")
            .setRequired(true)
            .setMaxLength(200)
        )
        .addStringOption((o) =>
          o
            .setName("alias")
            .setNameLocalizations(ja("呼び出し名"))
            .setDescription("呼び出し名 (英小文字・数字・_ - のみ、20文字まで)")
            .setRequired(true)
            .setMaxLength(20)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("remove")
        .setNameLocalizations(ja("削除"))
        .setDescription("登録済みの Fish Audio ボイスを削除します (要サーバー管理)")
        .addStringOption((o) =>
          o
            .setName("alias")
            .setNameLocalizations(ja("呼び出し名"))
            .setDescription("削除する呼び出し名")
            .setRequired(true)
        )
    );

export async function executeFish(interaction, sub) {
  // add は全員可。remove だけ「サーバー管理」権限を要求する。
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

    const alias = interaction.options.getString("alias", true).trim().toLowerCase();
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

  await executeAdd(interaction);
}

// URL を貼るだけで登録できるようにする。表示名は fish.audio から自動取得し、
// ついでに「そのモデルが実在して使えるか」も確認する (存在しないIDを登録すると
// 発言時に初めて合成が失敗して原因が分かりにくいため)。
async function executeAdd(interaction) {
  const modelInput = interaction.options.getString("model", true);
  const alias = interaction.options.getString("alias", true).trim().toLowerCase();

  const referenceId = parseReferenceId(modelInput);
  if (!referenceId) {
    await interaction.reply({
      content:
        "モデルを認識できませんでした。fish.audio のモデルページURL (例: `https://fish.audio/ja/m/0042f795e8744feba27460ce426d1500`) か、32桁のモデルIDを指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!ALIAS_PATTERN.test(alias)) {
    await interaction.reply({
      content: "呼び出し名は英小文字・数字・アンダースコア・ハイフンのみで指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isFishConfigured()) {
    await interaction.reply({
      content: "Fish Audio は未設定です (FISH_API_KEY)。サーバー管理者に設定を依頼してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // fish.audio への問い合わせが入るので 3 秒の一次応答期限を先に回避する
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let info;
  try {
    info = await getModelInfo(referenceId);
  } catch (err) {
    logError("Fish Audio のモデル情報取得に失敗しました", err);
    await interaction.editReply(
      `fish.audio への問い合わせに失敗しました (${err.message ?? "unknown"})。時間をおいて試してください。`
    );
    return;
  }

  if (!info) {
    await interaction.editReply(
      `モデル \`${referenceId}\` が見つかりません。URLが正しいか、モデルが非公開(private)になっていないか確認してください。`
    );
    return;
  }

  const name = String(info.title ?? "").trim() || referenceId;

  addFishVoice(alias, name, referenceId);

  const author = info.author ? ` / 作者: ${info.author}` : "";
  const langs = info.languages.length ? ` / 言語: ${info.languages.join(", ")}` : "";
  await interaction.editReply(
    [
      `登録しました: **${name}**${author}${langs}`,
      `ID: \`${referenceId}\` (${info.visibility})`,
      "",
      `全ユーザーが \`/voice set fish:${alias}\` または \`/voice set fish:${name}\` で使えます。`,
    ].join("\n")
  );
}
