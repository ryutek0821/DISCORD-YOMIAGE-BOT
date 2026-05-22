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

// guildId -> { connection, player, queue, playing }
const sessions = new Map();

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

// WAV Buffer を ffmpeg で Opus に変換しつつ再生
function wavToResource(wav) {
  const ff = spawn(
    ffmpegPath,
    [
      "-i", "pipe:0",
      "-analyzeduration", "0",
      "-loglevel", "0",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "ignore"] }
  );
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
    if (next.kind === "file") {
      wav = readFileSync(next.path);
    } else {
      const { speaker, speed } = getGuildSettings(guildId);
      wav = await synth(next.text, speaker, speed);
    }
    session.player.play(wavToResource(wav));
  } catch (err) {
    console.error("play error:", err);
    session.playing = false;
    drain(guildId);
  }
}

export function enqueue(guildId, text) {
  const session = sessions.get(guildId);
  if (!session || !text) return;
  session.queue.push({ kind: "tts", text });
  drain(guildId);
}

export function enqueueFile(guildId, path) {
  const session = sessions.get(guildId);
  if (!session || !path) return;
  session.queue.push({ kind: "file", path });
  drain(guildId);
}
