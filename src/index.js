import "dotenv/config";
import { Client, GatewayIntentBits, Events, MessageFlags } from "discord.js";
import { commandMap } from "./commands/index.js";
import { getSession, enqueue, enqueueFile, leave, join } from "./player.js";
import {
  getGuildSettings,
  updateGuildSettings,
  getReadChannelIds,
  getIgnore,
} from "./store.js";
import {
  buildSpeech,
  formatAuthorName,
} from "./textProcessor.js";
import {
  isAutoJoinable,
  humanCount,
  isReadTargetChannel,
} from "./channels.js";
import { isIgnoredMessage, isIgnoredMember } from "./ignoreFilter.js";
import { isAlive } from "./voicevox.js";
import { startUserDictSync } from "./userDict.js";
import { logFishStatus } from "./tts.js";
import { logError } from "./log.js";
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

// 最終防衛ライン。1つのイベント処理の失敗でプロセスごと落ちると、全ギルドでセッション・
// キュー・WAV キャッシュが消えて復帰に時間がかかるため、ログだけ残して稼働を続ける。
process.on("unhandledRejection", (reason) => {
  logError("unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  logError("uncaughtException", err);
});

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

// イベントハンドラの最終防衛ライン。process の unhandledRejection まで届けば稼働は
// 続くが、どのイベントで落ちたのかがログから追えない。ハンドラ単位で包んで、
// 1件の不正データや一時的な例外を発生源つきで握り潰す。
function guard(name, handler) {
  return (...args) => {
    try {
      const result = handler(...args);
      if (typeof result?.catch === "function") {
        result.catch((err) => logError(`${name} の処理に失敗しました`, err));
      }
    } catch (err) {
      logError(`${name} の処理に失敗しました`, err);
    }
  };
}

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
  }
  // engine コンテナは user_dict を永続化しないため、保存済みの辞書を投入し直す。
  // ここで isAlive() を条件にしない — cold start で Engine の起動が遅れただけで
  // 辞書が Bot の再起動まで戻らなくなる。startUserDictSync() が Engine の状態を
  // 定期的に突き合わせ、消えていれば復旧後に入れ直す。
  startUserDictSync();
  logFishStatus(); // Fish Audio は任意。未設定でも VOICEVOX のみで動く
  await rejoinActiveChannels(c); // 再起動で消えたセッションを復帰
});

// 再起動で in-memory のセッションが消えるため、起動時に入り直す。
// Discord 上は幽霊接続として残るが新プロセスにはセッションが無く読み上げできないため。
async function rejoinActiveChannels(c) {
  for (const guild of c.guilds.cache.values()) {
    try {
      const me =
        guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      // 1) 再起動前にいた VC (幽霊接続) を最優先で復帰
      // 自動参加と同じフィルタを通す。片方だけ緩いと「自動参加では避ける AFK に
      // 再起動したら入っている」という食い違いが起きる。
      const ghost = me?.voice?.channel ?? null;
      let target = isAutoJoinable(ghost) ? ghost : null;
      // 2) 幽霊が無ければ、READ_CHANNELS 設定済みギルドに限り人のいる VC へ入る
      if (!target && readChannels.has(guild.id)) {
        target =
          guild.channels.cache.find(
            (ch) => isAutoJoinable(ch) && humanCount(ch) > 0
          ) ?? null;
      }
      if (!target) continue;
      if (humanCount(target) === 0) continue; // 人がいなければ入らない

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

client.on(Events.InteractionCreate, guard("InteractionCreate", onInteraction));

async function onInteraction(interaction) {
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
}

client.on(Events.MessageCreate, guard("MessageCreate", onMessage));

async function onMessage(message) {
  if (!message.guild) return;
  const guildId = message.guild.id;
  if (message.author.id === client.user.id) return;

  // 安価で無条件なBot判定をセッション確認より先に行う。
  if (message.author.bot && !getIgnore(guildId).readBots) return;

  const session = getSession(guildId);
  if (!session) return;
  // スレッドは親chの設定に従う (message.channelId はスレッドIDになるため)
  if (!isReadTargetChannel(message.channel, getReadChannelIds(guildId))) return;

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

  // 発言者ごとの声で読み上げる。話者解決 (resolveUserVoice) は外部通信を伴うため
  // ここでは待たず、userId だけ渡して drain() の中でキュー順に直列で解決させる
  // (先に await すると、後続の発言が先に enqueue されて発言順が逆転するため)。
  // キュー上限などで受理されなかった発言は「最後に読み上げた発言者」に含めない。
  if (enqueue(guildId, text, { userId: message.author.id }) && speakerState) {
    lastSpeaker.set(guildId, speakerState);
  }
}

client.on(Events.VoiceStateUpdate, guard("VoiceStateUpdate", onVoiceStateUpdate));

async function onVoiceStateUpdate(oldState, newState) {
  const guildId = newState.guild.id;
  const member = newState.member;
  if (member?.user?.bot) return; // Bot 自身の状態変化は無視

  // 人が VC に入ってきて Bot が未接続なら自動参加。
  // 入室 (ch が変わった) ときだけに限定する。newState.channel は self-mute/deaf/stream の
  // 切替でも truthy なので、これを見ないと明示的な /leave 直後に居残りメンバーが
  // ミュートを押しただけで Bot が戻ってきてしまう。
  const joined = newState.channel;
  const entered = oldState.channelId !== newState.channelId && newState.channelId;
  if (entered && isAutoJoinable(joined) && !getSession(guildId)) {
    try {
      await join(joined);
      // Ready 待ちの間に最後の1人が抜けているとこの時点で無人になる。自動退出は
      // VoiceStateUpdate 起点なので、放置すると Bot だけが VC に取り残される。
      if (humanCount(joined) === 0) {
        leave(guildId);
        return;
      }
      // 読み上げ対象chは既存設定を維持し、未設定のときだけ READ_CHANNELS で補完する
      // (起動時再入室と同じ優先順位)。毎回上書きすると、/join で #tts に絞った設定が
      // 全員退出 → 再入室のたびに消え、非公開chまで公開VCへ読み上げてしまう。
      const current = getGuildSettings(guildId).channelId;
      updateGuildSettings(guildId, {
        channelId: current ?? readChannels.get(guildId) ?? null,
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
    // 本文につける発言者名と同じサニタイズを通す。ニックネームは 32 文字まで
    // 任意の Unicode を入れられるので、辞書適用だけだとカスタム絵文字記法や
    // 絵文字がそのまま VOICEVOX に渡り、記号と数字が延々読み上げられる。
    const name = formatAuthorName(member, member?.user, guildId);
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
    if (humanCount(left) === 0) leave(guildId);
  }
}

client.login(DISCORD_TOKEN);
