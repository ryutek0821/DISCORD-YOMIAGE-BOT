import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { getSpeakerIds } from "../voicevox.js";
import {
  isConfigured as isFishConfigured,
  isReferenceId,
  intonationToTemperature,
  supportsEmotion,
  getModel as getFishModel,
} from "../fishAudio.js";
import {
  getUserSettings,
  updateUserSettings,
  clearUserSettings,
  getFishVoices,
} from "../store.js";
import { resolveUserVoice } from "../userVoice.js";

// Fish の感情タグ (S2系モデルのみ有効)。自由入力にすると、タグとして解釈されない
// 文字列がそのまま読み上げられ、しかも課金バイトに乗るので choices で固定する。
const EMOTION_OFF = "off";
const EMOTION_CHOICES = [
  { name: "happy (明るい)", value: "happy" },
  { name: "sad (悲しい)", value: "sad" },
  { name: "excited (興奮)", value: "excited" },
  { name: "angry (怒り)", value: "angry" },
  { name: "surprised (驚き)", value: "surprised" },
  { name: "whisper (ささやき)", value: "whisper" },
  { name: "laugh (笑い)", value: "laugh" },
  { name: "sigh (ため息)", value: "sigh" },
  { name: "gasp (息をのむ)", value: "gasp" },
  { name: "emphasis (強調)", value: "emphasis" },
  { name: "(解除)", value: EMOTION_OFF },
];

export const data = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("自分の読み上げ話者・速度・声の高さ・抑揚を設定します")
  .addIntegerOption((o) =>
    o
      .setName("speaker")
      .setDescription("話者(スタイル)ID。/speakers で一覧を確認")
      .setMinValue(0)
  )
  .addStringOption((o) =>
    o
      .setName("fish")
      .setDescription(
        "Fish Audio のボイス。/fishvoice list のエイリアス、または reference_id"
      )
      .setMaxLength(50)
  )
  .addNumberOption((o) =>
    o
      .setName("speed")
      .setDescription("読み上げ速度 (0.5〜2.0)")
      .setMinValue(0.5)
      .setMaxValue(2.0)
  )
  .addNumberOption((o) =>
    o
      .setName("pitch")
      .setDescription("声の高さ (-0.15〜0.15、標準0)")
      .setMinValue(-0.15)
      .setMaxValue(0.15)
  )
  .addNumberOption((o) =>
    o
      .setName("intonation")
      .setDescription("抑揚の強さ (0.0〜2.0、標準1.0)。Fishでは声の揺らぎに換算されます")
      .setMinValue(0.0)
      .setMaxValue(2.0)
  )
  .addStringOption((o) =>
    o
      .setName("fish_emotion")
      .setDescription("Fish Audio の感情・話し方 (Fishボイスのときだけ効きます)")
      .addChoices(...EMOTION_CHOICES)
  )
  .addBooleanOption((o) =>
    o
      .setName("reset")
      .setDescription("自分の設定を消して自動(ランダム割り当て)に戻す")
  );

// 入力から Fish の reference_id を引く。見つからなければ null。
// 登録済みボイスは全ユーザー共通なので、誰が登録したものでも誰でも指定できる。
// /fishvoice list の表示 (「エイリアス: 表示名」) をどちらの側で打っても通るようにし、
// 大文字小文字も無視する (add 時に alias を小文字化しているため、完全一致だと
// `Jyounetsu` のような入力が弾かれてしまう)。
function resolveFishInput(input) {
  const raw = input.trim();
  const lower = raw.toLowerCase();
  const voices = getFishVoices();

  for (const [alias, v] of Object.entries(voices)) {
    if (alias.toLowerCase() === lower) return v.referenceId;
  }
  for (const v of Object.values(voices)) {
    if (v.name.toLowerCase() === lower) return v.referenceId;
  }
  return isReferenceId(lower) ? lower : null;
}

// reference_id から登録名を引く (未登録の生IDならID自体を見せる)
function describeFishRef(referenceId) {
  const entry = Object.entries(getFishVoices()).find(
    ([, v]) => v.referenceId === referenceId
  );
  return entry ? `${entry[1].name} (${entry[0]})` : referenceId;
}

