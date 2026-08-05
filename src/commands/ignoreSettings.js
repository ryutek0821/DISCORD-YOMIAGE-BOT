// /config ignore … — 読み上げ除外の設定 (旧 /ignore)。
// 「読み上げを減らす」操作は /config の VC参加通知ON/OFF や最大文字数と同じ性質なので、
// トップレベルに別コマンドを立てず /config の配下に置いてある。
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  addIgnorePrefix,
  addIgnoreUser,
  getIgnore,
  getUserSettings,
  removeIgnorePrefix,
  removeIgnoreUser,
  setReadBots,
  updateUserSettings,
} from "../store.js";
import { replyLines } from "./replyLines.js";
import { ja } from "./i18n.js";

const ACTION_CHOICES = [
  { name: "追加", value: "add" },
  { name: "削除", value: "remove" },
];

// ManageGuild を要求するサブコマンド。me は個人設定 (userSettings.mute)、
// list は閲覧のみなので誰でも実行できる。
const MANAGE_GUILD_SUBS = ["user", "prefix", "bots"];

export const ignoreGroup = (g) =>
  g
    .setName("ignore")
    .setNameLocalizations(ja("読み上げ除外"))
    .setDescription("読み上げない発言を設定します")
    .addSubcommand((s) =>
      s
        .setName("user")
        .setNameLocalizations(ja("ユーザー"))
        .setDescription("指定ユーザーの発言を読み上げない (要サーバー管理)")
        .addUserOption((o) =>
          o
            .setName("target")
            .setNameLocalizations(ja("対象ユーザー"))
            .setDescription("読み上げたくないユーザー")
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("action")
            .setNameLocalizations(ja("操作"))
            .setDescription("除外リストへ追加するか、除外を解除するか")
            .setRequired(true)
            .addChoices(...ACTION_CHOICES)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("prefix")
        .setNameLocalizations(ja("先頭文字"))
        .setDescription("この文字で始まる発言を読み上げない (要サーバー管理)")
        .addStringOption((o) =>
          o
            .setName("value")
            .setNameLocalizations(ja("文字列"))
            .setDescription("発言の先頭に付く文字列 (1〜10文字)")
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("action")
            .setNameLocalizations(ja("操作"))
            .setDescription("除外リストへ追加するか、除外を解除するか")
            .setRequired(true)
            .addChoices(...ACTION_CHOICES)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("bots")
        .setNameLocalizations(ja("bot発言"))
        .setDescription("他のBotの発言を読み上げるか決めます (要サーバー管理)")
        .addBooleanOption((o) =>
          o
            .setName("read")
            .setNameLocalizations(ja("読み上げる"))
            .setDescription("ONにすると他のBotの発言も読み上げます")
            .setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("me")
        .setNameLocalizations(ja("自分"))
        .setDescription("自分の発言とVC参加・退出通知をミュートします (全サーバー共通)")
        .addBooleanOption((o) =>
          o
            .setName("mute")
            .setNameLocalizations(ja("ミュートする"))
            .setDescription("ONにすると自分の発言が読み上げられなくなります")
            .setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("list")
        .setNameLocalizations(ja("一覧"))
        .setDescription("今の除外設定を表示します")
    );

function hasManageGuild(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function reply(interaction, content, extra = {}) {
  await interaction.reply({
    ...extra,
    content,
    flags: MessageFlags.Ephemeral,
  });
}

export async function executeIgnore(interaction, sub) {
  const guildId = interaction.guildId;

  // /config 自体は全ユーザーが変更できるが、除外設定はサブコマンド単位で権限が違う。
  // コマンド単位のガードに丸めると user/prefix/bots が誰でも触れるようになるので、
  // ここでサブコマンドごとに見る。
  if (MANAGE_GUILD_SUBS.includes(sub) && !hasManageGuild(interaction)) {
    await reply(interaction, "この操作には「サーバー管理」権限が必要です。");
    return;
  }

  if (sub === "user") {
    const target = interaction.options.getUser("target", true);
    const action = interaction.options.getString("action", true);
    if (target.id === interaction.client.user.id) {
      await reply(interaction, "このBot自身は除外ユーザーに指定できません。");
      return;
    }

    const users = getIgnore(guildId).users;
    const exists = users.includes(target.id);
    if (action === "add") {
      if (exists) {
        await reply(interaction, `${target} は既に除外されています。`, {
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (users.length >= 100) {
        await reply(interaction, "登録できる除外ユーザーは100人までです。");
        return;
      }
      addIgnoreUser(guildId, target.id);
      await reply(interaction, `${target} を除外しました。`, {
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (exists) removeIgnoreUser(guildId, target.id);
    await reply(
      interaction,
      exists ? `${target} の除外を解除しました。` : `${target} は除外されていません。`,
      { allowedMentions: { parse: [] } }
    );
    return;
  }

  if (sub === "prefix") {
    const action = interaction.options.getString("action", true);
    // 前後の空白を落としてから保存する。判定側は content.trimStart() 済みの本文と
    // 突き合わせるため、空白付きで登録すると絶対に一致しなくなる。
    const value = interaction.options.getString("value", true).trim();
    if (!value) {
      await reply(interaction, "プレフィックスに空白のみは指定できません。");
      return;
    }
    if (value.length > 10) {
      await reply(interaction, "プレフィックスは10文字までです。");
      return;
    }

    const prefixes = getIgnore(guildId).prefixes;
    const exists = prefixes.some(
      (prefix) => prefix.toLowerCase() === value.toLowerCase()
    );
    if (action === "add") {
      if (exists) {
        await reply(interaction, `「${value}」は既に登録されています。`);
        return;
      }
      if (prefixes.length >= 20) {
        await reply(interaction, "登録できるプレフィックスは20件までです。");
        return;
      }
      addIgnorePrefix(guildId, value);
      await reply(interaction, `プレフィックス「${value}」を登録しました。`);
      return;
    }

    if (exists) removeIgnorePrefix(guildId, value);
    await reply(
      interaction,
      exists
        ? `プレフィックス「${value}」を削除しました。`
        : `「${value}」は登録されていません。`
    );
    return;
  }

  if (sub === "bots") {
    const readBots = interaction.options.getBoolean("read", true);
    setReadBots(guildId, readBots);
    await reply(
      interaction,
      readBots
        ? "他Botの発言を読み上げます。Bot同士の応答ループに注意してください。"
        : "他Botの発言を読み上げない設定にしました。"
    );
    return;
  }

  if (sub === "me") {
    const mute = interaction.options.getBoolean("mute", true);
    updateUserSettings(interaction.user.id, { mute });
    await reply(
      interaction,
      mute
        ? "あなたの発言とVC参加・退出通知をミュートしました（全サーバー共通）。"
        : "あなたの読み上げミュートを解除しました（全サーバー共通）。"
    );
    return;
  }

  const config = getIgnore(guildId);
  const lines = ["除外ユーザー:"];
  if (config.users.length === 0) lines.push("なし");
  else lines.push(...config.users.map((id) => `<@${id}>`));
  lines.push("", "除外プレフィックス:");
  if (config.prefixes.length === 0) lines.push("なし");
  else lines.push(...config.prefixes.map((prefix) => `「${prefix}」`));
  lines.push(
    "",
    `他Botの発言を読み上げ: ${config.readBots ? "ON" : "OFF"}`,
    `あなたの読み上げミュート: ${
      getUserSettings(interaction.user.id)?.mute === true ? "ON" : "OFF"
    }`
  );
  await replyLines(interaction, lines, { allowedMentions: { parse: [] } });
}
