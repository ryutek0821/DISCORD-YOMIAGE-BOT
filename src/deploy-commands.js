import "dotenv/config";
import { REST } from "discord.js";
import { commands } from "./commands/index.js";
import { parseArgs, parseGuildIds, discoverRegistrations, buildPlan, applyPlan } from "./deploy.js";

const { DISCORD_TOKEN, CLIENT_ID, GUILD_IDS } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("DISCORD_TOKEN と CLIENT_ID を .env に設定してください。");
  process.exit(1);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const body = commands.map((c) => c.data.toJSON());
const rest = new REST().setToken(DISCORD_TOKEN);
const guildIds = parseGuildIds(GUILD_IDS);

try {
  // --cleanup 未指定なら余計な GET を投げない (通常の deploy は登録だけで完結させる)。
  const registrations = args.cleanup ? await discoverRegistrations(rest, CLIENT_ID) : null;
  const plan = buildPlan({ guildIds, registrations });
  await applyPlan(rest, { clientId: CLIENT_ID, body, plan, dryRun: args.dryRun });

  const registerLabel =
    guildIds.length > 0 ? `guild ${guildIds.length}件` : "global";
  console.log(`--- サマリ: 登録 ${body.length} 件 (${registerLabel}) ---`);
  if (plan.cleanup.length === 0) {
    if (args.cleanup) console.log("掃除対象はありませんでした。");
  } else {
    const verb = args.dryRun ? "掃除予定" : "掃除済み";
    for (const item of plan.cleanup) {
      const label =
        item.scope === "global" ? "global" : `guild ${item.guildId}${item.name ? ` (${item.name})` : ""}`;
      console.log(`${verb}: ${item.count} 件 (${label})`);
    }
  }
} catch (err) {
  console.error("コマンド登録に失敗:", err);
  process.exit(1);
}
