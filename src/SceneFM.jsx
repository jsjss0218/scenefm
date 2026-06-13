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
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap');
.sfm-display{font-family:'Bebas Neue','Arial Narrow',sans-serif;letter-spacing:.02em;line-height:.92}
.sfm-body{font-family:'Inter',system-ui,sans-serif}
.sfm-mono{font-family:'Space Mono',ui-monospace,monospace}
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
  return (await res.json()).access_token;
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

  const accent = result?.palette?.accent || "#FF8C42";
  const accent2 = result?.palette?.accent2 || "#6AA6FF";

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
      const access = await spotifyAuthorize();
      tokenRef.current.access = access;
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
      <div className="sfm-body" style={{ minHeight: "100%", background: "#0a0c12", color: "#F4F1E8",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <p className="sfm-mono" style={{ fontSize: 13 }}>Spotify 연결 완료 · 창을 닫는 중…</p>
      </div>
    );
  }

  const root = { minHeight: "100%", background: "radial-gradient(120% 80% at 50% -10%, #161a26 0%, #0a0c12 55%, #07080d 100%)", color: "#F4F1E8" };
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
            player={player} onPlayInApp={playInApp} onTogglePlay={togglePlay} onNext={nextTrack} onPrev={prevTrack} />
        )}
      </div>
    </div>
  );
}

function Wordmark({ freq = "88.3", accent = "#FF8C42" }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
      <span className="sfm-display" style={{ fontSize: 26, color: "#F4F1E8" }}>SCENE&nbsp;FM</span>
      <span className="sfm-mono" style={{ fontSize: 11, color: accent, letterSpacing: ".1em" }}>◉ {freq} MHz</span>
    </div>
  );
}

function HomeView({ onPhoto, onVideo, onSpotify }) {
  return (
    <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", justifyContent: "center", padding: "28px 26px", position: "relative" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(90% 55% at 50% 22%, #1c2536 0%, #0a0c12 75%)" }} />
      <div style={{ position: "relative" }} className="sfm-rise">
        <div className="sfm-mono" style={{ fontSize: 12, color: "#FF8C42", letterSpacing: ".2em", marginBottom: 10 }}>◉ 88.3 MHz · SCENE FM</div>
        <h1 className="sfm-display" style={{ fontSize: 46, margin: "0 0 14px", lineHeight: .98 }}>지금 보는 장면을<br />플레이리스트로.</h1>
        <p style={{ fontSize: 14, color: "#aab0bd", margin: "0 0 34px", lineHeight: 1.6 }}>
          사진이나 짧은 영상을 찍으면 AI가 장소·빛·색감·속도감·분위기를 분석해<br />지금 이 순간에 어울리는 음악을 만들어줍니다.
        </p>
        <button onClick={onPhoto} style={{ ...solidBtn, width: "100%", boxSizing: "border-box", background: "#F4F1E8", color: "#0a0c12", display: "flex", alignItems: "center", justifyContent: "center", gap: 9, marginBottom: 10 }}>
          <CameraIcon /> 사진 찍기
        </button>
        <button onClick={onVideo} style={{ ...solidBtn, width: "100%", boxSizing: "border-box", background: "rgba(244,241,232,.1)", color: "#F4F1E8", border: "1px solid rgba(244,241,232,.2)", display: "flex", alignItems: "center", justifyContent: "center", gap: 9, marginBottom: 10 }}>
          <VideoIcon /> 짧은 영상 찍기
        </button>
        <button onClick={onSpotify} style={{ ...solidBtn, width: "100%", boxSizing: "border-box", background: "#1DB954", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}>
          <SpotifyIcon color="#fff" /> Spotify 연결하기
        </button>
      </div>
    </div>
  );
}

