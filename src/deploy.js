// スラッシュコマンド登録の純粋ロジック。deploy-commands.js から呼ばれる。
// このモジュールは import しただけでは何も起きない (env読み取り・REST生成・
// process.exit を含めない) — テストで rest をフェイクに差し替えて呼び出すため。
import { Routes } from "discord.js";

// "id1, id2,,id1" のようなカンマ区切り文字列を trim・空要素除去・重複除去した配列にする。
// undefined/空文字は [] (= global 登録扱い)。
export function parseGuildIds(raw) {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

const USAGE = "使い方: npm run deploy -- [--cleanup] [--dry-run]";

// process.argv.slice(2) 相当の配列から { cleanup, dryRun } を作る。
// 未知のフラグはタイプミスに気付けるよう黙って無視せず即座に落とす。
export function parseArgs(argv) {
  const result = { cleanup: false, dryRun: false };
  for (const arg of argv) {
    if (arg === "--cleanup") {
      result.cleanup = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else {
      throw new Error(`不明なオプション: ${arg}\n${USAGE}`);
    }
  }
  return result;
}

// 現在 Discord 側に登録が残っている場所を調べる (--cleanup の下見用)。
// Bot が参加中の全ギルドを回って件数を数えるので、通常の deploy では呼ばない。
export async function discoverRegistrations(rest, clientId) {
  const globalCommands = await rest.get(Routes.applicationCommands(clientId));
  const memberGuilds = await rest.get(Routes.userGuilds());

  const guilds = [];
  for (const g of memberGuilds) {
    let commands;
    try {
      commands = await rest.get(Routes.applicationGuildCommands(clientId, g.id));
    } catch {
      // 権限不足やアクセス不能でGETが失敗しても、そのギルドをスキップして続行する。
      // 掃除の下見1件のエラーで全体を落とすと、他ギルドの結果まで見えなくなるため。
      continue;
    }
    if (commands.length > 0) {
      guilds.push({ id: g.id, name: g.name, count: commands.length });
    }
  }

  return { global: globalCommands.length, guilds };
}

// 今回登録する対象 (register) と、それ以外に残っていて掃除すべき対象 (cleanup) を決める。
// registrations が null/undefined なら (discoverRegistrations を呼んでいない = --cleanup 未指定)
// cleanup は必ず空配列にする。通常の deploy では絶対に削除しない、という設計を守るための分岐。
export function buildPlan({ guildIds, registrations }) {
  const register =
    guildIds.length > 0
      ? guildIds.map((id) => ({ scope: "guild", guildId: id }))
      : [{ scope: "global" }];

  const cleanup = [];
  if (registrations) {
    if (guildIds.length > 0) {
      // guild モード: global に残っていれば消す。GUILD_IDS から外れたギルドも消す。
      if (registrations.global > 0) {
        cleanup.push({ scope: "global", count: registrations.global });
      }
      const guildIdSet = new Set(guildIds);
      for (const g of registrations.guilds) {
        if (!guildIdSet.has(g.id)) {
          cleanup.push({ scope: "guild", guildId: g.id, name: g.name, count: g.count });
        }
      }
    } else {
      // global モード: global 自身は register 側で上書きされるので cleanup に含めない。
      // 登録済みギルドは全部他 scope なので丸ごと消す対象になる。
      for (const g of registrations.guilds) {
        cleanup.push({ scope: "guild", guildId: g.id, name: g.name, count: g.count });
      }
    }
  }

  return { register, cleanup };
}

function routeFor(scope, clientId, guildId) {
  return scope === "global"
    ? Routes.applicationCommands(clientId)
    : Routes.applicationGuildCommands(clientId, guildId);
}

// plan を実行する。register → cleanup の順で必ず実行する
// (先に消すとコマンドが Discord 上から一瞬消える時間が伸びるため)。
export async function applyPlan(rest, { clientId, body, plan, dryRun = false, log = console.log }) {
  for (const item of plan.register) {
    const label = item.scope === "global" ? "global" : `guild ${item.guildId}`;
    if (dryRun) {
      log(`[dry-run] ${body.length} 件のコマンドを登録します (${label})。`);
      continue;
    }
    await rest.put(routeFor(item.scope, clientId, item.guildId), { body });
    log(`${body.length} 件のコマンドを登録しました (${label})。`);
  }

  for (const item of plan.cleanup) {
    const label =
      item.scope === "global" ? "global" : `guild ${item.guildId}${item.name ? ` (${item.name})` : ""}`;
    if (dryRun) {
      log(`[dry-run] ${item.count} 件のコマンドを削除します (${label})。`);
      continue;
    }
    // 空配列PUTで一括削除する。1件ずつ DELETE すると件数分APIを叩くことになり、
    // 途中で失敗すると中途半端に消えた状態が残るため。
    await rest.put(routeFor(item.scope, clientId, item.guildId), { body: [] });
    log(`${item.count} 件のコマンドを削除しました (${label})。`);
  }
}
