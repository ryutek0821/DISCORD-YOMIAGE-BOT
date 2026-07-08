import "dotenv/config";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { commandMap } from "./commands/index.js";
import { getSession, enqueue, enqueueFile, leave, join } from "./player.js";
import { getGuildSettings, updateGuildSettings, getUserDict } from "./store.js";
import { buildSpeech, applyDictionary } from "./textProcessor.js";
import { isAlive, importUserDict } from "./voicevox.js";
import { resolveUserVoice } from "./userVoice.js";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";

// 特定フレーズで効果音を鳴らすマッピング
const SOUND_DIR = pathJoin(dirname(fileURLToPath(import.meta.url)), "..");
const SOUND_TRIGGERS = new Map([
  ["やりますねぇ！", pathJoin(SOUND_DIR, "sound_quiet.wav")],
]);

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
    const msg = { content: "コマンド実行中にエラーが発生しました。", flags: 64 };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;
  const session = getSession(message.guild.id);
  if (!session) return;
  const { channelId } = getGuildSettings(message.guild.id);
  if (channelId && message.channelId !== channelId) return;

  // 効果音トリガー (完全一致) は TTS せず WAV を再生
  const sound = SOUND_TRIGGERS.get(message.content.trim());
  if (sound) {
    enqueueFile(message.guild.id, sound);
    return;
  }

  const text = buildSpeech(message, message.guild.id);
  if (!text) return;
  // 発言者ごとの声で読み上げる (未設定者は userId から固定割り当て)
  const voice = await resolveUserVoice(message.author.id, message.guild.id);
  enqueue(message.guild.id, text, voice);
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
  const rawName = member?.displayName ?? member?.user?.username ?? "誰か";
  const name = applyDictionary(rawName, guildId);

  // Bot のいるチャンネルへの参加 / からの退出を読み上げ
  if (botChannelId) {
    const cameIn =
      newState.channelId === botChannelId && oldState.channelId !== botChannelId;
    const wentOut =
      oldState.channelId === botChannelId && newState.channelId !== botChannelId;
    if (cameIn) enqueue(guildId, `${name}が参加しました`);
    else if (wentOut) enqueue(guildId, `${name}が退出しました`);
  }

  // Bot のいる VC が Bot だけになったら自動退出
  const left = oldState.channel;
  if (left && getSession(guildId)) {
    const humans = left.members.filter((m) => !m.user.bot).size;
    if (humans === 0) leave(guildId);
  }
});

client.login(DISCORD_TOKEN);
