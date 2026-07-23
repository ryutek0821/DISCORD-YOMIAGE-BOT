import "dotenv/config";
import { Client, GatewayIntentBits, Events, MessageFlags } from "discord.js";
import { commandMap } from "./commands/index.js";
import { getSession, enqueue, enqueueFile, leave, join } from "./player.js";
import {
  getGuildSettings,
  updateGuildSettings,
  getUserDict,
  getReadChannelIds,
  getIgnore,
} from "./store.js";
import {
  buildSpeech,
  applyDictionary,
  formatAuthorName,
} from "./textProcessor.js";
import { isIgnoredMessage, isIgnoredMember } from "./ignoreFilter.js";
import { isAlive, importUserDict } from "./voicevox.js";
import { resolveUserVoice } from "./userVoice.js";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";

// 特定フレーズで効果音を鳴らすマッピング
const SOUND_DIR = pathJoin(dirname(fileURLToPath(import.meta.url)), "..");
const SOUND_TRIGGERS = new Map([
  ["やりますねぇ！", pathJoin(SOUND_DIR, "sound_quiet.wav")],
]);

// guildId -> { channelId, userId, at }。発言者名 changed 判定専用の一時状態。
const lastSpeaker = new Map();
const AUTHOR_NAME_RESET_MS = 5 * 60_000;

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN を .env に設定してください。");
  process.exit(1);
}

// READ_CHANNELS="guildId:channelId,guildId:channelId" を Map に
const readChannels = new Map(
  (process.env.READ_CHANNELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => pair.split(":").map((x) => x.trim()))
    .filter(([g, c]) => g && c)
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`ログイン: ${c.user.tag}`);
  if (!(await isAlive())) {
    console.warn(
      "VOICEVOX Engine に接続できません。docker compose up -d で起動してください。"
    );
  } else {
    await syncUserDict(); // engine コンテナ再作成で消えたユーザー辞書を復元
  }
  await rejoinActiveChannels(c); // 再起動で消えたセッションを復帰
});

// VOICEVOX の user_dict はコンテナに永続化されないため、起動のたびに
// data/userDict.json の内容を engine へ再投入する (uuid はそのまま使うので重複登録にはならない)。
async function syncUserDict() {
  try {
    const entries = getUserDict();
    if (entries.length === 0) return;
    await importUserDict(entries);
    console.log(`ユーザー辞書を復元しました (${entries.length}件)`);
  } catch (err) {
    console.error("ユーザー辞書の復元に失敗:", err);
  }
}

