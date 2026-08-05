// コマンドの認可判定。Discord のオブジェクトを直接触らず、必要な値だけを受け取る
// 純粋関数にしてある (実接続なしで組み合わせを検証できるようにするため)。
import { PermissionFlagsBits } from "discord.js";

// VC 操作を「明示的に許可された人」と見なす権限。
// ManageGuild はサーバー管理者、MoveMembers は VC の交通整理を任された人。
export function isVoiceOperator(memberPermissions) {
  return Boolean(
    memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      memberPermissions?.has(PermissionFlagsBits.MoveMembers)
  );
}

const MOVE_DENIED =
  "Bot は別のボイスチャンネルで読み上げ中です。移動させるには「サーバー管理」または「メンバーを移動」権限が必要です。";
const LEAVE_DENIED =
  "Bot がいるボイスチャンネルに参加していません。切断するには「サーバー管理」または「メンバーを移動」権限が必要です。";
const SKIP_DENIED =
  "Bot がいるボイスチャンネルに参加していません。読み上げを止めるには「サーバー管理」または「メンバーを移動」権限が必要です。";

// /join の可否。Bot 未接続なら誰でも呼べる (従来どおり) が、既に別のVCで
// 読み上げ中なら移動は明示権限を持つ人に限る。無条件に移動を許すと、
// 別VCの一般ユーザーが稼働中の読み上げ (session と queue) を奪える。
export function authorizeJoin({ botChannelId, userChannelId, privileged }) {
  if (!userChannelId) {
    return { allowed: false, reason: "先にボイスチャンネルに参加してください。" };
  }
  if (!botChannelId || botChannelId === userChannelId || privileged) {
    return { allowed: true };
  }
  return { allowed: false, reason: MOVE_DENIED };
}

// /leave の可否。Bot と同じVCにいる人は普通に切断できる。
// VC外からの切断は明示権限に限る (VC未参加者でも読み上げを止められてしまうため)。
// Bot 未接続のときは通す — 呼び出し側が「参加していません」を返す通常経路。
export function authorizeLeave({ botChannelId, userChannelId, privileged }) {
  if (!botChannelId || botChannelId === userChannelId || privileged) {
    return { allowed: true };
  }
  return { allowed: false, reason: LEAVE_DENIED };
}

// /skip の可否。考え方は authorizeLeave と同じ: VC外の人が読み上げを止められると、
// 聞いている人の意図と無関係に妨害できてしまうため、Bot と同じVCにいる人か
// 明示権限を持つ人に限る。Bot 未接続のときは通す — 呼び出し側が
// 「読み上げていません」を返す通常経路。
export function authorizeSkip({ botChannelId, userChannelId, privileged }) {
  if (!botChannelId || botChannelId === userChannelId || privileged) {
    return { allowed: true };
  }
  return { allowed: false, reason: SKIP_DENIED };
}

// OPERATOR_IDS="123,456" を Set に。
export function parseOperatorIds(raw) {
  return new Set(
    (raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

// Application の所有者。Team 所有のアプリでは owner が Team になり、
// メンバー全員が所有者に相当する。
export function resolveOwnerIds(application) {
  const owner = application?.owner;
  if (!owner) return [];
  if (owner.members) return [...owner.members.keys()];
  return owner.id ? [owner.id] : [];
}

// VOICEVOX のユーザー辞書は guildId を持たない全サーバー共通の配列で、単一 Engine の
// 全読み上げに適用される。ギルドの ManageGuild で操作を許すと、Guild A の管理者が
// Guild B を含む全サーバーの発音を書き換えられ、他サーバー由来の登録内容も読める。
// 運用者 (OPERATOR_IDS) と Bot 所有者だけに限定する。
export function isOperator(userId, { operatorIds, ownerIds }) {
  if (!userId) return false;
  if (operatorIds?.size > 0) return operatorIds.has(userId);
  return (ownerIds || []).includes(userId);
}
