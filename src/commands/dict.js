import { SlashCommandBuilder, MessageFlags } from "discord.js";
import {
  addDictionaryEntry,
  removeDictionaryEntry,
  getDictionary,
} from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("dict")
  .setDescription("読み替え辞書を管理します")
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("読み替えを登録します")
      .addStringOption((o) =>
        o.setName("word").setDescription("対象の語").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("reading").setDescription("読み (ひらがな/カタカナ推奨)").setRequired(true)
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
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

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
