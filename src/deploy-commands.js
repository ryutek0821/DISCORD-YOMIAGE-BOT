import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";

const { DISCORD_TOKEN, CLIENT_ID, GUILD_IDS } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("DISCORD_TOKEN と CLIENT_ID を .env に設定してください。");
  process.exit(1);
}

const body = commands.map((c) => c.data.toJSON());
const rest = new REST().setToken(DISCORD_TOKEN);

const guildIds = (GUILD_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

try {
  if (guildIds.length === 0) {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log(`${body.length} 件のコマンドを登録しました (global)。`);
  } else {
    for (const gid of guildIds) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body });
      console.log(`${body.length} 件のコマンドを登録しました (guild ${gid})。`);
    }
  }
} catch (err) {
  console.error("コマンド登録に失敗:", err);
  process.exit(1);
}