// 実効ボイスを人間が読める1行にする。Fish には pitch の対応物が無いので出さない。
// intonation は temperature に換算されて効くので、換算後の値も併記して
// 「指定が効いている」ことが分かるようにする。
function describeVoice(eff, note = "") {
  if (eff.engine === "fish" && eff.fishRef) {
    const emotion = supportsEmotion()
      ? (eff.fishEmotion ?? "なし")
      : `非対応(model=${getFishModel()})`;
    return (
      `エンジン=Fish Audio, ボイス=${describeFishRef(eff.fishRef)}, 速度=${eff.speed}` +
      `, 抑揚=${eff.intonation}(temperature ${intonationToTemperature(eff.intonation)})` +
      `, 感情=${emotion}`
    );
  }
  return `エンジン=VOICEVOX, 話者ID=${eff.speaker}${note}, 速度=${eff.speed}, 声の高さ=${eff.pitch}, 抑揚=${eff.intonation}`;
}

export async function execute(interaction) {
  const speaker = interaction.options.getInteger("speaker");
  const fish = interaction.options.getString("fish");
  const speed = interaction.options.getNumber("speed");
  const pitch = interaction.options.getNumber("pitch");
  const intonation = interaction.options.getNumber("intonation");
  const fishEmotion = interaction.options.getString("fish_emotion");
  const reset = interaction.options.getBoolean("reset");
  const userId = interaction.user.id;

  // どの分岐も VOICEVOX への問い合わせ (話者一覧) を挟みうる。Engine の応答が遅いと
  // 3秒の一次応答期限を超えて interaction が失効するため、先に defer しておく。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 設定をリセットして自動(ランダム割り当て)に戻す
  if (reset) {
    clearUserSettings(userId);
    const eff = await resolveUserVoice(userId, interaction.guildId);
    await interaction.editReply(
      `自動(ランダム割り当て)に戻し、読み上げミュートも解除しました。現在の声: ${describeVoice(eff)}`
    );
    return;
  }

  // 引数なし: 自分の実効設定を表示
  if (
    speaker === null &&
    fish === null &&
    speed === null &&
    pitch === null &&
    intonation === null &&
    fishEmotion === null
  ) {
    const s = getUserSettings(userId);
    const eff = await resolveUserVoice(userId, interaction.guildId);
    const note = s?.speaker == null ? "（自動割り当て）" : "";
    await interaction.editReply(`あなたの現在の声: ${describeVoice(eff, note)}`);
    return;
  }

  // speaker と fish は別エンジンの指定なので同時には受けない
  if (speaker !== null && fish !== null) {
    await interaction.editReply(
      "speaker (VOICEVOX) と fish (Fish Audio) は同時に指定できません。どちらか一方にしてください。"
    );
    return;
  }

  const patch = {};
  if (speaker !== null) {
    // 指定IDが存在するか検証
    try {
      const ids = await getSpeakerIds();
      if (!ids.includes(speaker)) {
        await interaction.editReply(
          `話者ID ${speaker} は存在しません。/speakers で確認してください。`
        );
        return;
      }
    } catch {
      // Engine 未起動などは検証スキップ
    }
    patch.speaker = speaker;
    patch.engine = "voicevox";
    patch.fishRef = null;
  }

  if (fish !== null) {
    if (!isFishConfigured()) {
      await interaction.editReply(
        "Fish Audio は未設定です (FISH_API_KEY)。サーバー管理者に設定を依頼してください。"
      );
      return;
    }
    const referenceId = resolveFishInput(fish);
    if (!referenceId) {
      const known = Object.keys(getFishVoices()).join(", ");
      await interaction.editReply(
        `「${fish}」は登録済みボイスにも reference_id (32桁の16進数) にも該当しません。\n登録済み: ${known}`
      );
      return;
    }
    patch.engine = "fish";
    patch.fishRef = referenceId;
  }

  if (speed !== null) patch.speed = speed;
  if (pitch !== null) patch.pitch = pitch;
  if (intonation !== null) patch.intonation = intonation;
  // speaker 指定時に fishRef を消すのと違い、engine を切り替えても感情は残す
  // (fish に戻したときに設定し直さなくて済むほうが自然)
  if (fishEmotion !== null) {
    patch.fishEmotion = fishEmotion === EMOTION_OFF ? null : fishEmotion;
  }

  updateUserSettings(userId, patch);
  const eff = await resolveUserVoice(userId, interaction.guildId);
  // Fish を使っていない人が感情だけ指定すると、下の1行に感情が出ず無反応に見えるので補足する
  const hint =
    fishEmotion !== null && eff.engine !== "fish"
      ? "\n(感情は保存しましたが、`/voice fish:` で Fish Audio のボイスを選ぶまで効きません)"
      : "";
  await interaction.editReply(`あなたの声を更新しました: ${describeVoice(eff)}${hint}`);
}
