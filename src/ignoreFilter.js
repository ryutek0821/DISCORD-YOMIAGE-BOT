import { getIgnore, getUserSettings } from "./store.js";

// 発言者と本文に基づく除外判定。自Bot判定は呼び出し側にも置き、
// パイプラインが将来並び替わっても読み上げループを起こさないよう二重に守る。
export function isIgnoredMessage(message, clientUserId) {
  if (message.author.id === clientUserId) return true;

  const guildId = message.guild.id;
  const config = getIgnore(guildId);
  if (message.author.bot && !config.readBots) return true;
  if (config.users.includes(message.author.id)) return true;
  if (getUserSettings(message.author.id)?.mute === true) return true;

  const content = (message.content ?? "").trimStart().toLowerCase();
  // 生テキストで判定しつつ、インライン/ブロックコード先頭のバッククォートだけは
  // 無視する。これにより `;play` のように囲われたコマンドも除外できる。
  const unquotedContent = content.replace(/^`+/, "");
  return config.prefixes.some((prefix) => {
    const normalized = String(prefix).trim().toLowerCase();
    // 空文字は全発言に前方一致してしまい、読み上げが丸ごと止まる。
    // 手編集された ignore.json から入り込みうるのでここで弾く。
    if (!normalized) return false;
    return (
      content.startsWith(normalized) || unquotedContent.startsWith(normalized)
    );
  });
}

export function isIgnoredMember(guildId, userId) {
  return (
    getIgnore(guildId).users.includes(userId) ||
    getUserSettings(userId)?.mute === true
  );
}
