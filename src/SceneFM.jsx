import React, { useEffect, useRef, useState, useCallback } from "react";

// ─────────────────────────────────────────────────────────────
// Scene FM — 실시간 장면 기반 AI 플레이리스트 자동 생성 MVP
// 핵심 루프: 촬영 → AI 장면 분석 → 음악 태그 → 흐름형 플레이리스트 → 바로 듣기
// 2단계: Spotify 계정 연동 → 실제 플레이리스트 자동 생성  ← 추가됨
// ─────────────────────────────────────────────────────────────

// ▼▼▼ Spotify 연동 설정 (SETUP.md 참고) ▼▼▼
const SPOTIFY_CLIENT_ID = "e51bc8c11879482a80216d21f42565cd"; // developer.spotify.com 에서 발급
const SPOTIFY_REDIRECT_URI =
  typeof window !== "undefined" ? window.location.origin + window.location.pathname : "";
const SPOTIFY_SCOPES = "playlist-modify-private playlist-modify-public streaming user-read-email user-read-private";
// ▲▲▲ 이 앱이 등록된 Redirect URI 와 SPOTIFY_REDIRECT_URI 가 정확히 일치해야 합니다 ▲▲▲

const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Gothic+A1:wght@400;500;700;800;900&family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
.sfm-display{font-family:'Gothic A1',system-ui,sans-serif;font-weight:900;letter-spacing:-.02em;line-height:1.0}
.sfm-body{font-family:'Gothic A1',system-ui,sans-serif}
.sfm-mono{font-family:'Space Mono',ui-monospace,monospace}
.sfm-lat{font-family:'Space Grotesk',system-ui,sans-serif}
@keyframes sfm-sweep{0%{transform:translateY(-110%)}100%{transform:translateY(210%)}}
@keyframes sfm-spin{to{transform:rotate(360deg)}}
@keyframes sfm-pulse{0%,100%{opacity:.35}50%{opacity:1}}
@keyframes sfm-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes sfm-draw{to{stroke-dashoffset:0}}
.sfm-rise{animation:sfm-rise .5s ease both}
@media (prefers-reduced-motion: reduce){
  .sfm-sweep,.sfm-spin,.sfm-pulse,.sfm-rise,.sfm-curve{animation:none!important}
}
`;

const SECTIONS = {
  1: { ko: "진입", desc: "장면에 바로 몰입" },
  2: { ko: "메인 무드", desc: "중심 분위기 유지" },
  3: { ko: "에너지 변화", desc: "흐름이 살짝 상승" },
  4: { ko: "감정 유지", desc: "여운과 공간감" },
  5: { ko: "마무리", desc: "감정을 정리" },
};

const MOODS = [
  { key: "더 레트로하게", label: "더 레트로" },
  { key: "더 신나게", label: "더 신나게" },
  { key: "더 감성적으로", label: "더 감성적" },
  { key: "보컬 없는 음악으로", label: "보컬 없이" },
  { key: "한국 음악 중심으로", label: "K-중심" },
  { key: "해외 음악 중심으로", label: "해외 중심" },
];

const enc = (s) => encodeURIComponent(s);
const ytmusic = (t, a) => `https://music.youtube.com/search?q=${enc(`${t} ${a}`)}`;
const spotifySearch = (t, a) => `https://open.spotify.com/search/${enc(`${t} ${a}`)}`;

// ── image helpers ──
function fileToScaledJpeg(file, maxDim = 1024, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale); height = Math.round(height * scale);
      const c = document.createElement("canvas");
      c.width = width; c.height = height;
      c.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("이미지를 불러오지 못했어요.")); };
    img.src = url;
  });
}
function videoFrameToJpeg(video, maxDim = 1024, quality = 0.82) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.min(1, maxDim / Math.max(vw, vh));
  const c = document.createElement("canvas");
  c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}
// 라이브 카메라에서 n장의 프레임을 일정 간격으로 캡처 (영상 모드)
function captureLiveFrames(video, n = 3, gap = 600) {
  return new Promise((resolve) => {
    const out = [];
    const grab = () => {
      try { out.push(videoFrameToJpeg(video)); } catch {}
      if (out.length >= n) resolve(out);
      else setTimeout(grab, gap);
    };
    grab();
  });
}
// 업로드한 영상 파일에서 3개 시점의 프레임을 추출 (영상 모드)
function sampleVideoFile(file, maxDim = 1024, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true; v.playsInline = true; v.src = url;
    v.onloadedmetadata = async () => {
      const dur = v.duration || 1;
      const times = [dur * 0.2, dur * 0.5, dur * 0.8];
      const frames = [];
      const seek = (t) => new Promise((res) => { v.onseeked = res; v.currentTime = Math.min(t, dur - 0.05); });
      try {
        for (const t of times) {
          await seek(t);
          const scale = Math.min(1, maxDim / Math.max(v.videoWidth, v.videoHeight));
          const c = document.createElement("canvas");
          c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          frames.push(c.toDataURL("image/jpeg", quality));
        }
        URL.revokeObjectURL(url);
        resolve(frames.length ? frames : reject(new Error("영상에서 프레임을 추출하지 못했어요.")));
      } catch (e) { URL.revokeObjectURL(url); reject(new Error("영상을 처리하지 못했어요.")); }
    };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("영상을 불러오지 못했어요.")); };
  });
}
function extractJson(text) {
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b !== -1) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

