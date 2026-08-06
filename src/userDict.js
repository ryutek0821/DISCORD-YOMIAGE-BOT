// VOICEVOX ユーザー辞書の更新を、Engine と data/userDict.json の両方に対して
// 整合が取れる形で行うための層。Discord とのやり取り (commands/dict.js) からは
// 分離してある — ここが守るのは「Engine に有る語と JSON に有る語が一致すること」だけ。
//
// 守れないと何が起きるか: JSON にしか無い語は次の起動時の復元で Engine へ戻るが、
// Engine にしか無い語は **どのコマンドからも消せない孤児**になる (uuid を知る手段が
// 無くなるため)。全サーバー共通の単一 Engine なので、孤児は全ギルドの発音に効き続ける。
import {
  addUserDictWord,
  deleteUserDictWord,
  updateUserDictWord,
} from "./voicevox.js";
import { addUserDictEntry, getUserDict, removeUserDictEntry } from "./store.js";
import { logError } from "./log.js";

const PRIORITY = 5;

// 辞書の更新は Engine と JSON の2箇所を書くため、並行に走ると
// 片方だけ進んだ状態が残る (同じ語への add と remove が交差する等)。
// /dict word は運用者専用で頻度が低いので、単語単位のロックを持つより
// 操作全体を1本の Promise チェーンへ直列化する方が単純で確実。
let chain = Promise.resolve();

function serialize(fn) {
  const run = chain.then(fn);
  // 待つ側 (run) とは別に、握り潰した枝をチェーンへ繋ぐ。
  // run をそのまま繋ぐと、1件失敗しただけで以後の全操作が同じ理由で失敗する。
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

// JSON への commit に失敗したときに Engine を元へ戻す。
// ここまで失敗したら整合は諦めるしかないが、**uuid だけは必ずログに残す** —
// 手で消すのに要る唯一の情報で、これを失うと Engine の再作成以外に手が無くなる。
async function rollbackEngine(previous, uuid) {
  try {
    if (previous) {
      await updateUserDictWord(
        uuid,
        previous.word,
        previous.reading,
        previous.accent ?? 0,
        PRIORITY
      );
    } else {
      await deleteUserDictWord(uuid);
    }
  } catch (err) {
    logError(
      `ユーザー辞書のロールバックに失敗しました。Engine 側に uuid=${uuid} が` +
        `${previous ? "更新後の内容で" : ""}残っています (手動で確認してください)`,
      err
    );
  }
}

// 単語を登録または更新する。Engine 側の成功を確認してから JSON へ commit する。
// 戻り値の updated は既存語の書き換えだったかどうか。
export function addWord(word, reading, accent) {
  return serialize(async () => {
    const previous = getUserDict().find((e) => e.word === word) ?? null;
    let uuid = null;
    let updated = false;

    if (previous?.uuid) {
      try {
        await updateUserDictWord(previous.uuid, word, reading, accent, PRIORITY);
        uuid = previous.uuid;
        updated = true;
      } catch (err) {
        // Engine を作り直した直後などは JSON にある uuid が向こうに無い。
        // その場合だけ新規登録へ倒す (それ以外の失敗は握り潰さない)。
        if (err?.status !== 404) throw err;
      }
    }
    if (!uuid) uuid = await addUserDictWord(word, reading, accent, PRIORITY);

    try {
      addUserDictEntry(word, reading, accent, uuid);
    } catch (saveErr) {
      await rollbackEngine(updated ? previous : null, uuid);
      throw saveErr;
    }
    return { uuid, updated };
  });
}

// 単語を削除する。**Engine を先に消してから JSON を消す** —
// 逆順だと DELETE 失敗時に uuid を失い、Engine 側に孤児が残る。
export function removeWord(word) {
  return serialize(async () => {
    const entry = getUserDict().find((e) => e.word === word) ?? null;
    if (!entry) return { removed: false };
    if (entry.uuid) await deleteUserDictWord(entry.uuid); // 404 は成功扱い
    removeUserDictEntry(word);
    return { removed: true };
  });
}
