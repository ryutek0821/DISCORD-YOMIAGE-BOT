// コマンド名・サブコマンド名・オプション名の日本語表示用ヘルパー。
//
// Discord は API 名 (ASCII) をそのままコマンドピッカーに出すため、何もしないと
// 日本語話者向けの Bot なのに入力欄のラベルが `max_length` `read_author_name` の
// ような英語になる。setNameLocalizations で "ja" ロケールの表示名だけを差し替えれば、
// API 名は据え置きのまま日本語で見せられる (interaction.options.getInteger("max_length")
// のような取得側は一切変更が要らない)。
//
// トップレベルのコマンド名 (/voice /config …) は敢えてローカライズしない。
// サブコマンドとオプションはピッカーから選ぶものだが、コマンド名は利用者が
// 直接打ち込むため、日本語にすると IME の切り替えを強いることになる。
//
// 注意: ローカライズ名も Discord の名前規則に従う。空白・記号は使えず、
// ラテン文字は小文字のみ。日本語 (漢字・かな) はそのまま使える。
export function ja(name) {
  return { ja: name };
}
