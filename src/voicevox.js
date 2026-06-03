const BASE_URL = process.env.VOICEVOX_URL || "http://localhost:50021";

async function request(path, { method = "GET", body, headers } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { method, body, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`VOICEVOX ${method} ${path} -> ${res.status} ${text}`);
  }
  return res;
}

// 話者一覧を [{ name, styles: [{ name, id }] }] の形で返す
export async function getSpeakers() {
  const res = await request("/speakers");
  return res.json();
}

let speakerIdsCache = null;
// 有効な話者(スタイル)IDの一覧。初回取得後はメモリにキャッシュする。
export async function getSpeakerIds() {
  if (speakerIdsCache) return speakerIdsCache;
  const speakers = await getSpeakers();
  speakerIdsCache = speakers.flatMap((sp) => sp.styles.map((st) => st.id));
  return speakerIdsCache;
}

// テキストを WAV (Buffer) に合成する
export async function synth(text, speaker, speedScale = 1.0) {
  const queryRes = await request(
    `/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
    { method: "POST" }
  );
  const query = await queryRes.json();
  query.speedScale = speedScale;

  const synthRes = await request(`/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/wav" },
    body: JSON.stringify(query),
  });
  return Buffer.from(await synthRes.arrayBuffer());
}

export async function isAlive() {
  try {
    await request("/version");
    return true;
  } catch {
    return false;
  }
}
