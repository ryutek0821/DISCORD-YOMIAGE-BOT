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
import { synth } from "./voicevox.js";
import { getGuildSettings } from "./store.js";
import { logError } from "./log.js";

// guildId -> { connection, player, queue, playing }
const sessions = new Map();

// 連投時にキューが無制限に伸びるのを防ぐ上限
const MAX_QUEUE = 100;

export function getSession(guildId) {
  return sessions.get(guildId);
}

export async function join(channel) {
  const guildId = channel.guild.id;
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  const session = { connection, player, queue: [], playing: false };
  sessions.set(guildId, session);

  player.on(AudioPlayerStatus.Idle, () => {
    session.playing = false;
    drain(guildId);
  });
  player.on("error", (err) => {
    console.error("AudioPlayer error:", err);
    session.playing = false;
    drain(guildId);
  });

  // 一時的な切断は再接続を試み、本当に切れた時だけ破棄する
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
    }
  });

  // 破棄されたらセッションを掃除する
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (sessions.get(guildId) === session) sessions.delete(guildId);
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  return session;
}

export function leave(guildId) {
  const session = sessions.get(guildId);
  if (session) {
    session.queue = [];
    session.connection.destroy();
    sessions.delete(guildId);
    return true;
  }
  const existing = getVoiceConnection(guildId);
  if (existing) {
    existing.destroy();
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

// WAV Buffer を ffmpeg で Opus に変換しつつ再生 (volume: 0.0〜1.0、デフォルト 1.0)
function wavToResource(wav, volume = 1.0) {
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
  Readable.from(wav).pipe(ff.stdin);
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
    let wav;
    let volume = 1.0;
    if (next.kind === "file") {
      wav = readFileSync(next.path);
      volume = next.volume ?? 1.0;
    } else {
      const { speaker, speed, pitch, intonation } =
        next.voice ?? getGuildSettings(guildId);
      wav = await synth(next.text, speaker, {
        speedScale: speed,
        pitchScale: pitch,
        intonationScale: intonation,
      });
    }
    session.player.play(wavToResource(wav, volume));
  } catch (err) {
    // 合成/再生に失敗した1件だけスキップして次のキューへ進む (VOICEVOX一時不通などで全体を止めない)
    logError(`再生に失敗したためスキップします (guild: ${guildId})`, err);
    session.playing = false;
    drain(guildId);
  }
}

export function enqueue(guildId, text, voice) {
  const session = sessions.get(guildId);
  if (!session || !text) return;
  if (session.queue.length >= MAX_QUEUE) return;
  session.queue.push({ kind: "tts", text, voice });
  drain(guildId);
}

export function enqueueFile(guildId, path, volume = 1.0) {
  const session = sessions.get(guildId);
  if (!session || !path) return;
  if (session.queue.length >= MAX_QUEUE) return;
  session.queue.push({ kind: "file", path, volume });
  drain(guildId);
}
