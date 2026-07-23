import { MessageFlags } from "discord.js";

// Discord のメッセージ上限 (2000字) に余裕を持たせて分割する。
const CHUNK_LIMIT = 1900;

export async function replyLines(interaction, lines, options = {}) {
  const chunks = [];
  let buf = "";
  for (const raw of lines) {
    const line =
      raw.length > CHUNK_LIMIT ? `${raw.slice(0, CHUNK_LIMIT - 1)}…` : raw;
    if (buf && buf.length + line.length + 1 > CHUNK_LIMIT) {
      chunks.push(buf);
      buf = "";
    }
    buf += line + "\n";
  }
  if (buf) chunks.push(buf);

  await interaction.reply({
    ...options,
    content: chunks[0],
    flags: MessageFlags.Ephemeral,
  });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({
      ...options,
      content: chunks[i],
      flags: MessageFlags.Ephemeral,
    });
  }
}
