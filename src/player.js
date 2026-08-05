import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import ffmpegPath from "ffmpeg-static";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} from "@discordjs/voice";
import { synthVoice } from "./tts.js";
import { getGuildSettings } from "./store.js";
import { waitForBotChannel } from "./channels.js";
import { logError } from "./log.js";
import { resolveUserVoice } from "./userVoice.js";

// guildId -> { connection, player, queue, playing }
const sessions = new Map();

// 同一ギルドへの join が同時に走らないようにする。
// guildId -> { channelId, promise }
const pendingJoins = new Map();

// @discordjs/voice の joinVoiceChannel は同一 guildId の既存 connection を
// 使い回して返すため、join のたびにリスナーを付けると積み増しになる。
// 既に配線済みの connection を覚えておき、二重登録を防ぐ。
const wiredConnections = new WeakSet();

// 連投時にキューが無制限に伸びるのを防ぐ上限
const MAX_QUEUE = 100;

export function getSession(guildId) {
  return sessions.get(guildId);
}

export function join(channel) {
  const guildId = channel.guild.id;
  const pending = pendingJoins.get(guildId);
  if (pending) {
    // 同じchへの join なら相乗りする。
    // 別chが要求された場合に先行の Promise を返すと、要求と違うVCに入ったまま
    // 成功扱いになるので、先行の決着を待ってから改めて入り直す。
    if (pending.channelId === channel.id) return pending.promise;
    return pending.promise.catch(() => {}).then(() => join(channel));
  }
  const promise = doJoin(channel).finally(() => {
    if (pendingJoins.get(guildId)?.promise === promise) pendingJoins.delete(guildId);
  });
  pendingJoins.set(guildId, { channelId: channel.id, promise });
  return promise;
}

// 呼び出し側 (/join) がそのまま利用者に見せてよいエラー。
// 「権限が無い」「満員」を汎用文言に潰すと、管理者が直せる原因が伝わらない。
function joinError(message) {
  return Object.assign(new Error(message), { userFacing: true });
}

// 接続を張る前に権限を確かめる。joinable は View/Connect に加えて
// 「満員かつ MoveMembers を持たない」ケースも false になる。
function assertJoinable(channel) {
  if (channel.joinable === false) {
    throw joinError(
      `${channel.name} に接続できません (権限が無いか満員です)。`
    );
  }
  if (channel.speakable === false) {
    throw joinError(`${channel.name} で発言する権限がありません。`);
  }
}

async function doJoin(channel) {
  const guildId = channel.guild.id;
  assertJoinable(channel);

  // 同一ギルドで入り直す場合、古い player は使われなくなるので先に畳んでおく。
  // stop() は Idle を同期的に発火して drain() を呼ぶため、先に Map から外しておく。
  const previous = sessions.get(guildId);
  if (previous) {
    sessions.delete(guildId);
    previous.queue = [];
    previous.player.stop(true);
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  const session = { connection, player, queue: [], playing: false };

  player.on(AudioPlayerStatus.Idle, () => {
    session.playing = false;
    drain(guildId);
  });
  player.on("error", (err) => {
    logError(`AudioPlayer error (guild: ${guildId})`, err);
    session.playing = false;
    drain(guildId);
  });

  if (!wiredConnections.has(connection)) {
    wiredConnections.add(connection);

    // VoiceConnection は配下の WebSocket / UDP / DAVE のエラーをそのまま "error" として
    // emit する。EventEmitter はリスナー不在の 'error' で throw するため、購読していないと
    // UDP の ECONNRESET 1つで Bot プロセスごと落ちる。復旧は Disconnected 側に任せ、
    // ここではログに落として握りつぶす。
    connection.on("error", (err) => {
      logError(`VoiceConnection error (guild: ${guildId})`, err);
    });

    // 一時的な切断は再接続を試み、本当に切れた時だけ破棄する
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        destroyQuietly(connection);
      }
    });

    // 破棄されたらセッションを掃除する (どの世代の session でも拾えるよう connection で判定)
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      const current = sessions.get(guildId);
      if (current?.connection === connection) {
        current.queue = [];
        sessions.delete(guildId);
      }
    });
  }

  // Ready になって初めてセッションを登録する。先に登録すると、接続に失敗した時に
  // 死んだセッションが Map に残り、getSession() が truthy を返し続けてしまう
  // (= 読み上げは無音のまま、自動参加も !getSession() で弾かれて復帰できない)。
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    destroyQuietly(connection);
    throw err;
  }
  // Ready 待ちの間に /leave や自動退出で破棄されていた場合、登録すると
  // 二度と掃除されない死んだセッションが残るので入室failed扱いにする。
  if (connection.state.status === VoiceConnectionStatus.Destroyed) {
    throw new Error("接続が破棄されたため参加を中止しました");
  }
  // VC-A で Ready の connection を VC-B へ移動させた場合、entersState(Ready) は
  // 移動完了を待たずに即解決する。ここで確認せずに session を登録すると、
  // B 向けの音声が A へ流れたまま「B に参加しました」と応答してしまう。
  if (!(await waitForBotChannel(channel))) {
    destroyQuietly(connection);
    throw joinError(`${channel.name} への移動を確認できませんでした。`);
  }
  sessions.set(guildId, session);
  return session;
}

