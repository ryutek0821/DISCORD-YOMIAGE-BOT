import { getDictionary } from "./store.js";

const MAX_LENGTH = 50;

// サーバー辞書による読み替え (単純な全置換)
export function applyDictionary(text, guildId) {
  for (const { word, reading } of getDictionary(guildId)) {
    if (!word) continue;
    text = text.split(word).join(reading);
  }
  return text;
}

// 整形 -> 辞書適用 の順で読み上げ用テキストを生成する
export function buildSpeech(message, guildId) {
  let text = message.content ?? "";

  // コードブロック・インラインコード
  text = text.replace(/```[\s\S]*?```/g, " コード省略 ");
  text = text.replace(/`[^`]*`/g, " コード省略 ");

  // URL
  text = text.replace(/https?:\/\/\S+/gi, " URL省略 ");

  // メンション類 (取得できれば名前へ、無理なら除去)
  text = text.replace(/<@!?(\d+)>/g, (_, id) => {
    const m = message.mentions?.users?.get(id);
    return m ? ` ${m.username} ` : " ";
  });
  text = text.replace(/<@&(\d+)>/g, (_, id) => {
    const r = message.mentions?.roles?.get(id);
    return r ? ` ${r.name} ` : " ";
  });
  text = text.replace(/<#(\d+)>/g, (_, id) => {
    const c = message.mentions?.channels?.get(id);
    return c ? ` ${c.name} ` : " ";
  });

  // カスタム絵文字 <:name:id> / <a:name:id> -> name
  text = text.replace(/<a?:(\w+):\d+>/g, " $1 ");

  // Unicode 絵文字を除去
  text = text.replace(/\p{Extended_Pictographic}/gu, "");

  // 添付ファイルがあれば補足
  if (message.attachments?.size > 0 && !text.trim()) {
    text = "添付ファイル";
  }

  // 辞書による読み替え
  text = applyDictionary(text, guildId);

  // 連続空白を畳んで上限カット
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_LENGTH) {
    text = text.slice(0, MAX_LENGTH) + " 以下略";
  }

  return text;
}
