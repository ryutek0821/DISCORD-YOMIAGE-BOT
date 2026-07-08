// タイムスタンプ付きの簡易ロガー (guild 名があれば併記)
function stamp() {
  return new Date().toISOString();
}

export function log(msg, guildName) {
  console.log(`[${stamp()}]${guildName ? ` [${guildName}]` : ""} ${msg}`);
}

export function logError(msg, err, guildName) {
  console.error(`[${stamp()}]${guildName ? ` [${guildName}]` : ""} ${msg}`, err);
}
