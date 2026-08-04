import { getDictionary, getGuildSettings } from "./store.js";

const DEFAULT_MAX_LENGTH = 50;
const AUTHOR_NAME_MAX = 20;

// 辞書適用後の中間文字列の上限。辞書は「増幅してから切り詰める」順序で効くため、
// reading が別エントリの word を含まなくても 1エントリ 200 字 * 長文で中間文字列が
// 膨らみうる。ここで頭打ちにしないと最悪 RangeError: Invalid string length で落ちる。
const DICT_OUTPUT_MAX = 4000;

// 絵文字とその周辺の結合文字。Extended_Pictographic だけでは
// 国旗絵文字の構成要素 (Regional_Indicator)・ZWJ・異体字セレクタ・キーキャップが
// 残り、本体だけ消えて不可視文字が VOICEVOX に渡る。まとめて落とす。
// U+200D=ZWJ, U+FE0E/U+FE0F=異体字セレクタ, U+20E3=キーキャップ結合文字
// 正規表現リテラルに直接書くと不可視文字がソースに埋まってレビューできないため、
// エスケープ表記の文字列から組む。
const EMOJI_RE = new RegExp(
  "[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u200D\\uFE0E\\uFE0F\\u20E3]",
  "gu"
);

// カスタム絵文字 <:name:id> / <a:name:id>
const CUSTOM_EMOJI_RE = /<a?:(\w+):\d+>/g;

function resolveMaxLength(guildId) {
  const value = getGuildSettings(guildId).maxLength;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_LENGTH;
  }
  return Math.min(200, Math.max(10, Math.trunc(value)));
}

// コードポイント単位で切る。String#slice は UTF-16 コードユニット単位なので、
// BMP 外文字 (おしゃれフォント 𝓪、CJK 拡張漢字 𠮷 等) の途中で切ると孤立サロゲートが
// 残り、voicevox.js の encodeURIComponent() が URIError を投げて発言ごと捨てられる。
function sliceByCodePoint(text, max) {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, max).join("");
}

function escapeRegExp(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// サーバー辞書による読み替え。
//
// 逐次置換 (エントリごとに split/join) だと、あるエントリの reading が別エントリの
// word を含んだときに置換結果が再度置換され、登録順で結果が変わる
// ({田中→たなか} {たなか→タナカさん} で「田中さん」→「タナカさんさん」)。
// さらに連鎖すると中間文字列が指数的に膨らんでプロセスごと落ちる。
// 全エントリを 1 本の正規表現にまとめて 1 パスで同時置換することで両方を断つ。
export function applyDictionary(text, guildId) {
  const entries = getDictionary(guildId).filter((e) => e?.word);
  if (entries.length === 0) return text;

  // 長い順に並べて最長一致を担保する ({東京→…} {東京都→…} で「東京都」が勝つ)。
  const byWord = new Map();
  for (const { word, reading } of [...entries].sort(
    (a, b) => b.word.length - a.word.length
  )) {
    if (!byWord.has(word)) byWord.set(word, reading);
  }

  // word は `(^^)` のような記号を含みうるので必ずエスケープする。
  const pattern = [...byWord.keys()].map(escapeRegExp).join("|");
  // 置換値をコールバックで返し、reading 中の `$&` 等が特殊解釈されないようにする。
  const replaced = text.replace(
    new RegExp(pattern, "g"),
    (matched) => byWord.get(matched) ?? matched
  );

  return replaced.length > DICT_OUTPUT_MAX
    ? sliceByCodePoint(replaced, DICT_OUTPUT_MAX)
    : replaced;
}

// 表示名を読み上げ可能な形に整える。本文と違い Discord のニックネームは
// 32 文字まで任意の Unicode を入れられるので、記法と絵文字を落としてから切り詰める。
// 辞書適用は維持する (表示名を辞書で読み替える運用があるため)。
export function sanitizeName(rawName, guildId) {
  let name = String(rawName ?? "");
  name = name.replace(CUSTOM_EMOJI_RE, " $1 ");
  name = name.replace(EMOJI_RE, "");
  name = applyDictionary(name, guildId);
  name = name.replace(/\s+/g, " ").trim();
  if (!name) return "誰か";
  return sliceByCodePoint(name, AUTHOR_NAME_MAX);
}

export function formatAuthorName(member, user, guildId) {
  return sanitizeName(member?.displayName ?? user?.username ?? "誰か", guildId);
}

// 整形 -> 辞書適用 の順で読み上げ用テキストを生成する
export function buildSpeech(message, guildId) {
  let text = message.content ?? "";

  // スポイラー (||text||) はどの整形より先に潰す。URL 置換を先に通すと
  // `||https://example.com||` の末尾 `||` まで URL 正規表現が飲み込み、
  // 開始の `||` だけが残ってスポイラーと認識できなくなる。
  text = text.replace(/\|\|[\s\S]*?\|\|/g, " ネタバレ省略 ");

  // コードブロック・インラインコード
  text = text.replace(/```[\s\S]*?```/g, " コード省略 ");
  // 閉じていない fence は開始位置から文末まで省略する。貼り付け途中の長いコードや
  // 秘密値をそのまま VC で読み上げないため。
  text = text.replace(/```[\s\S]*$/, " コード省略 ");
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
  text = text.replace(CUSTOM_EMOJI_RE, " $1 ");

  // Unicode 絵文字と付随する結合文字を除去
  text = text.replace(EMOJI_RE, "");

  // 添付ファイルがあれば補足
  if (message.attachments?.size > 0 && !text.trim()) {
    text = "添付ファイル";
  }

  // Markdown 装飾記号を除去 (中身は読み上げる)
  text = text.replace(/\*\*(.+?)\*\*/gs, "$1"); // 太字
  text = text.replace(/__(.+?)__/gs, "$1"); // 下線
  text = text.replace(/~~(.+?)~~/gs, "$1"); // 打ち消し線
  text = text.replace(/\*(.+?)\*/gs, "$1"); // 斜体 (*)
  text = text.replace(/_(.+?)_/gs, "$1"); // 斜体 (_)
  text = text.replace(/^#{1,6}\s+/gm, ""); // 見出し
  text = text.replace(/^>\s?/gm, ""); // 引用
  text = text.replace(/^-\s+/gm, ""); // 箇条書き

  // 文末/単独の「w」連続 (草) を「笑」に変換。英単語中の ww は誤爆防止のため対象外。
  // 直後がドットの場合も除外する: URL 置換はスキーム必須なので www.example.com が
  // 残り、そのままだと「笑.example.com」= 「わらいドット…」と読まれてしまう。
  text = text.replace(
    /(?<![A-Za-zＡ-Ｚａ-ｚ])[wｗ]{2,}(?![A-Za-zＡ-Ｚａ-ｚ.])/g,
    "笑"
  );

  // 辞書による読み替え
  text = applyDictionary(text, guildId);

  // 連続空白を畳んで上限カット
  text = text.replace(/\s+/g, " ").trim();
  const maxLength = resolveMaxLength(guildId);
  if (Array.from(text).length > maxLength) {
    text = sliceByCodePoint(text, maxLength) + " 以下略";
  }

  return text;
}