function destroyQuietly(connection) {
  try {
    connection.destroy();
  } catch {
    /* 既に破棄済み */
  }
}

export function leave(guildId) {
  const session = sessions.get(guildId);
  if (session) {
    session.queue = [];
    destroyQuietly(session.connection);
    sessions.delete(guildId);
    return true;
  }
  const existing = getVoiceConnection(guildId);
  if (existing) {
    destroyQuietly(existing);
    return true;
  }
  return false;
}

// 再生中の読み上げをスキップする。all=true ならキューも空にする。
// player.stop() で Idle イベントが発火し、drain() が次のキューを再生する。
export function skip(guildId, all = false) {
  const session = sessions.get(guildId);
  if (!session) return false;
  if (all) session.queue = [];
  return session.player.stop();
}

// 音声 Buffer を ffmpeg で Opus に変換しつつ再生 (volume: 0.0〜1.0、デフォルト 1.0)。
// 入力フォーマットは指定せず ffmpeg の自動判別に任せる (現状はどのエンジンも WAV)。
function audioToResource(audio, volume = 1.0) {
  const args = [
    "-i", "pipe:0",
    "-analyzeduration", "0",
    "-loglevel", "0",
  ];
  if (volume !== 1.0) {
    args.push("-af", `volume=${volume}`);
  }
  args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");

  const ff = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "ignore"] });
  // spawn 自体の失敗 (ENOENT・実行権限なし等) は 'error' イベントで飛んでくる。
  // 未処理だと EventEmitter が throw して Bot ごと落ちるので必ず握る。
  // stdout を destroy すると player 側が失敗を検知して Idle に戻り、次のキューへ進む。
  ff.on("error", (err) => {
    logError("ffmpeg の起動に失敗しました", err);
    ff.stdout.destroy();
  });
  Readable.from(audio).pipe(ff.stdin);
  ff.stdin.on("error", () => {});
  return createAudioResource(ff.stdout, { inputType: StreamType.Raw });
}

async function drain(guildId) {
  const session = sessions.get(guildId);
  if (!session || session.playing) return;
  const next = session.queue.shift();
  if (!next) return;

  session.playing = true;
  try {
    let audio;
    let volume = 1.0;
    if (next.kind === "file") {
      audio = readFileSync(next.path);
      volume = next.volume ?? 1.0;
    } else {
      // 話者解決はここ (合成の直前) でキュー順に直列で行う。enqueue() 時点で
      // await してしまうと、先行メッセージが話者一覧取得を待っている間に
      // 個人設定を持つ後続メッセージが先に enqueue され、発言順が逆転するため。
      let voice = next.voice;
      if (!voice && next.userId != null) {
        voice = await resolveUserVoice(next.userId, guildId);
      }
      audio = await synthVoice(guildId, next.text, voice ?? getGuildSettings(guildId));
    }
    session.player.play(audioToResource(audio, volume));
  } catch (err) {
    // 合成/再生に失敗した1件だけスキップして次のキューへ進む (エンジン一時不通などで全体を止めない)
    logError(`再生に失敗したためスキップします (guild: ${guildId})`, err);
    session.playing = false;
    drain(guildId);
  }
}

// opts.voice を渡せば話者解決を省略できる (VC参加/退出通知など個人ボイスを使わない発言用)。
// opts.userId を渡すと、実際の話者解決 (resolveUserVoice) は drain() の中まで遅延される
// (キュー投入自体は外部通信を待たない同期処理にするため。詳細は drain() のコメント参照)。
export function enqueue(guildId, text, opts = {}) {
  const session = sessions.get(guildId);
  if (!session || !text) return false;
  if (session.queue.length >= MAX_QUEUE) return false;
  const { voice, userId } = opts;
  session.queue.push({ kind: "tts", text, voice, userId });
  drain(guildId);
  return true;
}

export function enqueueFile(guildId, path, volume = 1.0) {
  const session = sessions.get(guildId);
  if (!session || !path) return;
  if (session.queue.length >= MAX_QUEUE) return;
  session.queue.push({ kind: "file", path, volume });
  drain(guildId);
}
