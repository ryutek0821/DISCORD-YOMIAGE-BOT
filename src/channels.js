// チャンネルまわりの判定を1か所にまとめる。自動参加 (VoiceStateUpdate) と起動時再入室
// (rejoinActiveChannels) は同じ条件で入室先を選ぶ必要があり、片方だけ直すと
// 「自動参加では避けるのに再起動すると入ってしまう」といった食い違いが生まれるため。
import { ChannelType } from "discord.js";
import { setTimeout as sleep } from "node:timers/promises";

// Bot 自身の VoiceState が対象chになるまで待つ既定時間。
const BOT_CHANNEL_TIMEOUT_MS = 10_000;
const BOT_CHANNEL_INTERVAL_MS = 150;

// 自動で入ってよい VC か。
// - AFK: 入ると getSession() が truthy になり、その後に通常VCへ人が集まっても
//   自動参加が弾かれて移動できない (AFK から人が抜けるまで自動退出も起きない)。
// - ステージ: Bot は audience として suppress された状態で接続されるため、
//   再生しても誰にも聞こえないまま「読み上げている」状態になる。
export function isAutoJoinable(channel) {
  if (!channel) return false;
  if (channel.type !== ChannelType.GuildVoice) return false;
  if (channel.guild?.afkChannelId && channel.guild.afkChannelId === channel.id) {
    return false;
  }
  return true;
}

// VC 内の人間 (Bot以外) の人数。members は discord.js の Collection だが、
// テストの素の Map でも動くよう values() だけで数える。
export function humanCount(channel) {
  const members = channel?.members;
  if (!members?.values) return 0;
  let count = 0;
  for (const member of members.values()) {
    if (!member?.user?.bot) count += 1;
  }
  return count;
}

// 読み上げ対象chの判定。targets が空なら「制限なし」。
// スレッド内の発言は message.channelId が親chではなくスレッドIDになるため、
// ID の完全一致だけだと /config channels add:#general を設定した瞬間に
// #general 配下のスレッドが一切読まれなくなる (しかもスレッドは
// addChannelTypes の対象外なので追加する手段も無い)。親chが対象なら
// 配下のスレッドも対象として扱う。
export function isReadTargetChannel(channel, targets) {
  if (!Array.isArray(targets) || targets.length === 0) return true;
  if (!channel) return false;
  if (targets.includes(channel.id)) return true;
  if (channel.isThread?.() && channel.parentId) {
    return targets.includes(channel.parentId);
  }
  return false;
}

// /join や自動参加で保存する読み上げ対象ch。スレッドで実行された場合は親chを保存する。
// スレッドIDをそのまま保存すると、アーカイブされた時点でどの発言も読み上げられなくなる。
export function readTargetIdFor(channel) {
  if (!channel) return null;
  if (channel.isThread?.() && channel.parentId) return channel.parentId;
  return channel.id;
}

// Bot 自身の VoiceState が対象chを指すまで待つ。
// @discordjs/voice は同一 guild の既存 connection を使い回すため、VC-A で既に Ready なら
// VC-B への移動を要求しても entersState(Ready) は移動完了前に即解決してしまう。
// 「Bot の VoiceState が B になったか」が移動完了を確認できる唯一のシグナル。
export async function waitForBotChannel(
  channel,
  { timeoutMs = BOT_CHANNEL_TIMEOUT_MS, intervalMs = BOT_CHANNEL_INTERVAL_MS } = {}
) {
  const guild = channel?.guild;
  if (!guild) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const me = guild.members?.me;
    // Bot 自身の GuildMember が未キャッシュなら移動を検証しようがない。
    // ここで false を返すと全 join が失敗するので、検証不能として素通しする。
    if (!me) return true;
    if (me.voice?.channelId === channel.id) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
