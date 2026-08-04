// テスト共通のセットアップ。外部 (Discord / VOICEVOX / Fish Audio / ffmpeg) には
// 一切接続せず、決定論的に完了させるための道具立て。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// store.js は import 時に data/ を読むため、import より前に呼ぶこと。
// 返り値の dir に *.json を置けば、その内容で store が起動する。
export function useTempDataDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yomiage-test-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      join(dir, name),
      typeof content === "string" ? content : JSON.stringify(content)
    );
  }
  process.env.YOMIAGE_DATA_DIR = dir;
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// voicevox.js / fishAudio.js は globalThis.fetch を呼び出し時に解決するので、
// ここを差し替えるだけでネットワークを断てる (production コードは無改変)。
// handler(url, init) が返した値をそのままレスポンスとして扱う。
export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => JSON.stringify(body),
  };
}

export function binaryResponse(buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    arrayBuffer: async () => buffer.buffer.slice(0),
    text: async () => "",
  };
}

// discord.js の Message を最小限だけ模したオブジェクト。
export function fakeMessage({
  content = "",
  authorId = "100",
  bot = false,
  guildId = "g1",
  attachments = 0,
  users = {},
  roles = {},
  channels = {},
} = {}) {
  const toMap = (obj) => new Map(Object.entries(obj));
  return {
    content,
    author: { id: authorId, bot },
    guild: { id: guildId },
    attachments: { size: attachments },
    mentions: {
      users: toMap(users),
      roles: toMap(roles),
      channels: toMap(channels),
    },
  };
}
