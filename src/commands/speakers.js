import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { getSpeakers } from "../voicevox.js";
import { isConfigured as isFishConfigured } from "../fishAudio.js";
import { getFishVoices } from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("speakers")
  .setDescription("利用可能な話者(スタイル)IDの一覧を表示します");

// VOICEVOX 一覧の後に Fish Audio ボイスも見せる。取得は完全にローカルなので
// VOICEVOX が落ちていても表示できる。
async function followUpFishVoices(interaction) {
  if (!isFishConfigured()) return;
  const lines = Object.entries(getFishVoices()).map(
    ([alias, v]) => `${alias}: ${v.name}`
  );
  if (lines.length === 0) return;
  await interaction.followUp({
    content:
      "Fish Audio ボイス (`/voice fish:<呼び出し名>` で選択):\n```\n" +
      lines.join("\n") +
      "\n```",
    flags: MessageFlags.Ephemeral,
  });
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const speakers = await getSpeakers();
    const lines = [];
    for (const sp of speakers) {
      for (const st of sp.styles) {
        lines.push(`${st.id}: ${sp.name} (${st.name})`);
      }
    }
    // Discord のメッセージ上限対策で分割
    const chunks = [];
    let buf = "";
    for (const line of lines) {
      if (buf && buf.length + line.length + 1 > 1900) {
        chunks.push(buf);
        buf = "";
      }
      buf += line + "\n";
    }
    if (buf) chunks.push(buf);

    await interaction.editReply("```\n" + (chunks[0] || "なし") + "```");
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({
        content: "```\n" + chunks[i] + "```",
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    await interaction.editReply(
      "話者一覧の取得に失敗しました。VOICEVOX Engine が起動しているか確認してください。"
    );
  }
  await followUpFishVoices(interaction);
}
