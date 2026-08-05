import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  addDictionaryEntry,
  DICTIONARY_MAX_ENTRIES,
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
import {
  isOperator,
  parseOperatorIds,
  resolveOwnerIds,
} from "../authorize.js";
import { replyLines } from "./replyLines.js";
import { logError } from "../log.js";
import { ja } from "./i18n.js";

// 全サーバー共通のユーザー辞書を触れる運用者。未設定なら Bot 所有者だけ。
const operatorIds = parseOperatorIds(process.env.OPERATOR_IDS);

// /dict word は guildId を持たない全サーバー共通の VOICEVOX ユーザー辞書を操作し、
// 単一 Engine の全読み上げに効く。ギルドの ManageGuild で許すと、あるサーバーの
// 管理者が他サーバーの発音まで書き換えられ、list では他サーバー由来の登録語も読める。
async function isDictOperator(interaction) {
  const application = interaction.client?.application;
  // owner は fetch するまで埋まらない (2回目以降はキャッシュ済み)
  if (application && !application.owner) {
    await application.fetch().catch((err) => {
      logError("Application の所有者を取得できませんでした", err);
    });
  }
  return isOperator(interaction.user?.id, {
    operatorIds,
    ownerIds: resolveOwnerIds(application),
  });
}

export const data = new SlashCommandBuilder()
  .setName("dict")
  .setDescription("読み替え辞書を管理します")
  .addSubcommandGroup((g) =>
    g
      .setName("replace")
      .setNameLocalizations(ja("読み替え"))
      .setDescription("読み方を文字列の置き換えで直します (このサーバーのみ)")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setNameLocalizations(ja("追加"))
          .setDescription("読み替えを登録します (要サーバー管理)")
          .addStringOption((o) =>
            o
              .setName("word")
              .setNameLocalizations(ja("語"))
              .setDescription("読み方を直したい語")
              .setRequired(true)
              .setMaxLength(100)
          )
          .addStringOption((o) =>
            o
              .setName("reading")
              .setNameLocalizations(ja("読み"))
              .setDescription("読ませたい文字列 (ひらがな/カタカナ推奨、記号も可)")
              .setRequired(true)
              .setMaxLength(200)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setNameLocalizations(ja("削除"))
          .setDescription("読み替えを削除します (要サーバー管理)")
          .addStringOption((o) =>
            o
              .setName("word")
              .setNameLocalizations(ja("語"))
              .setDescription("削除する語")
              .setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("list")
          .setNameLocalizations(ja("一覧"))
          .setDescription("登録済みの読み替えを表示します")
      )
  )
  .addSubcommandGroup((g) =>
    g
      .setName("word")
      .setNameLocalizations(ja("単語登録"))
      .setDescription("VOICEVOXに単語として覚えさせます (全サーバー共通・Bot運用者専用)")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setNameLocalizations(ja("追加"))
          .setDescription("VOICEVOXのユーザー辞書に単語を登録します")
          .addStringOption((o) =>
            o
              .setName("word")
              .setNameLocalizations(ja("語"))
              .setDescription("読み方を覚えさせたい語")
              .setRequired(true)
              .setMaxLength(100)
          )
          .addStringOption((o) =>
            o
              .setName("reading")
              .setNameLocalizations(ja("読み"))
              .setDescription("読み方 (ひらがな/カタカナのみ)")
              .setRequired(true)
              .setMaxLength(200)
          )
          .addIntegerOption((o) =>
            o
              .setName("accent")
              .setNameLocalizations(ja("アクセント型"))
              .setDescription("音が下がる位置 (省略時は0=平板)")
              .setMinValue(0)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setNameLocalizations(ja("削除"))
          .setDescription("VOICEVOXのユーザー辞書から単語を削除します")
          .addStringOption((o) =>
            o
              .setName("word")
              .setNameLocalizations(ja("語"))
              .setDescription("削除する語")
              .setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("list")
          .setNameLocalizations(ja("一覧"))
          .setDescription("登録済みのユーザー辞書単語を表示します")
      )
  );

export async function execute(interaction) {
  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (group === "word") {
    // 全サーバー共通の辞書なので、閲覧も含めて運用者に限定する
    if (!(await isDictOperator(interaction))) {
      await interaction.reply({
        content:
          "/dict word は全サーバー共通の辞書のため、Bot の運用者しか操作・閲覧できません。このサーバーだけで使う読み替えは /dict replace を使ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await executeWord(interaction, sub);
    return;
  }

  // /dict replace はギルド単位なので従来どおり「サーバー管理」権限で足りる (list は全員可)
  if (sub === "add" || sub === "remove") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "この操作には「サーバー管理」権限が必要です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // group === "replace" (デフォルトのサブコマンドグループ)
  await executeReplace(interaction, sub, guildId);
}

// 文字列の読み替え辞書 (既存の単純全置換ロジック、挙動は変更なし)
async function executeReplace(interaction, sub, guildId) {
  if (sub === "add") {
    const word = interaction.options.getString("word");
    const reading = interaction.options.getString("reading");
    if (!addDictionaryEntry(guildId, word, reading)) {
      await interaction.reply({
        content: `辞書は最大 ${DICTIONARY_MAX_ENTRIES} 件までです。不要な語を /dict replace remove で削除してください。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
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
  await replyLines(
    interaction,
    list.map((e) => `「${e.word}」→「${e.reading}」`)
  );
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
  await replyLines(
    interaction,
    list.map((e) => `「${e.word}」→「${e.reading}」(アクセント型: ${e.accent ?? 0})`)
  );
}