// 再起動で in-memory のセッションが消えるため、起動時に入り直す。
// Discord 上は幽霊接続として残るが新プロセスにはセッションが無く読み上げできないため。
async function rejoinActiveChannels(c) {
  for (const guild of c.guilds.cache.values()) {
    try {
      const me =
        guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      // 1) 再起動前にいた VC (幽霊接続) を最優先で復帰
      let target = me?.voice?.channel ?? null;
      // 2) 幽霊が無ければ、READ_CHANNELS 設定済みギルドに限り人のいる VC へ入る
      if (!target && readChannels.has(guild.id)) {
        target =
          guild.channels.cache.find(
            (ch) => ch.isVoiceBased?.() && ch.members.some((m) => !m.user.bot)
          ) ?? null;
      }
      if (!target) continue;
      if (target.members.filter((m) => !m.user.bot).size === 0) continue; // 人がいなければ入らない

      await join(target);
      // 読み上げ対象chは既存設定を維持 (/join や前回参加で決まった値を尊重)、未設定なら READ_CHANNELS
      const current = getGuildSettings(guild.id).channelId;
      updateGuildSettings(guild.id, {
        channelId: current ?? readChannels.get(guild.id) ?? null,
      });
      console.log(`起動時の自動再入室: ${guild.name} / ${target.name}`);
    } catch (err) {
      console.error("起動時の自動再入室に失敗:", err);
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commandMap.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`コマンド ${interaction.commandName} でエラー:`, err);
    const content = "コマンド実行中にエラーが発生しました。";
    if (interaction.deferred && !interaction.replied) {
      // defer 済みで未応答の場合は editReply でないと「考え中…」のまま残ってしまう
      await interaction.editReply({ content }).catch(() => {});
    } else if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild) return;
  const guildId = message.guild.id;
  if (message.author.id === client.user.id) return;

  // 安価で無条件なBot判定をセッション確認より先に行う。
  if (message.author.bot && !getIgnore(guildId).readBots) return;

  const session = getSession(guildId);
  if (!session) return;
  const targets = getReadChannelIds(guildId);
  if (targets.length > 0 && !targets.includes(message.channelId)) return;

  // ユーザー・個人ミュート・プレフィックスの除外は効果音判定より先。
  if (isIgnoredMessage(message, client.user.id)) return;

  // 効果音トリガー (完全一致) は TTS せず WAV を再生
  const sound = SOUND_TRIGGERS.get(message.content.trim());
  if (sound) {
    enqueueFile(guildId, sound);
    return;
  }

  let text = buildSpeech(message, guildId);
  if (!text) return;

  // 発言者ごとの声で読み上げる (未設定者は userId から固定割り当て)
  const voice = await resolveUserVoice(message.author.id, guildId);
  const authorMode = getGuildSettings(guildId).readAuthorName;
  let speakerState = null;
  if (authorMode === "always" || authorMode === "changed") {
    const now = Date.now();
    const previous = lastSpeaker.get(guildId);
    const changed =
      !previous ||
      previous.channelId !== message.channelId ||
      previous.userId !== message.author.id ||
      now - previous.at >= AUTHOR_NAME_RESET_MS;
    if (authorMode === "always" || changed) {
      const name = formatAuthorName(message.member, message.author, guildId);
      text = `${name} ${text}`;
    }
    speakerState = {
      channelId: message.channelId,
      userId: message.author.id,
      at: now,
    };
  }

  // キュー上限などで受理されなかった発言は「最後に読み上げた発言者」に含めない。
  if (enqueue(guildId, text, voice) && speakerState) {
    lastSpeaker.set(guildId, speakerState);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guildId = newState.guild.id;
  const member = newState.member;
  if (member?.user?.bot) return; // Bot 自身の状態変化は無視

  // 人が VC に入ってきて Bot が未接続なら自動参加
  const joined = newState.channel;
  if (joined && !getSession(guildId)) {
    try {
      await join(joined);
      // 自動参加時の読み上げ対象 (ギルドごとの指定があればそのchのみ)
      updateGuildSettings(guildId, {
        channelId: readChannels.get(guildId) || null,
      });
    } catch (err) {
      console.error("自動参加に失敗:", err);
    }
  }

  const botChannelId = newState.guild.members.me?.voice?.channelId;
  // Bot のいるチャンネルへの参加 / からの退出を読み上げ
  const settings = getGuildSettings(guildId);
  const userId = member?.user?.id;
  if (
    botChannelId &&
    settings.announceVoiceState &&
    !isIgnoredMember(guildId, userId)
  ) {
    const rawName = member?.displayName ?? member?.user?.username ?? "誰か";
    const name = applyDictionary(rawName, guildId);
    const cameIn =
      newState.channelId === botChannelId && oldState.channelId !== botChannelId;
    const wentOut =
      oldState.channelId === botChannelId && newState.channelId !== botChannelId;
    if (cameIn) enqueue(guildId, `${name}が参加しました`);
    else if (wentOut) enqueue(guildId, `${name}が退出しました`);
  }

  // Bot のいる VC が Bot だけになったら自動退出。
  // 退出があったchが Bot のいるchかを必ず確認する (確認しないと、Bot が VC-A で読み上げ中に
  // 無関係な VC-B から最後の1人が抜けただけで VC-A から蹴り出されてしまう)。
  const left = oldState.channel;
  if (left && botChannelId && left.id === botChannelId && getSession(guildId)) {
    const humans = left.members.filter((m) => !m.user.bot).size;
    if (humans === 0) leave(guildId);
  }
});

client.login(DISCORD_TOKEN);