function PreviewView({ shot, frames, accent, onRetake, onConfirm }) {
  const isVideo = Array.isArray(frames) && frames.length > 1;
  return (
    <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", padding: "20px 22px 28px" }}>
      <div className="sfm-rise" style={{ marginBottom: 14 }}><Wordmark accent={accent} /></div>
      <div className="sfm-rise" style={{ position: "relative", flex: 1, minHeight: 0, borderRadius: 18, overflow: "hidden", background: "#0f1320", border: "1px solid rgba(244,241,232,.1)" }}>
        {shot && <img src={shot} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
        {isVideo && (
          <div style={{ position: "absolute", left: 12, right: 12, bottom: 12, display: "flex", gap: 6 }}>
            {frames.map((f, i) => <img key={i} src={f} alt="" style={{ flex: 1, height: 44, objectFit: "cover", borderRadius: 6, border: "1px solid rgba(244,241,232,.25)" }} />)}
          </div>
        )}
        <div style={{ position: "absolute", top: 12, left: 12, padding: "4px 10px", borderRadius: 999, background: "rgba(10,12,18,.7)", border: "1px solid rgba(244,241,232,.2)" }}>
          <span className="sfm-mono" style={{ fontSize: 11, color: "#cfd3dd" }}>{isVideo ? "영상 · 대표 프레임 3장" : "사진"}</span>
        </div>
      </div>
      <p style={{ textAlign: "center", fontSize: 13, color: "#8b92a3", margin: "16px 0 14px" }}>이 장면으로 플레이리스트를 만들까요?</p>
      <div className="sfm-rise" style={{ display: "flex", gap: 10 }}>
        <button onClick={onRetake} style={{ ...solidBtn, flex: 1, background: "rgba(244,241,232,.1)", color: "#F4F1E8", border: "1px solid rgba(244,241,232,.2)" }}>다시 찍기</button>
        <button onClick={onConfirm} style={{ ...solidBtn, flex: 2, background: accent, color: "#0a0c12", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <PlayIcon /> 이 장면으로 분석하기
        </button>
      </div>
    </div>
  );
}

function ModeToggle({ mode, setMode }) {
  const opt = (key, label) => (
    <button onClick={() => setMode(key)} style={{
      padding: "7px 18px", borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none",
      background: mode === key ? "#F4F1E8" : "transparent", color: mode === key ? "#0a0c12" : "#cfd3dd",
    }}>{label}</button>
  );
  return (
    <div style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 999, background: "rgba(10,12,18,.6)", border: "1px solid rgba(244,241,232,.18)", backdropFilter: "blur(6px)" }}>
      {opt("photo", "사진")}{opt("video", "영상")}
    </div>
  );
}

function CaptureView({ liveCam, videoRef, onShutter, onUpload, mode, setMode, recording }) {
  const isVideo = mode === "video";
  return (
    <div style={{ position: "relative", height: "100dvh", minHeight: 560, display: "flex", flexDirection: "column" }}>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", opacity: liveCam ? 0.9 : 0, transition: "opacity .4s", filter: "saturate(1.05)" }} />
        {!liveCam && <div style={{ position: "absolute", inset: 0, background: "radial-gradient(80% 60% at 50% 35%, #1b2233 0%, #0a0c12 80%)" }} />}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(7,8,13,.7) 0%, rgba(7,8,13,0) 30%, rgba(7,8,13,.85) 100%)" }} />
        {recording && <div style={{ position: "absolute", inset: 0, border: "3px solid #ff5a4d", boxSizing: "border-box" }} />}
      </div>
      <div style={{ position: "relative", padding: "22px 22px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }} className="sfm-rise">
        <Wordmark />
        <ModeToggle mode={mode} setMode={setMode} />
      </div>
      <div style={{ position: "relative", marginTop: "auto", padding: "0 22px", textAlign: "center" }} className="sfm-rise">
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "5px 11px", borderRadius: 999, border: "1px solid rgba(244,241,232,.18)", background: "rgba(10,12,18,.5)" }}>
          <Dot live={liveCam} />
          <span className="sfm-mono" style={{ fontSize: 11, color: "#cfd3dd" }}>
            {recording ? "녹화 중 · 움직임을 읽는 중…" : liveCam ? "카메라 ON · 장면 입력 대기" : "탭하면 카메라가 열려요"}
          </span>
        </div>
        <h1 className="sfm-display" style={{ fontSize: 38, margin: "0 0 6px" }}>
          {isVideo ? "움직이는 장면을 담으세요" : "지금 보는 장면을 찍으세요"}
        </h1>
        <p style={{ fontSize: 14, color: "#9aa0ad", margin: "0 0 26px", lineHeight: 1.5 }}>
          {isVideo
            ? <>몇 초간의 움직임에서 속도감과 흐름을 읽어<br />더 정확한 플레이리스트를 만듭니다.</>
            : <>AI가 장소·빛·색감·속도감·시대감을 읽고<br />그 순간의 플레이리스트를 바로 만듭니다.</>}
        </p>
      </div>
      <div style={{ position: "relative", padding: "0 22px 34px", display: "flex", alignItems: "center", justifyContent: "center", gap: 28 }} className="sfm-rise">
        <button onClick={onUpload} aria-label={isVideo ? "영상 가져오기" : "앨범에서 가져오기"} style={ghostBtn}><GalleryIcon /><span style={{ fontSize: 11, marginTop: 4 }}>{isVideo ? "영상" : "앨범"}</span></button>
        <button onClick={onShutter} disabled={recording} aria-label="촬영" style={shutterBtn}>
          <span style={{ position: "absolute", inset: isVideo ? 22 : 7, borderRadius: isVideo ? 8 : "50%", background: isVideo ? "#ff5a4d" : "#F4F1E8", boxShadow: "inset 0 0 0 2px #0a0c12", transition: "all .2s" }} />
        </button>
        <div style={{ width: 52 }} />
      </div>
    </div>
  );
}
function Dot({ live }) { return <span className={live ? "sfm-pulse" : ""} style={{ width: 7, height: 7, borderRadius: "50%", background: live ? "#5ce08f" : "#6b7180", display: "inline-block" }} />; }
const ghostBtn = { width: 52, height: 52, borderRadius: 14, border: "1px solid rgba(244,241,232,.2)", background: "rgba(20,24,34,.55)", color: "#cfd3dd", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", backdropFilter: "blur(6px)" };
const shutterBtn = { position: "relative", width: 78, height: 78, borderRadius: "50%", cursor: "pointer", border: "3px solid rgba(244,241,232,.85)", background: "transparent" };
function GalleryIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.6" /><path d="M21 15l-5-5L5 21" /></svg>; }

function AnalyzingView({ shot, accent }) {
  const [i, setI] = useState(0);
  const steps = ["장면을 읽는 중", "색과 빛을 듣는 중", "속도감을 재는 중", "주파수를 맞추는 중"];
  useEffect(() => { const id = setInterval(() => setI((p) => (p + 1) % steps.length), 1100); return () => clearInterval(id); }, []);
  return (
    <div style={{ height: "100dvh", minHeight: 560, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 22, position: "relative" }}>
      <div style={{ position: "relative", width: 230, height: 230, borderRadius: 20, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,.5)", border: "1px solid rgba(244,241,232,.12)" }}>
        {shot && <img src={shot} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "saturate(1.1) brightness(.92)" }} />}
        <div style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, ${accent}00, ${accent}22)` }} />
        <div className="sfm-sweep" style={{ position: "absolute", left: 0, right: 0, height: "45%", background: `linear-gradient(180deg, ${accent}00, ${accent}55, ${accent}00)`, animation: "sfm-sweep 1.6s linear infinite" }} />
      </div>
      <div className="sfm-spin" style={{ marginTop: 34, width: 30, height: 30, borderRadius: "50%", border: "2px solid rgba(244,241,232,.15)", borderTopColor: accent, animation: "sfm-spin 1s linear infinite" }} />
      <p className="sfm-mono" style={{ marginTop: 18, fontSize: 13, color: "#cfd3dd", letterSpacing: ".06em" }}>{steps[i]}<span className="sfm-pulse" style={{ animation: "sfm-pulse 1s infinite" }}>…</span></p>
      <p style={{ marginTop: 6, fontSize: 12, color: "#6b7180" }}>SCENE FM이 방송국을 만드는 중</p>
    </div>
  );
}
function ErrorView({ msg, onRetry }) {
  return (
    <div style={{ height: "100dvh", minHeight: 480, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center" }}>
      <div className="sfm-display" style={{ fontSize: 30, marginBottom: 8 }}>주파수를 놓쳤어요</div>
      <p style={{ color: "#9aa0ad", fontSize: 14, maxWidth: 280, lineHeight: 1.5 }}>{msg} 장면을 다시 찍으면 새 방송국을 만들어 볼게요.</p>
      <button onClick={onRetry} style={{ ...solidBtn, marginTop: 22, background: "#F4F1E8", color: "#0a0c12" }}>다시 촬영</button>
    </div>
  );
}

function StationView({ result, shot, accent, accent2, onMood, busyMood, onRestart, error, spotify, onSaveSpotify, player, onPlayInApp, onTogglePlay, onNext, onPrev }) {
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  const grouped = [1, 2, 3, 4, 5].map((s) => ({ s, items: tracks.filter((t) => Number(t.s) === s) })).filter((g) => g.items.length);
  const sceneOrder = [["place", "장소"], ["time", "시간대"], ["color", "색감"], ["motion", "움직임"], ["weather", "날씨"], ["emotion", "감정"], ["era", "시대감"]];
  const sc = result.scene || {}, mu = result.music || {}, first = tracks[0];
  return (
    <div style={{ paddingBottom: 92 }}>
      <div style={{ position: "relative", height: 300, overflow: "hidden" }}>
        {shot && <img src={shot} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", filter: "saturate(1.12)" }} />}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(7,8,13,.55) 0%, rgba(7,8,13,.1) 35%, rgba(7,8,13,.96) 100%)" }} />
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "18px 20px" }}><Wordmark freq={result.freq || "88.3"} accent={accent} /></div>
        <div style={{ position: "absolute", left: 20, right: 20, bottom: 16 }} className="sfm-rise">
          <div className="sfm-mono" style={{ fontSize: 11, color: accent, letterSpacing: ".14em", marginBottom: 4 }}>◉ NOW BROADCASTING</div>
          <h1 className="sfm-display" style={{ fontSize: 52, margin: 0, textShadow: "0 2px 30px rgba(0,0,0,.6)" }}>{result.station || "Scene FM"}</h1>
          {result.tagline && <p style={{ margin: "2px 0 0", fontSize: 14, color: "#e6e2d8" }}>{result.tagline}</p>}
        </div>
      </div>

      <div style={{ padding: "16px 20px 0" }}>
        {/* 앱 내 재생 (Spotify Premium · Web Playback SDK) */}
        <InAppPlayer accent={accent} player={player} onPlay={onPlayInApp} onToggle={onTogglePlay} onNext={onNext} onPrev={onPrev} first={first} />

        {/* Spotify 자동 저장 (2단계) */}
        <SpotifySave spotify={spotify} onSave={onSaveSpotify} total={tracks.length} />

        <SectionLabel>장면 분석</SectionLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {sceneOrder.filter(([k]) => sc[k]).map(([k, ko]) => (
            <div key={k} style={{ padding: "6px 10px", borderRadius: 9, background: "rgba(20,24,34,.7)", border: "1px solid rgba(244,241,232,.08)" }}>
              <span className="sfm-mono" style={{ fontSize: 10, color: "#6b7180", display: "block", letterSpacing: ".05em" }}>{ko}</span>
              <span style={{ fontSize: 13, color: "#e6e2d8" }}>{sc[k]}</span>
            </div>
          ))}
        </div>

        <SectionLabel>음악 태그</SectionLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 6 }}>
          {(mu.genres || []).map((g, idx) => <span key={idx} style={{ padding: "6px 11px", borderRadius: 999, fontSize: 12.5, fontWeight: 600, color: "#0a0c12", background: idx % 2 ? accent2 : accent }}>{g}</span>)}
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {[["시대", mu.era], ["BPM", mu.bpm], ["에너지", mu.energy], ["보컬", mu.vocal]].filter(([, v]) => v).map(([k, v]) => (
            <div key={k}><span className="sfm-mono" style={{ fontSize: 10, color: "#6b7180", display: "block" }}>{k}</span><span className="sfm-mono" style={{ fontSize: 13, color: accent }}>{v}</span></div>
          ))}
        </div>

        <SectionLabel>플레이리스트 흐름</SectionLabel>
        <EnergyCurve accent={accent} accent2={accent2} groups={grouped} />

        <div style={{ marginTop: 18 }}>
          {grouped.map((g) => (
            <div key={g.s} style={{ marginBottom: 22 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                <span className="sfm-mono" style={{ fontSize: 11, color: accent }}>0{g.s}</span>
                <span className="sfm-display" style={{ fontSize: 22 }}>{SECTIONS[g.s].ko}</span>
                <span style={{ fontSize: 11, color: "#6b7180" }}>{SECTIONS[g.s].desc}</span>
              </div>
              {g.items.map((t, idx) => <TrackRow key={idx} t={t} accent={accent} idx={idx} />)}
            </div>
          ))}
        </div>

        {error && <p style={{ fontSize: 12, color: "#e0a05c", textAlign: "center", marginTop: 4 }}>무드 조정에 실패했어요. 다시 시도해 주세요.</p>}

        <button onClick={onRestart} style={{ ...ghostWide, marginTop: 6 }}><CameraIcon /> 다른 장면 다시 촬영</button>
        <p className="sfm-mono" style={{ fontSize: 10, color: "#565c69", textAlign: "center", margin: "18px 0 4px", lineHeight: 1.6 }}>
          곡 탭 → YouTube Music 즉시 재생 · Spotify 저장 → 내 계정에 자동 플레이리스트 생성
        </p>
      </div>

      <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 5 }}>
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "10px 12px", background: "linear-gradient(180deg, rgba(10,12,18,0), rgba(10,12,18,.96) 30%)" }}>
          <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2 }}>
            {MOODS.map((m) => {
              const busy = busyMood === m.key;
              return (
                <button key={m.key} onClick={() => onMood(m.key)} disabled={!!busyMood}
                  style={{ flex: "0 0 auto", padding: "9px 14px", borderRadius: 999, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", cursor: busyMood ? "default" : "pointer", border: `1px solid ${busy ? accent : "rgba(244,241,232,.2)"}`, background: busy ? accent : "rgba(28,33,48,.9)", color: busy ? "#0a0c12" : "#e6e2d8", opacity: busyMood && !busy ? 0.5 : 1 }}>
                  {busy ? "조정 중…" : m.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtTime(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function InAppPlayer({ accent, player, onPlay, onToggle, onNext, onPrev, first }) {
  const GREEN = "#1DB954";
  const base = { borderRadius: 14, padding: "14px 16px", border: "1px solid rgba(244,241,232,.1)", background: "rgba(20,24,34,.6)" };

  if (player.status === "ready" || player.status === "resolving" || player.status === "connecting") {
    const working = player.status !== "ready";
    const pct = player.durationMs ? Math.min(100, (player.progressMs / player.durationMs) * 100) : 0;
    return (
      <div style={base}>
        {working ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
            <div className="sfm-spin" style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid rgba(244,241,232,.15)", borderTopColor: accent, animation: "sfm-spin 1s linear infinite" }} />
            <span className="sfm-mono" style={{ fontSize: 12, color: "#cfd3dd" }}>
              {player.status === "connecting" ? "Spotify 연결 중…" : "곡을 찾는 중…"}
            </span>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {player.track?.art && <img src={player.track.art} alt="" style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover" }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#F4F1E8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {player.track?.name || "재생 준비 중…"}
                </div>
                <div className="sfm-mono" style={{ fontSize: 11, color: "#9aa0ad", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {player.track?.artist || ""}
                </div>
              </div>
              <button onClick={onPrev} aria-label="이전 곡" style={iconBtn}><PrevIcon /></button>
              <button onClick={onToggle} aria-label="재생/일시정지" style={{ ...iconBtn, width: 40, height: 40, background: accent, color: "#0a0c12" }}>
                {player.isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button onClick={onNext} aria-label="다음 곡" style={iconBtn}><NextIcon /></button>
            </div>
            <div style={{ marginTop: 10, height: 3, borderRadius: 2, background: "rgba(244,241,232,.12)", overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: accent, transition: "width .25s linear" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span className="sfm-mono" style={{ fontSize: 10, color: "#6b7180" }}>{fmtTime(player.progressMs)}</span>
              <span className="sfm-mono" style={{ fontSize: 10, color: "#6b7180" }}>{fmtTime(player.durationMs)}</span>
            </div>
          </>
        )}
        {player.error && <p style={{ fontSize: 11, color: "#ff9b8a", margin: "8px 2px 0" }}>{player.error}</p>}
      </div>
    );
  }

  if (player.status === "error") {
    return (
      <div style={base}>
        <p style={{ fontSize: 13, color: "#e6e2d8", margin: "0 0 10px" }}>
          {player.premiumRequired ? "앱 내 재생은 Spotify Premium 계정에서만 가능해요." : (player.error || "앱 내 재생을 시작하지 못했어요.")}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onPlay} style={{ ...solidBtn, flex: 1, background: GREEN, color: "#fff" }}>다시 시도</button>
          {first && (
            <a href={ytmusic(first.t, first.a)} target="_blank" rel="noreferrer" style={{ ...solidBtn, flex: 1, textAlign: "center", textDecoration: "none", background: "rgba(244,241,232,.12)", color: "#e6e2d8" }}>
              YouTube Music에서 듣기
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <button onClick={onPlay} style={{ ...solidBtn, width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", gap: 9, background: accent, color: "#0a0c12" }}>
      <PlayIcon /> 앱에서 바로 재생 (Spotify Premium)
    </button>
  );
}
const iconBtn = { width: 32, height: 32, borderRadius: "50%", border: "none", background: "rgba(244,241,232,.12)", color: "#F4F1E8", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" };
function PauseIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>; }
function PrevIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM20 6L10 12l10 6V6z" /></svg>; }
function NextIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l10 6L4 18V6z" /></svg>; }

function SpotifySave({ spotify, onSave, total }) {
  const GREEN = "#1DB954";
  const base = { borderRadius: 14, padding: "14px 16px", marginTop: 10, border: "1px solid rgba(29,185,84,.35)", background: "rgba(29,185,84,.08)" };
  if (spotify.status === "done") {
    return (
      <div style={{ ...base }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <SpotifyIcon color={GREEN} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>플레이리스트 저장 완료</div>
            <div className="sfm-mono" style={{ fontSize: 11, color: "#9aa0ad" }}>{spotify.total}곡 중 {spotify.matched}곡 매칭 · 내 Spotify에 생성됨</div>
          </div>
        </div>
        {spotify.url && (
          <a href={spotify.url} target="_blank" rel="noreferrer" style={{ ...solidBtn, display: "block", textAlign: "center", textDecoration: "none", marginTop: 12, background: GREEN, color: "#fff" }}>
            Spotify에서 열기
          </a>
        )}
      </div>
    );
  }
  const working = spotify.status === "connecting" || spotify.status === "working";
  return (
    <div style={base}>
      <button onClick={onSave} disabled={working}
        style={{ ...solidBtn, width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", gap: 9, background: working ? "rgba(29,185,84,.4)" : GREEN, color: "#fff", cursor: working ? "default" : "pointer" }}>
        <SpotifyIcon color="#fff" />
        {working ? (spotify.progress || "처리 중…") : `Spotify에 플레이리스트 저장 (${total}곡)`}
      </button>
      {spotify.status === "error" && <p style={{ fontSize: 12, color: "#ff9b8a", margin: "9px 2px 0" }}>{spotify.error}</p>}
      {spotify.status === "idle" && <p className="sfm-mono" style={{ fontSize: 10, color: "#7d8493", margin: "8px 2px 0", textAlign: "center" }}>내 Spotify 계정으로 로그인 → 자동 생성</p>}
    </div>
  );
}
function SpotifyIcon({ color = "#1DB954" }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill={color}><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm4.6 14.4a.62.62 0 01-.86.21c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 11-.28-1.21c3.81-.87 7.08-.5 9.72 1.11.3.18.39.57.21.85zm1.23-2.73a.78.78 0 01-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 11-.45-1.49c3.63-1.1 8.15-.56 11.24 1.33.36.22.48.7.25 1.07zm.1-2.85C14.84 8.95 9.6 8.78 6.6 9.69a.93.93 0 11-.54-1.78c3.45-1.05 9.23-.85 12.87 1.31a.93.93 0 11-.95 1.6z"/></svg>;
}

function SectionLabel({ children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "22px 0 11px" }}>
      <span className="sfm-mono" style={{ fontSize: 11, color: "#6b7180", letterSpacing: ".16em", textTransform: "uppercase" }}>{children}</span>
      <span style={{ flex: 1, height: 1, background: "rgba(244,241,232,.1)" }} />
    </div>
  );
}
function TrackRow({ t, accent, idx }) {
  return (
    <a href={ytmusic(t.t, t.a)} target="_blank" rel="noreferrer" className="sfm-rise" style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 6px", textDecoration: "none", borderBottom: "1px solid rgba(244,241,232,.06)", animationDelay: `${idx * 30}ms` }}>
      <span className="sfm-mono" style={{ fontSize: 12, color: "#565c69", width: 16, textAlign: "right" }}>{idx + 1}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 14.5, color: "#F4F1E8", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.t}</span>
        <span style={{ display: "block", fontSize: 12.5, color: "#8b92a3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.a}{t.y ? ` · ${t.y}` : ""}</span>
      </span>
      <span onClick={(e) => { e.preventDefault(); window.open(spotifySearch(t.t, t.a), "_blank"); }} title="Spotify에서 검색" style={{ fontSize: 10, color: "#8b92a3", padding: "3px 7px", borderRadius: 6, border: "1px solid rgba(244,241,232,.12)" }}>SPOTIFY</span>
      <span style={{ color: accent, flex: "0 0 auto" }}><PlayIcon small /></span>
    </a>
  );
}
function EnergyCurve({ accent, accent2, groups }) {
  const heights = { 1: 0.42, 2: 0.55, 3: 0.9, 4: 0.6, 5: 0.28 };
  const present = groups.map((g) => g.s);
  const ys = present.map((s) => heights[s] ?? 0.5);
  const W = 1000, H = 150, pad = 20;
  const step = present.length > 1 ? (W - pad * 2) / (present.length - 1) : 0;
  const pts = ys.map((v, i) => [pad + step * i, H - pad - v * (H - pad * 2)]);
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; const cx = (x0 + x1) / 2; d += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`; }
  return (
    <div style={{ borderRadius: 14, padding: "14px 6px 8px", background: "rgba(20,24,34,.5)", border: "1px solid rgba(244,241,232,.07)" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 96 }}>
        <defs>
          <linearGradient id="sfmgrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={accent} /><stop offset="1" stopColor={accent2} /></linearGradient>
          <linearGradient id="sfmfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={accent} stopOpacity="0.28" /><stop offset="1" stopColor={accent} stopOpacity="0" /></linearGradient>
        </defs>
        <path d={`${d} L ${pts[pts.length - 1][0]} ${H} L ${pts[0][0]} ${H} Z`} fill="url(#sfmfill)" />
        <path className="sfm-curve" d={d} fill="none" stroke="url(#sfmgrad)" strokeWidth="4" strokeLinecap="round" strokeDasharray="1400" strokeDashoffset="1400" style={{ animation: "sfm-draw 1.1s ease forwards" }} />
        {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="6" fill={accent} />)}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "0 8px" }}>
        {present.map((s) => <span key={s} className="sfm-mono" style={{ fontSize: 9.5, color: "#6b7180", flex: 1, textAlign: "center" }}>{SECTIONS[s].ko}</span>)}
      </div>
    </div>
  );
}
function PlayIcon({ small }) { const s = small ? 14 : 16; return <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>; }
function CameraIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>; }
function VideoIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="2" y="6" width="14" height="12" rx="2" /><path d="M22 8l-6 4 6 4V8z" /></svg>; }
const solidBtn = { padding: "13px 20px", borderRadius: 13, border: "none", fontSize: 15, fontWeight: 700, cursor: "pointer" };
const ghostWide = { width: "100%", boxSizing: "border-box", padding: "12px", borderRadius: 12, marginTop: 8, border: "1px solid rgba(244,241,232,.18)", background: "rgba(20,24,34,.5)", color: "#cfd3dd", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 };
