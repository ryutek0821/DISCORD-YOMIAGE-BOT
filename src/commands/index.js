import { InteractionContextType, MessageFlags } from "discord.js";
import * as join from "./join.js";
import * as leave from "./leave.js";
import * as voice from "./voice.js";
import * as speakers from "./speakers.js";
import * as fishvoice from "./fishvoice.js";
import * as dict from "./dict.js";
import * as config from "./config.js";
import * as ignore from "./ignore.js";

export const commands = [
  join,
  leave,
  voice,
  speakers,
  fishvoice,
  dict,
  config,
  ignore,
];

// 全コマンドを Guild 限定にする。global 登録すると Bot の DM にもコマンドが出てしまい、
// 例えば DM の /leave は guildId=null のまま leave() と設定更新を実行して
// guildSettings.json に "null" キーを作れる。全サーバー共通の /dict word を
// DM から参照できてしまう点も認可境界を広げる。
// 個別のコマンドファイルではなくここで一括して掛けることで、新しいコマンドを
// 追加したときに付け忘れても Guild 限定になる。
for (const command of commands) {
  command.data.setContexts(InteractionContextType.Guild);
}

// 登録側の contexts だけに頼らず、実行時にも Guild 外を弾く (defense-in-depth)。
// 過去に global 登録したコマンドは再登録するまで DM に残るため、
// デプロイ直後は実行時ガードだけが効いている状態になりうる。
function guildOnly(execute) {
  return async (interaction) => {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使えます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    return execute(interaction);
  };
}

export const commandMap = new Map(
  commands.map((c) => [c.data.name, { data: c.data, execute: guildOnly(c.execute) }])
);
