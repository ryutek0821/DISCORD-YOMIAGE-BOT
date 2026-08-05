// /voice list — 使える声の一覧 (旧 /speakers)。
// VOICEVOX の話者一覧に続けて Fish Audio のボイスも出す。
// 「/voice set に何を入れればいいか」を調べる口はここ1つに集約してあり、
// Fish 側の一覧を別コマンドで二重に持たない。
import { MessageFlags } from "discord.js";
import { getSpeakers } from "../voicevox.js";
import { isConfigured as isFishConfigured } from "../fishAudio.js";
import { getFishVoices, isBuiltinFishVoice } from "../store.js";
import { ja } from "./i18n.js";

export const listSubcommand = (s) =>
  s
    .setName("list")
    .setNameLocalizations(ja("声一覧"))
    .setDescription("使える声(VOICEVOX話者とFishボイス)の一覧を表示します");

// Fish のボイス一覧は完全にローカルの保存データなので、VOICEVOX が落ちていても出せる。
// FISH_API_KEY 未設定でも隠さない — 「登録済みなのに使えない」理由が分からなくなるため、
// 見出しで理由を添えて表示する。
async function followUpFishVoices(interaction) {
  const voices = Object.entries(getFishVoices());
  if (voices.length === 0) return;

  const header = isFishConfigured()
    ? "Fish Audio ボイス (`/voice set fish:<呼び出し名>` で選択):"
    : "Fish Audio ボイス (※ FISH_API_KEY が未設定のため現在は使えません):";
  const lines = voices.map(
    ([alias, v]) =>
      `${alias}: ${v.name}${isBuiltinFishVoice(alias) ? " (組み込み)" : ""}`
  );

  await interaction.followUp({
    content: header + "\n```\n" + lines.join("\n") + "\n```",
    flags: MessageFlags.Ephemeral,
  });
}

export async function executeList(interaction) {
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

    await interaction.editReply(
      "VOICEVOX 話者 (`/voice set speaker:<ID>` で選択):\n```\n" +
        (chunks[0] || "なし") +
        "```"
    );
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({
        content: "```\n" + chunks[i] + "```",
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch {
    await interaction.editReply(
      "話者一覧の取得に失敗しました。VOICEVOX Engine が起動しているか確認してください。"
    );
  }
  await followUpFishVoices(interaction);
}