// ── Anthropic vision call (claude.ai 아티팩트 프록시 사용; 배포 시 백엔드 프록시 필요 — SETUP.md) ──
async function callSceneFM(frames, modifier) {
  const list = Array.isArray(frames) ? frames : [frames];
  const imageBlocks = list.map((d) => ({
    type: "image", source: { type: "base64", media_type: "image/jpeg", data: d.split(",")[1] },
  }));
  const isVideo = list.length > 1;
  const system =
    "You are the recommendation engine for Scene FM, an app that turns the scene in front of the user into a ready-to-play playlist. " +
    (isVideo
      ? "The images are sequential frames from a short video clip — read motion, speed and how the scene changes over time, not just a still. "
      : "") +
    "Read the photo for place, time of day, color, movement, weather, emotion and era, then translate them into genre, era, BPM, sound texture and a playlist with an energy arc. " +
    "Recommend REAL, well-known existing songs that genuinely fit the scene. " +
    "Reply with ONLY minified JSON — no code fences, no commentary. " +
    "Scene and music label values must be in Korean; track titles and artists stay in their original language. " +
    'Schema: {"station":string (an evocative FM station name e.g. "Sunset Road FM"),' +
    '"tagline":string (<=6 Korean words),"freq":string (e.g. "88.3"),' +
    '"palette":{"accent":hex,"accent2":hex} (two colors pulled from the light/color of the scene),' +
    '"scene":{"place":,"time":,"color":,"motion":,"weather":,"emotion":,"era":} (short Korean),' +
    '"music":{"genres":[2-4 strings],"era":string,"bpm":string,"energy":string Korean,"vocal":string Korean},' +
    '"tracks":[16-18 objects {"t":title,"a":artist,"y":year,"s":section}]}. ' +
    "Sections: 1=entry(2-3 songs),2=main mood(5-6),3=energy lift(3-4),4=emotion hold(3-4),5=close(2). Order tracks by section ascending.";
  const userText = "이 장면을 Scene FM 방송국으로 만들어줘." + (modifier ? ` 무드 조정 요청: ${modifier}.` : "");
  // 배포 환경: /api/scene 서버리스 프록시를 통해 호출 (API 키는 서버에만 보관)
  const res = await fetch("/api/scene", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 1000, system,
      messages: [{ role: "user", content: [
        ...imageBlocks,
        { type: "text", text: userText },
      ] }],
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const errBody = await res.json();
      detail = errBody?.error?.message || errBody?.error || JSON.stringify(errBody);
    } catch {}
    throw new Error(`분석 서버에 연결하지 못했어요.${detail ? ` (${detail})` : ""}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return extractJson(text);
}

// ═══════════════════ Spotify (Authorization Code + PKCE) ═══════════════════
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const a = new Uint8Array(len); crypto.getRandomValues(a);
  return Array.from(a, (x) => chars[x % chars.length]).join("");
}
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(digest);
}
function openSpotifyPopup(url, state) {
  return new Promise((resolve, reject) => {
    const w = window.open(url, "scenefm_spotify", "width=500,height=720");
    if (!w) { reject(new Error("팝업이 차단됐어요. 팝업을 허용한 뒤 다시 시도해 주세요.")); return; }
    const onMsg = (e) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data || {};
      if (d.source !== "scenefm-spotify-auth") return;
      cleanup();
      if (d.error) reject(new Error("Spotify 인증이 취소됐어요."));
      else if (d.state !== state) reject(new Error("인증 상태가 일치하지 않아요."));
      else resolve(d.code);
    };
    const timer = setInterval(() => { if (w.closed) { cleanup(); reject(new Error("인증 창이 닫혔어요.")); } }, 700);
    function cleanup() { clearInterval(timer); window.removeEventListener("message", onMsg); try { w.close(); } catch {} }
    window.addEventListener("message", onMsg);
  });
}
async function spotifyAuthorize() {
  if (!SPOTIFY_CLIENT_ID || SPOTIFY_CLIENT_ID === "YOUR_SPOTIFY_CLIENT_ID")
    throw new Error("Spotify Client ID가 설정되지 않았어요. SETUP.md를 확인하세요.");
  const verifier = randomString(64);
  const challenge = await pkceChallenge(verifier);
  const state = randomString(16);
  const url = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID, response_type: "code", redirect_uri: SPOTIFY_REDIRECT_URI,
    code_challenge_method: "S256", code_challenge: challenge, state, scope: SPOTIFY_SCOPES,
  });
  const code = await openSpotifyPopup(url, state);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: SPOTIFY_CLIENT_ID, code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error("Spotify 토큰 발급에 실패했어요.");
  const json = await res.json();
  return { access: json.access_token, scope: json.scope || "" };
}
// 실패 응답의 본문까지 읽어 실제 원인(403/401/400…)을 메시지에 담는다
async function spErr(res, path) {
  let detail = "";
  try { const j = await res.json(); detail = j?.error?.message || (j?.error ? JSON.stringify(j.error) : ""); }
  catch { try { detail = await res.text(); } catch {} }
  const hint =
    res.status === 403 ? " — 개발 모드 앱이면 Dashboard → User Management에 이 Spotify 계정이 추가됐는지 확인하세요. (재생은 Premium 필요)"
    : res.status === 401 ? " — 토큰이 만료됐어요. 다시 로그인해 주세요."
    : res.status === 404 ? " — 활성 디바이스를 찾지 못했어요."
    : "";
  return `Spotify ${res.status}${detail ? `: ${detail}` : ` (${path})`}${hint}`;
}
async function spGet(token, path) {
  const res = await fetch("https://api.spotify.com/v1" + path, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) throw new Error(await spErr(res, path));
  return res.json();
}
async function spPost(token, path, body) {
  const res = await fetch("https://api.spotify.com/v1" + path, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await spErr(res, path));
  return res.json();
}
async function spPut(token, path, body) {
  const res = await fetch("https://api.spotify.com/v1" + path, {
    method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error(await spErr(res, path));
  return res.status === 204 ? null : res.json().catch(() => null);
}
// 지정한 디바이스에서 '이 큐(uris)만' 재생. 디바이스가 아직 미등록(404)이면 잠깐 뒤 재시도.
async function startPlayback(token, deviceId, uris, attempt = 0) {
  try {
    await spPut(token, `/me/player/play?device_id=${deviceId}`, { uris });
  } catch (e) {
    if (attempt < 2 && /\b404\b/.test(e.message)) {
      await new Promise((r) => setTimeout(r, 600));
      return startPlayback(token, deviceId, uris, attempt + 1);
    }
    throw e;
  }
}
// Web Playback SDK 스크립트를 1회만 로드
let sdkPromise = null;
function loadSpotifySdk() {
  if (window.Spotify) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.onerror = () => reject(new Error("Spotify 플레이어를 불러오지 못했어요."));
    document.body.appendChild(s);
  });
  return sdkPromise;
}
async function searchTrackUri(token, t, a) {
  const tryQ = async (q) => {
    try {
      const d = await spGet(token, "/search?type=track&limit=5&q=" + enc(q));
      const item = d.tracks && d.tracks.items && d.tracks.items[0];
      return item && typeof item.uri === "string" && item.uri.startsWith("spotify:track:") ? item.uri : null;
    } catch { return null; }
  };
  return (await tryQ(`track:${t} artist:${a}`)) || (await tryQ(`${t} ${a}`));
}

// ═══════════════════════════════════════════════════════════════════════════

export default function SceneFM() {
  // --- OAuth 팝업 콜백 감지 (이 인스턴스가 인증 팝업이면 부모창으로 code 전달 후 닫힘) ---
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const isAuthCallback = typeof window !== "undefined" && !!window.opener && (params.has("code") || params.has("error"));

  const [stage, setStage] = useState("home");
  const [mode, setMode] = useState("photo"); // photo | video
  const [recording, setRecording] = useState(false);
  const [shot, setShot] = useState(null);
  const [pendingFrames, setPendingFrames] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [liveCam, setLiveCam] = useState(false);
  const [busyMood, setBusyMood] = useState("");
  const [spotify, setSpotify] = useState({ status: "idle", progress: "", url: "", matched: 0, total: 0, error: "" });
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);
  const videoFileRef = useRef(null);
  const tokenRef = useRef({ access: null, userId: null });

  const accent = result?.palette?.accent || "#E0662A";
  const accent2 = result?.palette?.accent2 || "#A6364B";

  useEffect(() => {
    if (isAuthCallback) {
      window.opener.postMessage({
        source: "scenefm-spotify-auth",
        code: params.get("code"), state: params.get("state"), error: params.get("error"),
      }, window.location.origin);
      window.close();
    }
  }, [isAuthCallback]);

  useEffect(() => {
    if (isAuthCallback || stage !== "capture") return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
        setLiveCam(true);
      } catch { setLiveCam(false); }
    })();
    return () => { cancelled = true; if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; } };
  }, [stage, isAuthCallback]);

  const analyze = useCallback(async (frames, modifier) => {
    const list = Array.isArray(frames) ? frames : [frames];
    setShot(list[0]);
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    setLiveCam(false); setRecording(false);
    setSpotify({ status: "idle", progress: "", url: "", matched: 0, total: 0, error: "" });
    if (!modifier) setStage("analyzing");
    setError("");
    try {
      const r = await callSceneFM(modifier ? list : list, modifier);
      setResult(r); setStage("station");
    } catch (e) {
      setError(e.message || "장면을 읽지 못했어요.");
      if (!modifier) setStage("error");
    } finally { setBusyMood(""); }
  }, []);

  const [player, setPlayer] = useState({
    status: "idle", // idle | connecting | resolving | ready | error
    deviceId: "", uris: [], index: 0, isPlaying: false,
    track: null, progressMs: 0, durationMs: 0, error: "", premiumRequired: false,
  });
  const playerRef = useRef(null);

  const ensureSpotify = useCallback(async () => {
    if (!tokenRef.current.access) {
      const { access, scope } = await spotifyAuthorize();
      // 오래된 동의가 남아 쓰기 권한이 빠진 토큰이 발급되는 경우를 즉시 감지
      if (!/playlist-modify-(private|public)/.test(scope)) {
        throw new Error(
          "이 로그인에는 플레이리스트 생성 권한이 없습니다. spotify.com/account/apps 에서 'Scene FM' 접근을 제거(REVOKE)한 뒤 다시 로그인하세요. (부여된 권한: " + (scope || "없음") + ")"
        );
      }
      tokenRef.current.access = access;
      tokenRef.current.scope = scope;
      tokenRef.current.userId = (await spGet(access, "/me")).id;
    }
    return tokenRef.current;
  }, []);

  const resolveQueueUris = useCallback(async (access, tracks, onProgress) => {
    const seen = new Set(); const uris = []; let done = 0;
    for (const t of tracks) {
      const uri = await searchTrackUri(access, t.t, t.a);
      if (uri && !seen.has(uri)) { seen.add(uri); uris.push(uri); }
      done++;
      onProgress && onProgress(done, uris.length);
    }
    return uris;
  }, []);

  const saveToSpotify = useCallback(async () => {
    const tracks = (result && result.tracks) || [];
    if (!tracks.length) return;
    try {
      setSpotify({ status: "connecting", progress: "Spotify 연결 중…", url: "", matched: 0, total: tracks.length, error: "" });
      const { access, userId } = await ensureSpotify();
      setSpotify((s) => ({ ...s, status: "working", progress: "곡을 찾는 중…" }));
      const uris = await resolveQueueUris(access, tracks, (done, matched) =>
        setSpotify((s) => ({ ...s, progress: `곡을 찾는 중 ${done}/${tracks.length}`, matched })));
      if (!uris.length) throw new Error("이 장면의 곡들이 Spotify에 없어 플레이리스트를 만들지 못했어요.");
      setSpotify((s) => ({ ...s, progress: `${uris.length}곡으로 플레이리스트 만드는 중…` }));
      const desc = (result.tagline ? result.tagline + " · " : "") + "Made by Scene FM";
      const pl = await spPost(access, `/users/${userId}/playlists`, {
        name: result.station || "Scene FM", description: desc, public: false,
      });
      // Spotify에 있는 곡만으로 생성 (100곡 단위 배치)
      for (let i = 0; i < uris.length; i += 100) {
        await spPost(access, `/playlists/${pl.id}/tracks`, { uris: uris.slice(i, i + 100) });
      }
      setSpotify({ status: "done", url: pl.external_urls?.spotify || "", matched: uris.length, total: tracks.length, progress: "", error: "" });
    } catch (e) {
      setSpotify((s) => ({ ...s, status: "error", error: e.message || "저장에 실패했어요.", progress: "" }));
    }
  }, [result]);

  // 앱 내 재생 시작: Premium 계정으로 SDK 플레이어를 띄우고 곡 큐를 순서대로 재생
  const playInApp = useCallback(async () => {
    const tracks = (result && result.tracks) || [];
    if (!tracks.length) return;
    try {
      setPlayer((p) => ({ ...p, status: "connecting", error: "", premiumRequired: false }));
      const { access } = await ensureSpotify();

      setPlayer((p) => ({ ...p, status: "resolving" }));
      const uris = await resolveQueueUris(access, tracks);
      if (!uris.length) throw new Error("이 장면의 곡들이 Spotify에 없어요.");

      await loadSpotifySdk();
      let sdkPlayer = playerRef.current;
      if (!sdkPlayer) {
        sdkPlayer = new window.Spotify.Player({
          name: "Scene FM",
          getOAuthToken: (cb) => cb(tokenRef.current.access),
          volume: 0.85,
        });
        sdkPlayer.addListener("initialization_error", ({ message }) =>
          setPlayer((p) => ({ ...p, status: "error", error: message })));
        sdkPlayer.addListener("authentication_error", () =>
          setPlayer((p) => ({ ...p, status: "error", error: "인증이 만료됐어요. 다시 로그인해 주세요.", premiumRequired: false })));
        sdkPlayer.addListener("account_error", () =>
          setPlayer((p) => ({ ...p, status: "error", error: "Spotify Premium 계정이 필요해요.", premiumRequired: true })));
        sdkPlayer.addListener("playback_error", ({ message }) =>
          setPlayer((p) => ({ ...p, error: message })));
        sdkPlayer.addListener("player_state_changed", (s) => {
          if (!s) return;
          const cur = s.track_window?.current_track;
          setPlayer((p) => ({
            ...p,
            isPlaying: !s.paused,
            progressMs: s.position, durationMs: s.duration,
            track: cur ? { name: cur.name, artist: (cur.artists || []).map((a) => a.name).join(", "), art: cur.album?.images?.[0]?.url } : p.track,
            index: Math.max(0, uris.indexOf(cur?.uri)) ,
          }));
        });
        sdkPlayer.addListener("ready", async ({ device_id }) => {
          playerRef.current = sdkPlayer;
          setPlayer((p) => ({ ...p, status: "ready", deviceId: device_id, uris, index: 0 }));
          try {
            // 디바이스가 Spotify 백엔드에 완전히 등록될 시간을 준다
            await new Promise((r) => setTimeout(r, 700));
            // device_id 쿼리만으로 '이 디바이스 활성화 + 지정 큐 재생'이 함께 처리된다.
            // 별도 transfer(/me/player) 호출은 기존 재생 컨텍스트를 상속시켜
            // '틀던 곡이 그대로 나오는' 원인이 되므로 제거.
            await startPlayback(tokenRef.current.access, device_id, uris);
          } catch (e) {
            setPlayer((p) => ({ ...p, error: e.message }));
          }
        });
        await sdkPlayer.connect();
      } else {
        setPlayer((p) => ({ ...p, status: "ready", uris, index: 0 }));
        try {
          await startPlayback(tokenRef.current.access, player.deviceId, uris);
        } catch (e) {
          setPlayer((p) => ({ ...p, error: e.message }));
        }
      }
    } catch (e) {
      setPlayer((p) => ({ ...p, status: "error", error: e.message || "재생을 시작하지 못했어요." }));
    }
  }, [result, ensureSpotify, resolveQueueUris, player.deviceId]);

  const togglePlay = useCallback(() => { playerRef.current?.togglePlay(); }, []);
  const nextTrack = useCallback(() => { playerRef.current?.nextTrack(); }, []);
  const prevTrack = useCallback(() => { playerRef.current?.previousTrack(); }, []);
  const seekTo = useCallback((ms) => { playerRef.current?.seek(ms); }, []);

  useEffect(() => () => { playerRef.current?.disconnect(); }, []);

  const stagePreview = useCallback((frames) => {
    const list = Array.isArray(frames) ? frames : [frames];
    setPendingFrames(list); setShot(list[0]);
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    setLiveCam(false); setRecording(false);
    setStage("preview");
  }, []);

  const onShutter = async () => {
    if (mode === "video") {
      if (liveCam && videoRef.current && videoRef.current.videoWidth) {
        setRecording(true);
        const frames = await captureLiveFrames(videoRef.current, 3, 600);
        stagePreview(frames);
      } else { videoFileRef.current?.click(); }
      return;
    }
    if (liveCam && videoRef.current && videoRef.current.videoWidth) stagePreview([videoFrameToJpeg(videoRef.current)]);
    else fileRef.current?.click();
  };
  const onPick = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { stagePreview([await fileToScaledJpeg(f)]); } catch (err) { setError(err.message); setStage("error"); }
    e.target.value = "";
  };
  const onPickVideo = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { stagePreview(await sampleVideoFile(f)); } catch (err) { setError(err.message); setStage("error"); }
    e.target.value = "";
  };
  const confirmAnalyze = () => { if (pendingFrames) analyze(pendingFrames); };
  const adjustMood = (key) => { setBusyMood(key); analyze(shot, key); };
  const restart = () => {
    if (playerRef.current) { try { playerRef.current.pause(); } catch {} try { playerRef.current.disconnect(); } catch {} playerRef.current = null; }
    setPlayer({ status: "idle", deviceId: "", uris: [], index: 0, isPlaying: false, track: null, progressMs: 0, durationMs: 0, error: "", premiumRequired: false });
    setResult(null); setShot(null); setError(""); setStage("capture"); setRecording(false); setSpotify({ status: "idle", progress: "", url: "", matched: 0, total: 0, error: "" });
  };
  const goCapture = (m) => { if (m) setMode(m); setError(""); setStage("capture"); };
  const connectSpotify = async () => { try { await ensureSpotify(); } catch {} };

  if (isAuthCallback) {
    return (
      <div className="sfm-body" style={{ minHeight: "100%", background: "#FFFFFF", color: "#141413",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <p className="sfm-mono" style={{ fontSize: 13 }}>Spotify 연결 완료 · 창을 닫는 중…</p>
      </div>
    );
  }

  const root = { minHeight: "100%", background: "#FFFFFF", color: "#141413" };
  return (
    <div className="sfm-body" style={root}>
      <style>{FONT_CSS}</style>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onPick} style={{ display: "none" }} />
      <input ref={videoFileRef} type="file" accept="video/*" capture="environment" onChange={onPickVideo} style={{ display: "none" }} />
      <div style={{ maxWidth: 480, margin: "0 auto", minHeight: "100%", position: "relative" }}>
        {stage === "home" && <HomeView onPhoto={() => goCapture("photo")} onVideo={() => goCapture("video")} onSpotify={connectSpotify} />}
        {stage === "capture" && <CaptureView liveCam={liveCam} videoRef={videoRef} onShutter={onShutter}
          onUpload={() => (mode === "video" ? videoFileRef : fileRef).current?.click()}
          mode={mode} setMode={setMode} recording={recording} />}
        {stage === "preview" && <PreviewView shot={shot} frames={pendingFrames} accent={accent} onRetake={() => goCapture()} onConfirm={confirmAnalyze} />}
        {stage === "analyzing" && <AnalyzingView shot={shot} accent={accent} />}
        {stage === "error" && <ErrorView msg={error} onRetry={restart} />}
        {stage === "station" && result && (
          <StationView result={result} shot={shot} accent={accent} accent2={accent2}
            onMood={adjustMood} busyMood={busyMood} onRestart={restart} error={error}
            spotify={spotify} onSaveSpotify={saveToSpotify}
            player={player} onPlayInApp={playInApp} onTogglePlay={togglePlay} onNext={nextTrack} onPrev={prevTrack} onSeek={seekTo} />
        )}
      </div>
    </div>
  );
}

// ── SceneFM · Studio UI (modern-simple, light) ───────────────────────────────
// Presentational layer only. All app logic lives above (unchanged). Korean
// display = Gothic A1, Latin/labels = Space Grotesk, mono = Space Mono.

const STU = { bg: "#FFFFFF", ink: "#141413", sub: "#7C7A75", faint: "#9C9A93", fill: "#F4F3F0", line: "rgba(20,20,19,.10)" };
const SCENE_BG =
  "radial-gradient(120% 85% at 72% 16%, #FFE0A8 0%, rgba(255,224,168,0) 52%)," +
  "linear-gradient(180deg, #F4AE63 0%, #E0662A 42%, #A6364B 74%, #4E2747 100%)";
const stKick = { fontFamily: "'Space Grotesk',system-ui,sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: ".14em", textTransform: "uppercase" };

function fmtTime(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Wordmark({ light }) {
  return <span className="sfm-lat" style={{ fontWeight: 700, fontSize: 17, letterSpacing: "-.01em", color: light ? "#fff" : STU.ink }}>SceneFM</span>;
}

// ── Home ──
function HomeView({ onPhoto, onVideo, onSpotify }) {
  return (
    <div className="sfm-body" style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", background: STU.bg, color: STU.ink }}>
      <div style={{ position: "relative", height: "46%", minHeight: 320, background: SCENE_BG }}>
        <div style={{ position: "absolute", inset: 0, background: "rgba(20,12,10,.12)" }} />
        <div style={{ position: "absolute", top: 52, left: 22, right: 22, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Wordmark light /><span className="sfm-lat" style={{ ...stKick, color: "rgba(255,255,255,.85)" }}>AI Playlist</span>
        </div>
        <h1 className="sfm-display sfm-rise" style={{ position: "absolute", left: 22, right: 22, bottom: 26, margin: 0, color: "#fff", fontSize: 40, lineHeight: 1.02, letterSpacing: "-.02em", textShadow: "0 2px 30px rgba(0,0,0,.35)" }}>
          장면을 음악으로<br />바꾸는 순간
        </h1>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "26px 22px 40px" }}>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: STU.sub }}>
          사진 한 장이면 충분해요. 장소·빛·색감·분위기를 읽어 지금 이 장면에 어울리는 플레이리스트를 만들어 드립니다.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button onClick={onPhoto} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 9, padding: "16px", borderRadius: 4, border: "none", background: STU.ink, color: "#fff", cursor: "pointer", fontWeight: 800, fontSize: 16 }}><CameraIcon /> 사진 찍기</button>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onVideo} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "14px", borderRadius: 4, border: `1px solid ${STU.line}`, background: STU.bg, color: STU.ink, cursor: "pointer", fontWeight: 700, fontSize: 14 }}><VideoIcon /> 영상</button>
            <button onClick={onSpotify} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "14px", borderRadius: 4, border: `1px solid ${STU.line}`, background: STU.bg, color: STU.ink, cursor: "pointer", fontWeight: 700, fontSize: 14 }}><SpotifyIcon size={16} color={STU.ink} /> Spotify</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Capture (keeps live <video> feed) ──
function CaptureView({ liveCam, videoRef, onShutter, onUpload, mode, setMode, recording }) {
  const isVideo = mode === "video";
  const seg = (k, label) => (
    <button key={k} onClick={() => setMode(k)} style={{ flex: 1, padding: "9px 0", borderRadius: 3, border: "none", cursor: "pointer", fontFamily: "'Gothic A1',sans-serif", fontWeight: 700, fontSize: 13.5, background: mode === k ? "#fff" : "transparent", color: mode === k ? STU.ink : "rgba(255,255,255,.8)" }}>{label}</button>
  );
  return (
    <div className="sfm-body" style={{ position: "relative", height: "100dvh", minHeight: 560, background: "#0E0C0A", overflow: "hidden" }}>
      <video ref={videoRef} muted playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: liveCam ? 0.96 : 0, transition: "opacity .4s" }} />
      {!liveCam && <div style={{ position: "absolute", inset: 0, background: SCENE_BG }} />}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,.35), rgba(0,0,0,0) 28%, rgba(0,0,0,0) 58%, rgba(0,0,0,.62))" }} />
      {recording && <div style={{ position: "absolute", inset: 0, border: "3px solid #ff5a4d", boxSizing: "border-box" }} />}
      <div style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column", padding: "52px 22px 40px", color: "#fff" }}>
        <div className="sfm-rise" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Wordmark light />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, ...stKick, fontSize: 10, color: "#fff", background: "rgba(255,255,255,.16)", padding: "5px 10px", borderRadius: 3 }}>
            <span className={liveCam ? "sfm-pulse" : ""} style={{ width: 6, height: 6, borderRadius: "50%", background: liveCam ? "#5CE08F" : "#bbb" }} /> {recording ? "REC" : "LIVE"}
          </span>
        </div>
        <div className="sfm-rise" style={{ marginTop: "auto", textAlign: "center" }}>
          <h2 className="sfm-display" style={{ margin: "0 0 22px", fontWeight: 800, fontSize: 24, lineHeight: 1.25, textShadow: "0 2px 18px rgba(0,0,0,.45)" }}>
            {recording ? "움직임을 읽는 중…" : isVideo ? "몇 초간의 움직임을 담으세요" : "프레임 안에 장면을 담으세요"}
          </h2>
          <div style={{ display: "flex", gap: 4, padding: 4, borderRadius: 6, background: "rgba(0,0,0,.4)", backdropFilter: "blur(8px)", maxWidth: 200, margin: "0 auto 22px" }}>{seg("photo", "사진")}{seg("video", "영상")}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 32 }}>
            <button onClick={onUpload} aria-label={isVideo ? "영상 가져오기" : "앨범에서 가져오기"} style={{ width: 48, height: 48, borderRadius: 4, border: "1px solid rgba(255,255,255,.3)", background: "rgba(255,255,255,.12)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(6px)" }}><GalleryIcon /></button>
            <button onClick={onShutter} disabled={recording} aria-label="촬영" style={{ width: 74, height: 74, borderRadius: "50%", border: "4px solid #fff", background: "transparent", cursor: recording ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ width: 56, height: 56, borderRadius: isVideo ? 8 : "50%", background: isVideo ? "#ff5a4d" : "#fff", transition: "all .2s" }} />
            </button>
            <div style={{ width: 48 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Preview ──
function PreviewView({ shot, frames, accent, onRetake, onConfirm }) {
  const isVideo = Array.isArray(frames) && frames.length > 1;
  return (
    <div className="sfm-body" style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", background: STU.bg, color: STU.ink }}>
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {shot && <img src={shot} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,.3), rgba(0,0,0,0) 26%)" }} />
        <div style={{ position: "absolute", top: 52, left: 22, right: 22 }}><Wordmark light /></div>
        {isVideo && (
          <div style={{ position: "absolute", left: 16, right: 16, bottom: 16, display: "flex", gap: 6 }}>
            {frames.map((f, i) => <img key={i} src={f} alt="" style={{ flex: 1, height: 44, objectFit: "cover", borderRadius: 4, border: "1px solid rgba(255,255,255,.3)" }} />)}
          </div>
        )}
      </div>
      <div style={{ padding: "20px 22px 40px" }}>
        <p style={{ textAlign: "center", fontSize: 14, color: STU.sub, margin: "0 0 16px" }}>{isVideo ? "이 영상으로 플레이리스트를 만들까요?" : "이 장면으로 플레이리스트를 만들까요?"}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onRetake} style={{ flex: 1, padding: "15px", borderRadius: 4, border: `1px solid ${STU.line}`, background: STU.bg, color: STU.ink, cursor: "pointer", fontWeight: 700, fontSize: 15 }}>다시 찍기</button>
          <button onClick={onConfirm} style={{ flex: 2, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "15px", borderRadius: 4, border: "none", background: STU.ink, color: "#fff", cursor: "pointer", fontWeight: 800, fontSize: 15 }}><PlayIcon /> 이 장면으로 분석</button>
        </div>
      </div>
    </div>
  );
}

// ── Analyzing ──
function AnalyzingView({ shot, accent }) {
  const [i, setI] = useState(0);
  const steps = ["장면을 읽는 중", "색과 빛을 분석 중", "속도감을 재는 중", "음악을 고르는 중"];
  useEffect(() => { const id = setInterval(() => setI((p) => (p + 1) % steps.length), 1100); return () => clearInterval(id); }, []);
  return (
    <div className="sfm-body" style={{ height: "100dvh", minHeight: 560, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 22, background: STU.bg, color: STU.ink }}>
      <div style={{ position: "relative", width: 220, height: 220, borderRadius: 8, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,.16)", border: `1px solid ${STU.line}` }}>
        {shot && <img src={shot} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
        <div className="sfm-sweep" style={{ position: "absolute", left: 0, right: 0, height: "45%", background: `linear-gradient(180deg, ${accent}00, ${accent}66, ${accent}00)`, animation: "sfm-sweep 1.6s linear infinite" }} />
      </div>
      <div className="sfm-spin" style={{ marginTop: 30, width: 26, height: 26, borderRadius: "50%", border: `2px solid ${STU.fill}`, borderTopColor: accent, animation: "sfm-spin 1s linear infinite" }} />
      <p className="sfm-lat" style={{ marginTop: 16, fontSize: 13, color: STU.ink, letterSpacing: ".04em" }}>{steps[i]}<span className="sfm-pulse">…</span></p>
      <p style={{ marginTop: 6, fontSize: 12.5, color: STU.sub }}>장면에 어울리는 곡을 구성하는 중</p>
    </div>
  );
}

// ── Error ──
function ErrorView({ msg, onRetry }) {
  return (
    <div className="sfm-body" style={{ height: "100dvh", minHeight: 480, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center", background: STU.bg, color: STU.ink }}>
      <div className="sfm-display" style={{ fontSize: 28, marginBottom: 10 }}>장면을 읽지 못했어요</div>
      <p style={{ color: STU.sub, fontSize: 14, maxWidth: 280, lineHeight: 1.55 }}>{msg} 다시 촬영하면 새로 만들어 볼게요.</p>
      <button onClick={onRetry} style={{ marginTop: 22, padding: "14px 24px", borderRadius: 4, border: "none", background: STU.ink, color: "#fff", cursor: "pointer", fontWeight: 800, fontSize: 15 }}>다시 촬영</button>
    </div>
  );
}

// ── Round icon button (shuffle / add) ──
function RoundBtn({ onClick, label, children, accent }) {
  return (
    <button onClick={onClick} aria-label={label} style={{ width: 52, height: 52, borderRadius: "50%", border: "none", background: STU.fill, color: STU.ink, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>{children}</button>
  );
}

// ── Sticky bottom now-playing bar with draggable seek (real player.seek) ──
function NowBar({ accent, player, first, onToggle, onPlay, onNext, onSeek }) {
  const ready = player.status === "ready";
  const working = player.status === "connecting" || player.status === "resolving";
  const err = player.status === "error";
  const [dragPct, setDragPct] = useState(null);
  const barRef = useRef(null);
  const dur = player.durationMs || 0;
  const livePct = dur ? Math.min(100, (player.progressMs / dur) * 100) : 0;
  const pct = dragPct != null ? dragPct : livePct;
  const track = ready && player.track ? { t: player.track.name, a: player.track.artist, art: player.track.art } : { t: first?.t || "", a: first?.a || "", art: null };

  const ratioFrom = (e) => { const r = barRef.current.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const onDown = (e) => { if (!ready || !dur) return; setDragPct(ratioFrom(e) * 100); try { e.target.setPointerCapture(e.pointerId); } catch {} };
  const onMove = (e) => { if (dragPct == null) return; setDragPct(ratioFrom(e) * 100); };
  const onUp = () => { if (dragPct == null) return; const r = dragPct / 100; setDragPct(null); onSeek && onSeek(Math.round(r * dur)); };

  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 6 }}>
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 12px 12px", background: "linear-gradient(180deg, rgba(255,255,255,0), #fff 38%)" }}>
        <div style={{ borderRadius: 12, background: STU.ink, color: "#fff", boxShadow: "0 10px 30px rgba(0,0,0,.22)", overflow: "hidden" }}>
          {/* seek line */}
          <div ref={barRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
            style={{ position: "relative", height: 14, display: "flex", alignItems: "center", cursor: ready && dur ? "pointer" : "default", touchAction: "none" }}>
            <div style={{ position: "relative", width: "100%", height: 3, background: "rgba(255,255,255,.18)" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: accent }} />
              {ready && dur > 0 && <div style={{ position: "absolute", top: "50%", left: `${pct}%`, width: dragPct != null ? 14 : 11, height: dragPct != null ? 14 : 11, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,.4)", transform: "translate(-50%,-50%)", transition: "width .12s,height .12s" }} />}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px 12px" }}>
            <div style={{ width: 42, height: 42, borderRadius: 6, flexShrink: 0, overflow: "hidden", background: SCENE_BG }}>{track.art && <img src={track.art} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{working ? (player.status === "connecting" ? "Spotify 연결 중…" : "곡을 찾는 중…") : err ? "재생 오류" : (track.t || "재생 준비")}</div>
              <div className="sfm-lat" style={{ fontSize: 11.5, color: "rgba(255,255,255,.6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{err ? (player.error || "다시 시도해 주세요") : track.a}</div>
            </div>
            {ready && dur > 0 && <span className="sfm-lat" style={{ fontSize: 11, color: "rgba(255,255,255,.55)", flexShrink: 0 }}>{fmtTime(dragPct != null ? (dragPct / 100) * dur : player.progressMs)}</span>}
            <button onClick={ready ? onToggle : onPlay} aria-label="재생/일시정지" style={{ width: 40, height: 40, borderRadius: "50%", border: "none", background: accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
              {working ? <span className="sfm-spin" style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid rgba(255,255,255,.35)", borderTopColor: "#fff", animation: "sfm-spin 1s linear infinite" }} /> : (ready && player.isPlaying ? <PauseIcon /> : <PlayIcon big />)}
            </button>
            {ready && <button onClick={onNext} aria-label="다음" style={{ border: "none", background: "transparent", color: "#fff", cursor: "pointer", display: "flex", flexShrink: 0 }}><NextIcon /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Track row (album-list style) ──
function TrackRow({ t, accent, idx, current, last }) {
  return (
    <div className="sfm-rise" style={{ animationDelay: `${Math.min(idx, 12) * 22}ms` }}>
      <a href={ytmusic(t.t, t.a)} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 2px", textDecoration: "none", color: STU.ink }}>
        <span className="sfm-lat" style={{ width: 22, textAlign: "center", flexShrink: 0, fontSize: 14, color: current ? accent : STU.faint }}>{current ? "●" : idx}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: current ? accent : STU.ink }}>{t.t}</div>
          <div style={{ fontSize: 12.5, color: STU.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.a}{t.y ? ` · ${t.y}` : ""}</div>
        </div>
        <button onClick={(e) => { e.preventDefault(); window.open(spotifySearch(t.t, t.a), "_blank"); }} aria-label="더보기" style={{ border: "none", background: "transparent", color: STU.faint, cursor: "pointer", display: "flex", flexShrink: 0, padding: 4 }}><MoreIcon /></button>
      </a>
      {!last && <div style={{ height: 1, background: STU.line, marginLeft: 36 }} />}
    </div>
  );
}

// ── Station (result) — album-page feel ──
function StationView({ result, shot, accent, accent2, onMood, busyMood, onRestart, error, spotify, onSaveSpotify, player, onPlayInApp, onTogglePlay, onNext, onPrev, onSeek }) {
  const [open, setOpen] = useState(false);
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  const grouped = [1, 2, 3, 4, 5].map((s) => ({ s, items: tracks.filter((t) => Number(t.s) === s) })).filter((g) => g.items.length);
  const sceneOrder = [["place", "장소"], ["time", "시간대"], ["color", "색감"], ["motion", "움직임"], ["weather", "날씨"], ["emotion", "감정"], ["era", "시대감"]];
  const sc = result.scene || {}, mu = result.music || {}, first = tracks[0];

  const ready = player.status === "ready";
  const working = player.status === "connecting" || player.status === "resolving";
  const playing = ready && player.isPlaying;
  const showBar = player.status !== "idle";
  const curName = ready && player.track ? player.track.name : null;

  const meta = [(mu.genres || [])[0], mu.era, mu.bpm && `${mu.bpm} BPM`, mu.vocal].filter(Boolean).join("   ·   ");
  const descBits = [];
  if (sc.place && sc.time) descBits.push(`${sc.place}, ${sc.time}.`);
  const feel = [sc.color && `${sc.color} 빛`, sc.motion, sc.emotion].filter(Boolean).join(", ");
  if (feel) descBits.push(`${feel} 속 ${tracks.length}곡의 흐름.`);
  const desc = descBits.join(" ") || result.tagline || "";

  const saveDone = spotify.status === "done";
  const saveWorking = spotify.status === "connecting" || spotify.status === "working";

  let n = 0;
  return (
    <div className="sfm-body" style={{ minHeight: "100dvh", background: STU.bg, color: STU.ink, position: "relative" }}>
      {/* blurred atmospheric hero */}
      <div style={{ position: "relative" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 360, overflow: "hidden" }}>
          {shot
            ? <img src={shot} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(7px) saturate(1.1)", transform: "scale(1.18)" }} />
            : <div style={{ position: "absolute", inset: 0, background: SCENE_BG, filter: "blur(7px)", transform: "scale(1.18)" }} />}
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(255,255,255,.15) 0%, rgba(255,255,255,.05) 30%, rgba(255,255,255,.55) 64%, #fff 90%)" }} />
        </div>

        <div style={{ position: "relative", padding: "0 22px" }}>
          {/* top bar */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 52 }}>
            <button onClick={onRestart} aria-label="다른 장면" style={{ width: 38, height: 38, borderRadius: "50%", border: "none", background: "rgba(255,255,255,.55)", backdropFilter: "blur(8px)", color: STU.ink, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,.08)" }}><ChevronLeft /></button>
            <Wordmark />
            <button onClick={onSaveSpotify} aria-label="공유/저장" style={{ width: 38, height: 38, borderRadius: "50%", border: "none", background: "rgba(255,255,255,.55)", backdropFilter: "blur(8px)", color: STU.ink, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,.08)" }}><ShareIcon /></button>
          </div>

          {/* spacer revealing the artwork */}
          <div style={{ height: 132 }} />

          {/* title block */}
          <div style={{ textAlign: "center" }}>
            <h1 className="sfm-display" style={{ margin: 0, fontSize: 44, lineHeight: 1.0, letterSpacing: "-.025em" }}>{result.station || "Scene FM"}</h1>
            {result.tagline && <div style={{ marginTop: 6, fontSize: 17, fontWeight: 600, color: STU.ink }}>{result.tagline}</div>}
            {meta && <div className="sfm-lat" style={{ marginTop: 10, fontSize: 12.5, fontWeight: 600, letterSpacing: ".06em", color: accent }}>{meta}</div>}
          </div>

          {/* action row: shuffle · 재생 · + */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, margin: "20px 0 6px" }}>
            <RoundBtn onClick={onPlayInApp} label="셔플 재생"><ShuffleIcon /></RoundBtn>
            <button onClick={ready ? onTogglePlay : onPlayInApp} style={{ flex: 1, maxWidth: 260, height: 58, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, borderRadius: 999, border: "none", background: STU.ink, color: "#fff", cursor: "pointer", fontWeight: 800, fontSize: 18 }}>
              {working ? <><span className="sfm-spin" style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid rgba(255,255,255,.35)", borderTopColor: "#fff", animation: "sfm-spin 1s linear infinite" }} /> 준비 중…</> : <>{playing ? <PauseIcon /> : <PlayIcon big />} {playing ? "일시정지" : "재생"}</>}
            </button>
            <RoundBtn onClick={onSaveSpotify} label="Spotify에 저장">{saveDone ? <CheckIcon /> : <PlusIcon />}</RoundBtn>
          </div>

          {/* save status (only when active) */}
          {spotify.status !== "idle" && (
            <div style={{ textAlign: "center", marginBottom: 4 }}>
              {saveWorking && <span className="sfm-lat" style={{ fontSize: 12, color: STU.sub }}>{spotify.progress || "Spotify에 저장 중…"}</span>}
              {saveDone && <a href={spotify.url || "#"} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: "#1DB954", fontWeight: 700, textDecoration: "none" }}>✓ Spotify에 저장됨 · 열기</a>}
              {spotify.status === "error" && <span style={{ fontSize: 12, color: "#c0392b" }}>{spotify.error}</span>}
            </div>
          )}
        </div>
      </div>

      {/* body */}
      <div style={{ padding: showBar ? "8px 22px 120px" : "8px 22px 44px" }}>
        {desc && <p style={{ fontSize: 14.5, lineHeight: 1.55, color: STU.ink, margin: "10px 0 0" }}>{desc}</p>}

        {/* scene-analysis toggle (hidden by default) */}
        <button onClick={() => setOpen((o) => !o)} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 12, border: "none", background: "transparent", color: STU.sub, cursor: "pointer", fontWeight: 600, fontSize: 13, padding: 0 }}>
          장면 분석 {open ? "접기" : "자세히"} <span style={{ display: "inline-block", transform: open ? "rotate(180deg)" : "none", transition: "transform .18s", fontSize: 9 }}>▾</span>
        </button>
        {open && (
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 7 }}>
            {sceneOrder.filter(([k]) => sc[k]).map(([k, ko]) => <StChip key={k} label={ko} value={sc[k]} />)}
          </div>
        )}

        {/* mood adjust */}
        <div className="sfm-lat" style={{ ...stKick, color: STU.sub, margin: "22px 0 9px" }}>무드 조정</div>
        <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2, margin: "0 -22px", padding: "0 22px 2px" }}>
          {MOODS.map((m) => {
            const busy = busyMood === m.key;
            return (
              <button key={m.key} onClick={() => onMood(m.key)} disabled={!!busyMood}
                style={{ flex: "0 0 auto", padding: "9px 14px", borderRadius: 999, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", cursor: busyMood ? "default" : "pointer", border: `1px solid ${busy ? accent : STU.line}`, background: busy ? accent : STU.bg, color: busy ? "#fff" : STU.ink, opacity: busyMood && !busy ? 0.5 : 1 }}>
                {busy ? "조정 중…" : m.label}
              </button>
            );
          })}
        </div>
        {error && <p style={{ fontSize: 12, color: "#c0392b", marginTop: 8 }}>무드 조정에 실패했어요. 다시 시도해 주세요.</p>}

        {/* track list */}
        <div style={{ height: 1, background: STU.line, margin: "20px 0 4px" }} />
        {grouped.map((g) => (
          <div key={g.s}>
            <div className="sfm-lat" style={{ padding: "16px 2px 6px", fontSize: 11, letterSpacing: ".05em", color: STU.faint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <span style={{ color: accent, fontWeight: 700 }}>0{g.s}</span>
              <span style={{ fontWeight: 700, color: STU.sub, marginLeft: 8 }}>{SECTIONS[g.s].ko}</span>
              <span style={{ color: STU.faint, marginLeft: 8 }}>· {SECTIONS[g.s].desc}</span>
            </div>
            {g.items.map((t, j) => { n += 1; return <TrackRow key={n} t={t} idx={n} accent={accent} current={curName ? t.t === curName : false} last={j === g.items.length - 1} />; })}
          </div>
        ))}
      </div>

      {showBar && <NowBar accent={accent} player={player} first={first} onToggle={onTogglePlay} onPlay={onPlayInApp} onNext={onNext} onSeek={onSeek} />}
    </div>
  );
}

function StChip({ label, value }) {
  return (
    <div style={{ padding: "8px 12px", borderRadius: 4, background: STU.fill }}>
      <div className="sfm-lat" style={{ fontSize: 9, fontWeight: 600, letterSpacing: ".08em", color: STU.sub, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 14, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ── Icons ──
function CameraIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>; }
function VideoIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="14" height="12" rx="2" /><path d="M22 8l-6 4 6 4V8z" /></svg>; }
function GalleryIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.6" /><path d="M21 15l-5-5L5 21" /></svg>; }
function PlayIcon({ big }) { const s = big ? 20 : 14; return <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>; }
function PauseIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>; }
function PrevIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM20 6L10 12l10 6V6z" /></svg>; }
function NextIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l10 6L4 18V6z" /></svg>; }
function ShuffleIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" /></svg>; }
function PlusIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>; }
function CheckIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>; }
function MoreIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>; }
function ChevronLeft() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>; }
function ShareIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M8 8l4-4 4 4" /><path d="M5 12v7a1 1 0 001 1h12a1 1 0 001-1v-7" /></svg>; }
function SpotifyIcon({ size = 18, color = "#1DB954" }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill={color}><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm4.6 14.4a.62.62 0 01-.86.21c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 11-.28-1.21c3.81-.87 7.08-.5 9.72 1.11.3.18.39.57.21.85zm1.23-2.73a.78.78 0 01-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 11-.45-1.49c3.63-1.1 8.15-.56 11.24 1.33.36.22.48.7.25 1.07zm.1-2.85C14.84 8.95 9.6 8.78 6.6 9.69a.93.93 0 11-.54-1.78c3.45-1.05 9.23-.85 12.87 1.31a.93.93 0 11-.95 1.6z" /></svg>; }

