import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  addDictionaryEntry,
  removeDictionaryEntry,
  getDictionary,
  addUserDictEntry,
  removeUserDictEntry,
  getUserDict,
} from "../store.js";
import {
  addUserDictWord,
  deleteUserDictWord,
  hiraganaToKatakana,
  isKatakana,
} from "../voicevox.js";

export const data = new SlashCommandBuilder()
  .setName("dict")
  .setDescription("読み替え辞書を管理します")
  .addSubcommandGroup((g) =>
    g
      .setName("replace")
      .setDescription("文字列の読み替え辞書 (単純な全置換)")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("読み替えを登録します")
          .addStringOption((o) =>
            o.setName("word").setDescription("対象の語").setRequired(true)
          )
          .addStringOption((o) =>
            o
              .setName("reading")
              .setDescription("読み (ひらがな/カタカナ推奨)")
              .setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("読み替えを削除します")
          .addStringOption((o) =>
            o.setName("word").setDescription("削除する語").setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s.setName("list").setDescription("登録済みの読み替えを一覧表示します")
      )
  )
  .addSubcommandGroup((g) =>
    g
      .setName("word")
      .setDescription("VOICEVOXユーザー辞書 (単語+読みの正式登録、読み精度が上がります)")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("VOICEVOXのユーザー辞書に単語を登録します")
          .addStringOption((o) =>
            o.setName("word").setDescription("対象の語").setRequired(true)
          )
          .addStringOption((o) =>
            o
              .setName("reading")
              .setDescription("読み (ひらがな/カタカナのみ)")
              .setRequired(true)
          )
          .addIntegerOption((o) =>
            o
              .setName("accent")
              .setDescription("アクセント型 (省略時は0=平板)")
              .setMinValue(0)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("VOICEVOXのユーザー辞書から単語を削除します")
          .addStringOption((o) =>
            o.setName("word").setDescription("削除する語").setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s.setName("list").setDescription("登録済みのユーザー辞書単語を一覧表示します")
      )
  );

export async function execute(interaction) {
  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  // 登録/削除は「サーバー管理」権限を持つ人のみ (list は全員可)
  if (sub === "add" || sub === "remove") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "この操作には「サーバー管理」権限が必要です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (group === "word") {
    await executeWord(interaction, sub);
    return;
  }

  // group === "replace" (デフォルトのサブコマンドグループ)
  await executeReplace(interaction, sub, guildId);
}

// 文字列の読み替え辞書 (既存の単純全置換ロジック、挙動は変更なし)
async function executeReplace(interaction, sub, guildId) {
  if (sub === "add") {
    const word = interaction.options.getString("word");
    const reading = interaction.options.getString("reading");
    addDictionaryEntry(guildId, word, reading);
    await interaction.reply({
      content: `登録しました: 「${word}」→「${reading}」`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "remove") {
    const word = interaction.options.getString("word");
    const removed = removeDictionaryEntry(guildId, word);
    await interaction.reply({
      content: removed ? `削除しました: 「${word}」` : `「${word}」は登録されていません。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // list
  const list = getDictionary(guildId);
  if (list.length === 0) {
    await interaction.reply({
      content: "登録されている読み替えはありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const body = list.map((e) => `「${e.word}」→「${e.reading}」`).join("\n");
  await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
}

// VOICEVOX ユーザー辞書 (単語+読みの正式登録)。全サーバー共通で保存する。
async function executeWord(interaction, sub) {
  if (sub === "add") {
    const word = interaction.options.getString("word");
    const rawReading = interaction.options.getString("reading");
    const accent = interaction.options.getInteger("accent") ?? 0;

    // ひらがな入力も許容し、全角カタカナへ変換してから VOICEVOX へ渡す
    const reading = hiraganaToKatakana(rawReading);
    if (!isKatakana(reading)) {
      await interaction.reply({
        content:
          "読みはひらがな/カタカナのみで入力してください (漢字・英数字・記号は登録できません)。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // 既に同じ語が登録済みならエンジン側の古いエントリを消してから登録し直す
    const existing = getUserDict().find((e) => e.word === word);
    if (existing?.uuid) {
      await deleteUserDictWord(existing.uuid).catch(() => {});
    }

    let uuid;
    try {
      uuid = await addUserDictWord(word, reading, accent, 5);
    } catch (err) {
      console.error("VOICEVOXユーザー辞書への登録に失敗:", err);
      await interaction.editReply(
        "VOICEVOXに接続できないため登録できませんでした。しばらくしてからもう一度お試しください。"
      );
      return;
    }

    addUserDictEntry(word, reading, accent, uuid);
    await interaction.editReply(
      `登録しました: 「${word}」→「${reading}」(アクセント型: ${accent})`
    );
    return;
  }

  if (sub === "remove") {
    const word = interaction.options.getString("word");
    const entry = removeUserDictEntry(word);
    if (!entry) {
      await interaction.reply({
        content: `「${word}」は登録されていません。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (entry.uuid) {
      await deleteUserDictWord(entry.uuid).catch((err) => {
        console.error("VOICEVOXユーザー辞書からの削除に失敗:", err);
      });
    }
    await interaction.reply({
      content: `削除しました: 「${word}」`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // list
  const list = getUserDict();
  if (list.length === 0) {
    await interaction.reply({
      content: "登録されているユーザー辞書単語はありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const body = list
    .map((e) => `「${e.word}」→「${e.reading}」(アクセント型: ${e.accent ?? 0})`)
    .join("\n");
  await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
}
