import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  getFishVoices,
  addFishVoice,
  removeFishVoice,
  isBuiltinFishVoice,
} from "../store.js";
import {
  isConfigured as isFishConfigured,
  parseReferenceId,
  getModelInfo,
} from "../fishAudio.js";
import { logError } from "../log.js";
import { replyLines } from "./replyLines.js";

const ALIAS_PATTERN = /^[a-z0-9_-]{1,20}$/;

// 呼び出し名が省略されたときの自動生成。
// 表示名から ASCII 英数字を拾えればそれを、日本語だけの名前など拾えなければ
// モデルIDの先頭8桁を使う (一意性はIDに依存させる)。
function autoAlias(title, referenceId, existing) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
  const base = ALIAS_PATTERN.test(slug) ? slug : `m${referenceId.slice(0, 8)}`;
  // 既存の別ボイスとぶつかる場合だけ連番を足す (同じボイスの再登録は上書きさせる)
  if (!existing[base] || existing[base].referenceId === referenceId) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}`.slice(0, 20);
    if (!existing[candidate] || existing[candidate].referenceId === referenceId) {
      return candidate;
    }
  }
  return `m${referenceId.slice(0, 8)}`;
}

export const data = new SlashCommandBuilder()
  .setName("fishvoice")
  .setDescription("Fish Audio のボイスを管理します (/voice fish: で選択)")
  .addSubcommand((s) =>
    s.setName("list").setDescription("登録済みの Fish Audio ボイスを一覧表示します")
  )
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Fish Audio のボイスを登録します (URLを貼るだけでOK)")
      .addStringOption((o) =>
        o
          .setName("model")
          .setDescription("fish.audio のモデルURL、または32桁のモデルID")
          .setRequired(true)
          .setMaxLength(200)
      )
      .addStringOption((o) =>
        o
          .setName("alias")
          .setDescription("呼び出し名 (省略可。英小文字・数字・_ - のみ、20文字まで)")
          .setMaxLength(20)
      )
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("表示名 (省略時は fish.audio から自動取得)")
          .setMaxLength(50)
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
    await executeAdd(interaction);
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
  await executeList(interaction);
}

// URL を貼るだけで登録できるようにする。表示名は fish.audio から自動取得し、
// ついでに「そのモデルが実在して使えるか」も確認する (存在しないIDを登録すると
// 発言時に初めて合成が失敗して原因が分かりにくいため)。
async function executeAdd(interaction) {
  const modelInput = interaction.options.getString("model");
  const aliasInput = interaction.options.getString("alias");
  const nameInput = interaction.options.getString("name");

  const referenceId = parseReferenceId(modelInput);
  if (!referenceId) {
    await interaction.reply({
      content:
        "モデルを認識できませんでした。fish.audio のモデルページURL (例: `https://fish.audio/ja/m/0042f795e8744feba27460ce426d1500`) か、32桁のモデルIDを指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (aliasInput !== null && !ALIAS_PATTERN.test(aliasInput.trim().toLowerCase())) {
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

  const name = (nameInput ?? info.title ?? "").trim() || referenceId;
  const alias =
    aliasInput !== null
      ? aliasInput.trim().toLowerCase()
      : autoAlias(name, referenceId, getFishVoices());

  addFishVoice(alias, name, referenceId);

  const author = info.author ? ` / 作者: ${info.author}` : "";
  const langs = info.languages.length ? ` / 言語: ${info.languages.join(", ")}` : "";
  await interaction.editReply(
    [
      `登録しました: **${name}**${author}${langs}`,
      `ID: \`${referenceId}\` (${info.visibility})`,
      "",
      `全ユーザーが \`/voice fish:${alias}\` または \`/voice fish:${name}\` で使えます。`,
    ].join("\n")
  );
}

async function executeList(interaction) {
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
