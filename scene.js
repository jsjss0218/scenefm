// /api/resolve-tracks — Spotify track URI resolver with server-side cache
// Optional Vercel env vars:
// - SPOTIFY_CLIENT_ID
// - SPOTIFY_CLIENT_SECRET
// If the client sends Authorization: Bearer <Spotify user token>, env vars are not required.

const cache = new Map();
let appToken = { access: "", expiresAt: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (s) => String(s || "").trim().toLowerCase();
const cacheKey = (track) => `${norm(track.t)}::${norm(track.a)}`;

async function getAppToken() {
  if (appToken.access && Date.now() < appToken.expiresAt - 60000) return appToken.access;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID 또는 SPOTIFY_CLIENT_SECRET이 설정되지 않았어요.");
  }

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  if (!res.ok) throw new Error("Spotify 앱 토큰 발급에 실패했어요.");
  const json = await res.json();
  appToken = {
    access: json.access_token,
    expiresAt: Date.now() + Math.max(0, (json.expires_in || 3600) * 1000),
  };
  return appToken.access;
}

async function spotifyGet(path, userToken = "", attempt = 0) {
  const token = userToken || await getAppToken();
  const res = await fetch("https://api.spotify.com/v1" + path, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429 && attempt < 2) {
    const retryAfter = Number(res.headers.get("Retry-After") || 2);
    await sleep(Math.min(15000, Math.max(1000, retryAfter * 1000)));
    return spotifyGet(path, userToken, attempt + 1);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || JSON.stringify(body?.error || body);
    } catch {}
    throw new Error(`Spotify ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

async function resolveTrack(track, userToken = "") {
  const key = cacheKey(track);
  if (cache.has(key)) return cache.get(key);

  const query = [track.t, track.a].filter(Boolean).join(" ");
  if (!query) {
    cache.set(key, null);
    return null;
  }

  const params = new URLSearchParams({ type: "track", limit: "1", q: query });
  const data = await spotifyGet("/search?" + params.toString(), userToken);
  const item = data.tracks?.items?.[0];
  const uri = typeof item?.uri === "string" && item.uri.startsWith("spotify:track:") ? item.uri : null;
  cache.set(key, uri);
  return uri;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
    const limit = Math.max(1, Math.min(Number(req.body?.limit || 8), 20));
    const auth = req.headers.authorization || "";
    const userToken = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const uris = [];
    const results = [];

    for (const track of tracks.slice(0, 20)) {
      const uri = await resolveTrack(track, userToken);
      results.push({ t: track.t, a: track.a, uri });
      if (uri && !uris.includes(uri)) uris.push(uri);
      if (uris.length >= limit) break;
    }

    res.status(200).json({ results, uris, matched: uris.length, total: tracks.length });
  } catch (e) {
    res.status(502).json({ error: e.message || "Spotify 곡 매칭에 실패했어요." });
  }
}
