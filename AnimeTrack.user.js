// ==UserScript==
// @name         AnimeTrack
// @namespace    https://github.com/ShaharAviram1/AnimeTrack
// @description  Fast anime scrobbler for MAL: adaptive site profiles, auto-map titles, MAL OAuth (PKCE S256), auto-mark at 80%, focused Shadow-DOM UI.
// @version      1.9.0
// @author       Shahar Aviram
// @license      GPL-3.0
// @homepageURL  https://github.com/ShaharAviram1/AnimeTrack
// @supportURL   https://github.com/ShaharAviram1/AnimeTrack/issues
// @updateURL    https://anime-track-oauth.shaharaviram.workers.dev/AnimeTrack.meta.js
// @downloadURL  https://anime-track-oauth.shaharaviram.workers.dev/AnimeTrack.user.js
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @connect      myanimelist.net
// @connect      api.myanimelist.net
// @connect      shaharaviram.workers.dev
// @connect      anime-track-oauth.shaharaviram.workers.dev
// @match        *://myanimelist.net/*
// @match        *://hianime.to/*
// @match        *://hianime.tv/*
// @match        *://animetsu.bz/*
// @match        *://aniwatch.to/*
// @match        *://aniwatchtv.to/*
// @match        *://9anime.to/*
// @match        *://zoro.to/*
// @match        *://gogoanime.fi/*
// @match        *://gogoanime.dk/*
// @match        *://gogoanimehd.to/*
// @match        *://megacloud.tv/*
// @match        *://megacloud.blog/*
// @match        *://rapid-cloud.co/*
// @match        *://vidcloud.to/*
// @match        *://filemoon.sx/*
// @match        *://*/*
// ==/UserScript==

(() => {
  'use strict';
  try { console.log('[AnimeTrack] booting…', location.href); } catch { }
  // Catch hard errors early (helps Safari which may reload SPA routes on exceptions)
  try {
    window.addEventListener('error', (e) => {
      try { console.log('[AnimeTrack] window error:', e && (e.message || e.error)); } catch { }
    });
    window.addEventListener('unhandledrejection', (e) => {
      try { console.log('[AnimeTrack] unhandled rejection:', e && (e.reason && e.reason.message) || e && e.reason || e); } catch { }
    });
  } catch { }

  let DEBUG = true; // can be toggled at runtime
  const __AT_LOGS = [];
  const __AT_LOG_MAX = 500;

  function __atPushLog(args) {
    try {
      const ts = new Date().toISOString();
      const msg = Array.from(args).map(a => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
      __AT_LOGS.push(`${ts} ${msg}`);
      if (__AT_LOGS.length > __AT_LOG_MAX) {
        __AT_LOGS.splice(0, __AT_LOGS.length - __AT_LOG_MAX);
      }
    } catch { }
  }

  function dlog() {
    __atPushLog(arguments);
    if (!DEBUG) return;
    try { console.log('[AnimeTrack]', ...arguments); } catch { }
  }
  // Expose quick toggles for debugging
  try {
    window.AnimeTrackDebug = {
      on() { DEBUG = true; try { console.log('[AnimeTrack] DEBUG ON'); } catch { } },
      off() { DEBUG = false; try { console.log('[AnimeTrack] DEBUG OFF'); } catch { } },
      toggle() { DEBUG = !DEBUG; try { console.log('[AnimeTrack] DEBUG', DEBUG); } catch { } },
      logs() { return __AT_LOGS.slice(); },
      dump() { return __AT_LOGS.join('\n'); },
      clear() {
        __AT_LOGS.length = 0;
        try { console.log('[AnimeTrack] logs cleared'); } catch { }
      }
    };
  } catch { }

  // ---- GM polyfill ----
  const gm = (function () {
    const g = (typeof GM !== 'undefined' && GM) ? GM : {};
    if (typeof g.xmlHttpRequest === 'undefined' && typeof GM_xmlhttpRequest !== 'undefined') {
      g.xmlHttpRequest = GM_xmlhttpRequest;
    }
    if (typeof g.getValue !== 'function') g.getValue = async (_k, fallback = '') => fallback;
    if (typeof g.setValue !== 'function') g.setValue = async (_k, _v) => { };
    if (typeof g.registerMenuCommand !== 'function') g.registerMenuCommand = (_t, _f) => { };
    return g;
  })();

  try {
    if (gm && typeof gm.registerMenuCommand === 'function') {
      gm.registerMenuCommand('AnimeTrack: Toggle Debug', () => {
        DEBUG = !DEBUG;
        try { console.log('[AnimeTrack] DEBUG', DEBUG); } catch { }
        try { toast('Debug ' + (DEBUG ? 'ON' : 'OFF')); } catch { }
      });
    }
  } catch { }

  try {
    if (gm && typeof gm.registerMenuCommand === 'function') {
      gm.registerMenuCommand('AnimeTrack: Dump Player Snapshot', async () => {
        try {
          const vids = Array.from(document.querySelectorAll('video'));
          const frames = Array.from(document.querySelectorAll('iframe')).map(f => ({
            src: f.src || '',
            id: f.id || '',
            cls: f.className || ''
          }));

          const snap = {
            url: location.href,
            host: location.host,
            ts: new Date().toISOString(),
            videos: vids.map(v => ({
              currentTime: v.currentTime,
              duration: v.duration,
              ended: v.ended,
              paused: v.paused,
              readyState: v.readyState,
              src: v.currentSrc || v.src || '',
              hasSrc: !!(v.currentSrc || v.src),
            })),
            iframeCount: frames.length,
            iframes: frames.slice(0, 8)
          };

          await copyToClipboard(JSON.stringify(snap, null, 2));
        } catch (e) {
          toast('Snapshot failed: ' + (e && e.message || e));
        }
      });
    }
  } catch { }

  // ---- Constants ----
  let MAL_CLIENT_ID = '8cdc30a4b5c47b9aebe8372b6c5883ee';
  let MAL_REDIRECT_URI = 'https://shaharaviram1.github.io/AnimeTrack/oauth.html';
  const MAL_AUTH_URL = 'https://myanimelist.net/v1/oauth2/authorize';
  const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
  const MAL_SEARCH = 'https://api.myanimelist.net/v2/anime';
  const WORKER_URL = 'https://anime-track-oauth.shaharaviram.workers.dev';
  const STORAGE = {
    access: 'animetrack.malToken',
    refresh: 'animetrack.malRefresh',
    sites: 'animetrack.sites',
    siteProfiles: 'animetrack.siteProfiles',
    maps: 'animetrack.seriesMaps',
    seeded: 'animetrack.seeded',
    settings: 'animetrack.settings',
    pkce: 'animetrack.pkce',
    oauthErr: 'animetrack.oauthErr'
    , pkceVer: 'animetrack.pkce_ver'
    , oauthState: 'animetrack.oauthState'
    , expires: 'animetrack.expires'
    , canon: 'animetrack.franchiseCanon'
  };
  // --- Session cache & scrobble guards (A1) ---
  const SESSION = {
    statusCache: new Map(),       // malId -> {ts, data}
    scrobbleInFlight: false,
    lastMarkKey: ''               // `${malId}#${ep}`
  };
  function getCachedStatus(id, maxAgeMs = 20000) {
    const e = SESSION.statusCache.get(id);
    return (e && (Date.now() - e.ts) <= maxAgeMs) ? e.data : null;
  }
  function setCachedStatus(id, data) {
    if (data === null) { SESSION.statusCache.delete(id); return; } // bust
    SESSION.statusCache.set(id, { ts: Date.now(), data });
  }

  function getJSONSync(key, fallback) {
    try {
      if (typeof GM_getValue !== 'function') return fallback;
      const raw = GM_getValue(key, '');
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  const SEEDED_HOSTS = new Set([
    '9anime.to', 'aniwatch.to', 'aniwatchtv.to', 'animetsu.bz', 'animetsu.tv', 'gogoanime.dk', 'gogoanime.fi', 'gogoanimehd.to', 'hianime.to', 'hianime.tv', 'zoro.to'
  ]);

  // Known player/embed hosts (often cross-origin iframes). We allow running the *frame tracker* here
  // even when document.referrer is empty due to Referrer-Policy.
  const PLAYER_HOSTS = new Set([
    'megacloud.tv', 'megacloud.blog', 'rapid-cloud.co', 'vidcloud.to', 'filemoon.sx'
  ]);

  const BOOT_SITE_LIST = new Set(getJSONSync(STORAGE.sites, []).map(h => String(h || '').replace(/^www\./i, '').toLowerCase()).filter(Boolean));
  const BOOT_SITE_PROFILES = getJSONSync(STORAGE.siteProfiles, {});
  const SITE_PROFILES = Object.assign({}, BOOT_SITE_PROFILES);
  const HOST_ALLOWLIST = new Set([
    ...Array.from(SEEDED_HOSTS),
    ...Array.from(BOOT_SITE_LIST),
    ...Object.keys(BOOT_SITE_PROFILES || {}).map(h => String(h || '').replace(/^www\./i, '').toLowerCase()).filter(Boolean)
  ]);

  // ---- Execution guard for broad @match (top vs iframe) ----
  // If the userscript is configured with a wide @match (e.g. *://*/*),
  // we must *only* run on:
  // 1) top-level pages for MAL or known anime sites, OR
  // 2) iframe player pages whose `document.referrer` is one of our known anime sites.
  // Otherwise we bail out early (prevents running on random sites and breaking bubble/UI).
  const __AT_HOST = (location.hostname || '').replace(/^www\./i, '').toLowerCase();
  const __AT_IS_FRAME = (() => { try { return window.top !== window.self; } catch { return true; } })();
  const __AT_REF_HOST = (() => {
    try {
      const r = document.referrer || '';
      if (!r) return '';
      return (new URL(r)).hostname.replace(/^www\./i, '').toLowerCase();
    } catch { return ''; }
  })();
  const __AT_ALLOW_TOP = (__AT_HOST === 'myanimelist.net' || HOST_ALLOWLIST.has(__AT_HOST));
  // Allow iframe execution when embedded by a supported anime site OR when the iframe host itself is a known player host.
  // Some players set Referrer-Policy so referrer may be empty; in that case we still want the frame tracker.
  const __AT_ALLOW_FRAME = (__AT_IS_FRAME && ((!!__AT_REF_HOST && (HOST_ALLOWLIST.has(__AT_REF_HOST) || __AT_REF_HOST === 'myanimelist.net')) || PLAYER_HOSTS.has(__AT_HOST)));
  dlog('execGuard:', { host: __AT_HOST, isFrame: __AT_IS_FRAME, refHost: __AT_REF_HOST, allowTop: __AT_ALLOW_TOP, allowFrame: __AT_ALLOW_FRAME });
  if (!__AT_ALLOW_TOP && !__AT_ALLOW_FRAME) {
    try { /* keep completely quiet on unrelated sites */ } catch { }
    return;
  }

  // Soft scoring priors per franchise base (no hard MAL IDs)
  const FRANCHISE_PRIORS = {
    'one piece': { prefer: 'tv', minEpisodes: 100 },
    'detective conan': { prefer: 'tv', minEpisodes: 100 },
    'bleach': { prefer: 'tv', minEpisodes: 50 },
    'gintama': { prefer: 'tv', minEpisodes: 50 },
    'naruto': { prefer: 'tv', minEpisodes: 50 },
    'dragon ball': { prefer: 'tv', minEpisodes: 50 }
  };

  function priorFor(base) {
    if (!base) return null;
    // try exact base, then without discriminators
    return FRANCHISE_PRIORS[base] || FRANCHISE_PRIORS[baseFranchise(base)];
  }

  // ---- Utils ----
  function safeNow() { return Date.now(); }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(String(text));
      toast('Copied snapshot to clipboard ✅');
      return true;
    } catch (e) {
      // fallback: prompt
      try { prompt('Copy this:', String(text)); } catch { }
      toast('Snapshot ready (manual copy)');
      return false;
    }
  }

  const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));
  const qs = (s, r = document) => r.querySelector(s);
  const isFrame = __AT_IS_FRAME;
  function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function encodeForm(obj) { return Object.keys(obj).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`).join('&'); }
  function titleCase(s) { return (s || '').split(' ').map(w => w ? (w[0].toUpperCase() + w.slice(1)) : w).join(' '); }

  // Prefer exact title (only trim/collapse spaces) for first MAL search to avoid partial matches
  function preferExactTitle(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function _decSlug(s) { try { return decodeURIComponent(s); } catch { return s || ''; } }
  // Extract a canonical series slug from a pathname
  function extractSeriesSlugFromPath(pathname, customPrefixes) {
    dlog('extractSeriesSlugFromPath: in', pathname);
    const parts = (pathname || '').split('/').filter(Boolean);
    const prefixes = new Set((customPrefixes && customPrefixes.length ? customPrefixes : ['watch', 'anime', 'series', 'stream', 'show']).map(x => String(x || '').toLowerCase()));
    let slug = parts.length > 1 && prefixes.has((parts[0] || '').toLowerCase()) ? parts[1] : (parts[0] || '');
    slug = _decSlug(String(slug).toLowerCase());
    // strip episode tails like -episode-12, -ep-12, -e12, -season-2, -s2
    slug = slug.replace(/-(?:episode|ep|e|season|s)[-_]?\d+.*$/i, '');
    // strip trailing numeric site id like -19908 (3+ digits to avoid s2)
    slug = slug.replace(/-\d{3,}$/i, '');
    // remove common junk tokens at end
    slug = slug.replace(/-(?:1080p|720p|sub|dub|watch|full|free)$/gi, '');
    // collapse dashes and trim
    slug = slug.replace(/-+/g, '-').replace(/^-|-$/g, '');
    dlog('extractSeriesSlugFromPath: out', slug);
    return slug;
  }

  // PKCE helpers (S256)
  function b64url(buf) {
    let str = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function pkceS256(verifier) {
    const enc = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    return b64url(digest);
  }
  function randomString(len = 64) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
    let out = ''; for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  // ---- UI shell ----
  let root, shadow, bubble, panel, panelOpen = false, domObs = null;
  function ensureShell() {
    if (root || isFrame || window.top !== window.self) return;
    root = document.createElement('div');
    root.id = 'animetrack-root';
    document.documentElement.appendChild(root);
    shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .bubble, .panel, .toast { font-family: "Avenir Next", "Trebuchet MS", "Segoe UI", sans-serif; }
      .bubble {
        position: fixed;
        right: 18px;
        bottom: 18px;
        width: 46px;
        height: 46px;
        border-radius: 16px;
        background: linear-gradient(135deg, #4f8cff 0%, #2f65ff 54%, #ff8247 100%);
        color: #f8fbff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 800;
        font-size: 13px;
        letter-spacing: .08em;
        box-shadow: 0 18px 44px rgba(5, 11, 24, .45);
        cursor: pointer;
        z-index: 2147483647;
        border: 1px solid rgba(255,255,255,.22);
        backdrop-filter: blur(10px);
        transition: transform .18s ease, box-shadow .18s ease, opacity .18s ease;
      }
      .bubble:hover { transform: translateY(-2px) scale(1.02); box-shadow: 0 22px 52px rgba(5, 11, 24, .55); }
      .bubble.disabled { background: linear-gradient(135deg, #516178 0%, #394454 100%); opacity: .96; }
      .panel {
        position: fixed;
        right: 18px;
        bottom: 74px;
        z-index: 2147483647;
      }
      .card {
        width: min(420px, calc(100vw - 24px));
        max-height: min(78vh, 760px);
        overflow: auto;
        background:
          radial-gradient(circle at top right, rgba(255,130,71,.16), transparent 30%),
          radial-gradient(circle at top left, rgba(79,140,255,.18), transparent 28%),
          linear-gradient(180deg, rgba(20,28,43,.98) 0%, rgba(9,13,21,.98) 100%);
        color: #f5f8ff;
        border-radius: 24px;
        box-shadow: 0 28px 64px rgba(0,0,0,.45);
        border: 1px solid rgba(255,255,255,.08);
        padding: 18px;
        animation: at-pop .18s ease-out;
      }
      @keyframes at-pop {
        from { opacity: 0; transform: translateY(8px) scale(.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .at-shell { display: flex; flex-direction: column; gap: 14px; }
      .at-header { display:flex; align-items:flex-start; gap:12px; }
      .at-brand { display:flex; flex-direction:column; gap:4px; min-width:0; }
      .eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: rgba(206,221,255,.72); }
      .headline { font-size: 22px; line-height: 1.05; font-weight: 800; letter-spacing: -.03em; }
      .muted { font-size: 12px; color: rgba(215,226,247,.72); }
      .subtle { color: rgba(215,226,247,.58); }
      .icon-btn, button {
        border: 0;
        border-radius: 14px;
        padding: 10px 12px;
        cursor: pointer;
        font-weight: 700;
        transition: transform .14s ease, opacity .14s ease, background .14s ease, border-color .14s ease;
      }
      .icon-btn:hover, button:hover { transform: translateY(-1px); }
      .icon-btn {
        margin-left: auto;
        background: rgba(255,255,255,.06);
        color: #fff;
        min-width: 42px;
      }
      .surface {
        background: rgba(255,255,255,.05);
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 18px;
        padding: 14px;
      }
      .hero { display:flex; flex-direction:column; gap:10px; }
      .chip-row, .actions, .row, .grid-2 { display:flex; gap:10px; flex-wrap:wrap; }
      .chip {
        display:inline-flex;
        align-items:center;
        gap:6px;
        padding: 8px 10px;
        border-radius: 999px;
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.08);
        font-size: 12px;
        color: rgba(245,248,255,.92);
      }
      .metric {
        flex: 1 1 110px;
        min-width: 110px;
        background: rgba(255,255,255,.04);
        border-radius: 16px;
        padding: 12px;
        border: 1px solid rgba(255,255,255,.06);
      }
      .metric .label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.12em; color: rgba(206,221,255,.6); margin-bottom: 6px; }
      .metric .value { display:block; font-size:15px; font-weight:700; }
      .actions { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .primary {
        background: linear-gradient(135deg, #5d9bff 0%, #2f65ff 100%);
        color: #fff;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.2);
      }
      .ghost {
        background: rgba(255,255,255,.04);
        color: #f5f8ff;
        border: 1px solid rgba(255,255,255,.1);
      }
      .danger {
        background: rgba(255,93,93,.12);
        color: #ffc5c5;
        border: 1px solid rgba(255,93,93,.18);
      }
      button[disabled] { opacity: .46; cursor: not-allowed; transform: none !important; }
      .field-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:10px; }
      .field { display:flex; flex-direction:column; gap:6px; min-width:0; }
      .field label { font-size:11px; text-transform:uppercase; letter-spacing:.12em; color: rgba(206,221,255,.62); }
      input, select {
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(7,10,16,.58);
        color: #fff;
        border-radius: 12px;
        padding: 10px 11px;
        min-width: 0;
      }
      select { appearance: none; }
      .stack { display:flex; flex-direction:column; gap:10px; }
      .results {
        display:flex;
        flex-direction:column;
        gap:8px;
        max-height: 220px;
        overflow: auto;
      }
      .result {
        text-align:left;
        width:100%;
        background: rgba(255,255,255,.04);
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 14px;
        padding: 11px 12px;
        color:#fff;
      }
      .result strong { display:block; font-size:13px; margin-bottom:4px; }
      .result span { display:block; font-size:11px; color: rgba(215,226,247,.66); }
      details {
        background: rgba(255,255,255,.035);
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 16px;
        padding: 12px;
      }
      summary {
        cursor: pointer;
        list-style: none;
        font-weight: 700;
        font-size: 13px;
      }
      summary::-webkit-details-marker { display:none; }
      .section-title { font-size: 13px; font-weight: 700; }
      .toast {
        position: fixed;
        right: 18px;
        bottom: 128px;
        background: rgba(11, 16, 26, .95);
        color:#fff;
        padding:11px 13px;
        border-radius: 14px;
        box-shadow: 0 18px 38px rgba(0,0,0,.35);
        border: 1px solid rgba(255,255,255,.08);
        max-width: min(340px, calc(100vw - 28px));
      }
      .hint { font-size:11px; color: rgba(215,226,247,.6); }
      .spacer { flex:1; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      @media (max-width: 640px) {
        .panel { right: 12px; left: 12px; bottom: 68px; }
        .card { width: auto; }
        .actions, .field-grid { grid-template-columns: 1fr; }
        .bubble { right: 12px; bottom: 12px; }
        .toast { right: 12px; left: 12px; bottom: 118px; max-width: none; }
      }
    `;
    shadow.appendChild(style);

    bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = 'AT';
    bubble.title = 'AnimeTrack — click to open/close';
    bubble.addEventListener('click', () => {
      panelOpen = !panelOpen;
      panel.style.display = panelOpen ? 'block' : 'none';
      if (panelOpen) renderPanel();
    });
    shadow.appendChild(bubble);

    panel = document.createElement('div');
    panel.className = 'panel';
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'at-card';
    panel.appendChild(card);
    panel.style.display = 'none';
    shadow.appendChild(panel);

    try { console.log('[AnimeTrack] UI shell ready'); } catch { }

    // Start 80% tracker once UI exists (safe for SPA); no-op if already started
    try { startAutoTracker(); dlog('autoTracker: started'); } catch (e) { dlog('autoTracker: start failed', e && e.message || e); }

    try {
      let t = null;
      domObs = new MutationObserver(() => {
        if (t) return; // debounce to once per frame
        t = requestAnimationFrame(() => { t = null; updateBubble(); });
      });
      domObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch { }
  }
  function toast(msg) {
    if (!shadow) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    shadow.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
  function isAnimeyPage() { const p = location.pathname.toLowerCase(); return /anime|watch|episode|series|ep|stream/.test(p); }
  function isHomePage() {
    const p = (location.pathname || '/').replace(/\/+$/, '/');
    if (p === '/' || p === '/home' || p === '/index' || p === '/index.html') return true;
    if (p === '/' && location.search) return true;
    return false;
  }

  // ---- Storage helpers ----
  async function getJSON(key, fallback) { try { const raw = await gm.getValue(key, ''); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
  async function setJSON(key, val) { try { return gm.setValue(key, JSON.stringify(val)); } catch { return; } }
  async function getToken() { return (await gm.getValue(STORAGE.access, '')) || ''; }
  async function getRefresh() { return (await gm.getValue(STORAGE.refresh, '')) || ''; }
  async function getExpiry() { const v = await gm.getValue(STORAGE.expires, '0'); const n = parseInt(v, 10) || 0; return n; }
  async function getSiteProfiles() {
    const profiles = await getJSON(STORAGE.siteProfiles, {});
    for (const key of Object.keys(SITE_PROFILES)) delete SITE_PROFILES[key];
    Object.assign(SITE_PROFILES, profiles || {});
    return profiles || {};
  }
  async function setSiteProfiles(profiles) {
    const normalized = {};
    for (const [host, profile] of Object.entries(profiles || {})) {
      const key = normalizeHost(host);
      if (!key) continue;
      normalized[key] = Object.assign({}, profile || {}, { host: key });
    }
    for (const key of Object.keys(SITE_PROFILES)) delete SITE_PROFILES[key];
    Object.assign(SITE_PROFILES, normalized);
    await setJSON(STORAGE.siteProfiles, normalized);
    return normalized;
  }
  async function setTokens(access, refresh, expiresIn) {
    await gm.setValue(STORAGE.access, access || '');
    if (refresh !== undefined) await gm.setValue(STORAGE.refresh, refresh || '');
    if (typeof expiresIn === 'number') {
      const exp = Date.now() + Math.max(0, (expiresIn | 0)) * 1000 - 60000; // minus 60s buffer
      await gm.setValue(STORAGE.expires, String(exp));
    }
  }

  // ---- Network helpers ----
  function xhr(method, url, headers = {}, data = null) {
    return new Promise((resolve, reject) => {
      if (!gm.xmlHttpRequest) return reject(new Error('No GM.xmlHttpRequest'));
      gm.xmlHttpRequest({
        method, url, headers, data,
        onload: (r) => {
          const status = r.status;
          const statusText = r.statusText || '';
          const txt = r.responseText || '';
          let json = null;
          try { json = txt ? JSON.parse(txt) : null; } catch { }
          const ok = status >= 200 && status < 300;
          if (ok) {
            resolve(json ?? txt);
          } else {
            const serverMsg = (json && (json.error_description || json.message || json.error)) || txt.slice(0, 400);
            const err = new Error(`HTTP ${status} ${statusText} :: ${serverMsg}`);
            err.status = status;
            err.body = txt;
            reject(err);
          }
        },
        onerror: () => reject(new Error('Network error'))
      });
    });
  }

  // ---- Title/Episode heuristics ----
  function normalizeHost(host) {
    return String(host || '').replace(/^www\./i, '').toLowerCase();
  }

  function parseSelectorList(value, fallback = []) {
    if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
    if (typeof value !== 'string') return fallback.slice();
    return value.split(',').map(v => v.trim()).filter(Boolean);
  }

  function readNodeText(node) {
    if (!node) return '';
    const attrs = [
      node.getAttribute && node.getAttribute('content'),
      node.getAttribute && node.getAttribute('title'),
      node.getAttribute && node.getAttribute('aria-label'),
      node.getAttribute && node.getAttribute('data-title'),
      node.getAttribute && node.getAttribute('data-name'),
      node.textContent
    ].filter(Boolean);
    return norm(attrs.find(Boolean) || '');
  }

  function firstUsefulTitle(candidates) {
    for (const raw of candidates || []) {
      const cleaned = cleanTitle(raw);
      const cmp = normalizeCmp(cleaned);
      if (!cleaned || cleaned.length < 2) continue;
      if (!cmp || cmp === 'animetsu' || cmp === 'watch' || cmp === 'episode') continue;
      return cleaned;
    }
    return '';
  }

  function readTextFromSelectors(doc, selectors) {
    for (const sel of selectors || []) {
      try {
        const node = doc.querySelector(sel);
        const text = readNodeText(node);
        if (text) return text;
      } catch { }
    }
    return '';
  }

  function readEpisodeFromSelectors(doc, selectors) {
    for (const sel of selectors || []) {
      try {
        const node = doc.querySelector(sel);
        if (!node) continue;
        const attrs = [
          node.getAttribute && node.getAttribute('data-number'),
          node.getAttribute && node.getAttribute('data-ep'),
          node.getAttribute && node.getAttribute('data-episode'),
          node.getAttribute && node.getAttribute('data-current-episode'),
          node.getAttribute && node.getAttribute('aria-label'),
          node.textContent
        ].filter(Boolean);
        for (const val of attrs) {
          const m = String(val).match(/\b(\d{1,4})\b/);
          if (m) return parseInt(m[1], 10);
        }
      } catch { }
    }
    return null;
  }

  function extractNumericRouteId(pathname, prefixes = ['watch', 'anime']) {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (!parts.length) return '';
    const first = String(parts[0] || '').toLowerCase();
    if (prefixes.includes(first) && /^\d+$/.test(parts[1] || '')) return parts[1];
    return parts.find(p => /^\d+$/.test(p)) || '';
  }

  function extractPathEpisode(pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (parts.length >= 3 && /^\d+$/.test(parts[2] || '')) return parseInt(parts[2], 10);
    return null;
  }

  function readEpisodeFromLinks(doc, matcher) {
    const activeMatchers = [
      'a[aria-current="page"]',
      'a[data-selected]',
      'a[data-active]',
      '.active a',
      'a.active',
      '.current a',
      'a.current'
    ];
    for (const sel of activeMatchers) {
      for (const node of qsa(sel, doc)) {
        const href = node.getAttribute('href') || '';
        if (matcher && !matcher(href, node)) continue;
        const text = [
          node.getAttribute('data-number'),
          node.getAttribute('data-ep'),
          node.getAttribute('data-episode'),
          node.getAttribute('aria-label'),
          node.textContent
        ].filter(Boolean).join(' ');
        const m = text.match(/\b(\d{1,4})\b/);
        if (m) return parseInt(m[1], 10);
      }
    }
    return null;
  }

  function titleFromAnimeLinks(doc, animeId) {
    if (!animeId) return '';
    const links = qsa(`a[href^="/anime/${animeId}"]`, doc);
    return firstUsefulTitle(links.flatMap(node => [readNodeText(node)]));
  }

  function buildCustomProvider(profile, host) {
    const titleSelectors = parseSelectorList(profile.titleSelectors, ['h1', 'meta[property="og:title"]', 'meta[name="twitter:title"]']);
    const episodeSelectors = parseSelectorList(profile.episodeSelectors, []);
    const pathPrefixes = parseSelectorList(profile.pathPrefixes, ['watch', 'anime', 'series', 'show']);
    const mode = String(profile.mode || 'slug').toLowerCase();
    const seriesParam = String(profile.seriesQueryParam || 'id').trim() || 'id';
    const episodeParam = String(profile.episodeQueryParam || 'ep').trim() || 'ep';
    const siteLabel = String(profile.label || host || '').trim();

    return {
      key: 'custom:' + host,
      label: siteLabel,
      domains: [host],
      getSeriesKey(doc, loc, currentHost) {
        if (mode === 'path-id') {
          const id = extractNumericRouteId(loc.pathname, pathPrefixes);
          if (id) return `${currentHost}|aid-${id}`;
        }
        if (mode === 'query-id') {
          const id = new URL(loc.href).searchParams.get(seriesParam);
          if (id) return `${currentHost}|qid-${id}`;
        }
        const slug = extractSeriesSlugFromPath(loc.pathname, pathPrefixes);
        return `${currentHost}|${slug || 'unresolved'}`;
      },
      detectTitle(doc, loc) {
        const direct = firstUsefulTitle([readTextFromSelectors(doc, titleSelectors)]);
        if (direct) return direct;
        const generic = firstUsefulTitle([
          qs('meta[property="og:title"]', doc)?.content,
          qs('meta[name="twitter:title"]', doc)?.content,
          qs('h1', doc)?.textContent,
          document.title
        ]);
        if (generic) return generic;
        const fallbackSlug = extractSeriesSlugFromPath(loc.pathname, pathPrefixes);
        return fallbackSlug ? titleCase(fallbackSlug) : '';
      },
      detectEpisode(doc, loc) {
        const q = new URL(loc.href).searchParams.get(episodeParam);
        if (q && /^\d+$/.test(q)) return parseInt(q, 10);
        const fromSelectors = readEpisodeFromSelectors(doc, episodeSelectors);
        if (fromSelectors != null) return fromSelectors;
        return parseEpFromUrlString(loc.href);
      }
    };
  }

  const PROVIDERS = {
    hianime: {
      domains: ['hianime.to', 'hianime.tv', 'aniwave.to', 'aniwave.se', 'aniwatch.to', 'aniwatchtv.to'],
      detectTitle(doc, loc) {
        dlog('hianime.detectTitle: start', loc && loc.href);
        const canonical = doc.querySelector('link[rel="canonical"]')?.href
          || doc.querySelector('meta[property="og:url"]')?.content
          || doc.querySelector('meta[name="twitter:url"]')?.content
          || '';
        if (canonical) {
          try {
            const u = new URL(canonical);
            const parts = u.pathname.split('/').filter(Boolean);
            let slug = parts.includes('watch') ? parts[parts.indexOf('watch') + 1] : parts[0];
            if (slug) {
              slug = slug
                .replace(/-episode-?\d+.*/i, '')
                .replace(/-ep-?\d+.*/i, '')
                .replace(/-s(?:eason)?-?\d+$/i, '')
                .replace(/-\d{3,}$/i, '')
                .replace(/[-_]+/g, ' ')
                .trim();
              if (slug) return titleCase(slug);
            }
          } catch { }
        }

        try {
          const nodes = doc.querySelectorAll('script[type="application/ld+json"]');
          for (const n of nodes) {
            const data = JSON.parse(n.textContent || 'null');
            const arr = Array.isArray(data) ? data : [data];
            for (const obj of arr) {
              const nm = obj?.name || obj?.headline || obj?.['@name'] || obj?.alternateName;
              if (nm && String(nm).trim().length > 1) return cleanTitle(nm);
            }
          }
        } catch { }

        return firstUsefulTitle([
          doc.querySelector('.film-name a')?.textContent,
          doc.querySelector('.film-name')?.textContent,
          doc.querySelector('.anisc-detail .name')?.textContent,
          doc.querySelector('.dynamic-name')?.textContent,
          doc.querySelector('h1')?.textContent,
          doc.querySelector('meta[property="og:title"]')?.content,
          doc.querySelector('meta[name="twitter:title"]')?.content
        ]) || '';
      },

      detectEpisode(doc, loc) {
        const currentEpFromURL = (() => {
          const m = loc.href.match(/[?&]ep=([0-9]+)/i);
          return m ? m[1] : null;
        })();

        const activeSelectors = [
          '.ep-item.active',
          '.ep-item a.active',
          '.list-episode a.active',
          '.ss-list a.active',
          '.episodes-list .ep-item.active',
          '.ss-list .ep-item.active',
          'a.ep-item.active',
          '.detail-infor-content a.active'
        ];
        const active = readEpisodeFromSelectors(doc, activeSelectors);
        if (active != null) return active;

        if (currentEpFromURL) {
          const link = [...doc.querySelectorAll('.ep-item a, a.ep-item, a')].find(a =>
            a.href.includes(`ep=${currentEpFromURL}`) ||
            a.getAttribute('data-id') === currentEpFromURL
          );
          if (link) {
            const num = link.getAttribute('data-number') ||
              link.getAttribute('data-ep') ||
              link.textContent.match(/\d+/)?.[0];
            if (num) return parseInt(num, 10);
          }
        }

        const nums = [...doc.querySelectorAll('.ep-item, .ep-item a, .list-episode a')]
          .map(x => {
            const v = x.getAttribute('data-number') ||
              x.getAttribute('data-ep') ||
              x.textContent;
            const m = v?.match(/\d+/);
            return m ? parseInt(m[0], 10) : null;
          })
          .filter(Boolean);
        return nums.length ? Math.max(...nums) : null;
      }
    },

    animetsu: {
      domains: ['animetsu.bz', 'animetsu.tv'],
      getSeriesKey(doc, loc, host) {
        const animeId = extractNumericRouteId(loc.pathname, ['watch', 'anime']);
        if (animeId) return `${host}|aid-${animeId}`;
        return `${host}|${extractSeriesSlugFromPath(loc.pathname) || 'unresolved'}`;
      },
      detectTitle(doc, loc) {
        const animeId = extractNumericRouteId(loc.pathname, ['watch', 'anime']);
        return firstUsefulTitle([
          titleFromAnimeLinks(doc, animeId),
          readTextFromSelectors(doc, [
            'h1',
            'main h1',
            '[aria-current="page"][title]',
            '[class*="title"]',
            '[class*="name"]',
            '[data-title]',
            'meta[property="og:title"]',
            'meta[name="twitter:title"]'
          ]),
          qs('meta[property="og:title"]', doc)?.content,
          qs('meta[name="twitter:title"]', doc)?.content,
          (document.title || '').replace(/\s*[-|]\s*Animetsu.*$/i, '')
        ]) || '';
      },
      detectEpisode(doc, loc) {
        const url = new URL(loc.href);
        const fromQuery = url.searchParams.get('ep');
        if (fromQuery && /^\d+$/.test(fromQuery)) return parseInt(fromQuery, 10);

        const fromPath = extractPathEpisode(loc.pathname);
        if (fromPath != null) return fromPath;

        const animeId = extractNumericRouteId(loc.pathname, ['watch', 'anime']);
        const fromActive = readEpisodeFromSelectors(doc, [
          '[aria-current="page"]',
          '[data-active]',
          '[data-selected]',
          '.active',
          '.current',
          '[class*="episode"][class*="active"]'
        ]);
        if (fromActive != null) return fromActive;

        const fromLinks = readEpisodeFromLinks(doc, (href) => {
          if (!href) return false;
          return href.includes(`/watch/${animeId}`) || href.includes(`ep=${fromQuery || ''}`);
        });
        if (fromLinks != null) return fromLinks;

        return parseEpFromUrlString(loc.href);
      }
    }
  };

  function getProviderForHost(host) {
    host = normalizeHost(host);
    for (const key in PROVIDERS) {
      if (PROVIDERS[key].domains.includes(host)) return PROVIDERS[key];
    }
    const profile = SITE_PROFILES[host];
    return profile ? buildCustomProvider(profile, host) : null;
  }
  function cleanTitle(t) {
    t = norm(t);
    if (!t) return t;
    t = t.replace(/^watch\s+/i, '');
    t = t.replace(/\b(episode|ep)\s*\d+\b/ig, '');
    t = t.replace(/\[[^\]]*\]/g, '').replace(/\([^\)]*\)/g, '');
    t = t.replace(/-\s*(watch\s*online|anime|official site).*$/i, '');
    // Strip common stream-site suffixes
    t = t.replace(/\b(?:sub|dub|dual audio)\b/ig, '');
    t = t.replace(/\b(?:uncensored|censored|blu[-\s]?ray|bd|web[-\s]?dl|1080p|720p|480p)\b/ig, '');
    // Remove trailing year tokens like (2024) or - 2024
    t = t.replace(/\(?\b(19|20)\d{2}\b\)?$/, '');
    // Normalize Part/Cour phrases for comparison (do not delete numbers here)
    t = t.replace(/\bpart\s*(\d{1,2})\b/ig, 'season $1');
    t = t.replace(/\bcour\s*(\d{1,2})\b/ig, 'season $1');
    t = t.replace(/\s{2,}/g, ' ');
    return t.trim();
  }
  // --- MAL-Sync-inspired title normalization helpers ---
  function normalizeCmp(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')     // strip diacritics
      .replace(/[^a-z0-9]+/g, ' ')         // collapse non-alnum
      .replace(/\b0+(\d+)\b/g, '$1')        // normalize leading-zero numbers ("01" -> "1")
      .replace(/\b(tv|anime|official site)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function romanToInt(roman) {
    if (!roman) return null;
    const map = { M: 1000, CM: 900, D: 500, CD: 400, C: 100, XC: 90, L: 50, XL: 40, X: 10, IX: 9, V: 5, IV: 4, I: 1 };
    let i = 0, n = 0, s = roman.toUpperCase();
    while (i < s.length) {
      if (i + 1 < s.length && map[s.slice(i, i + 2)]) { n += map[s.slice(i, i + 2)]; i += 2; }
      else { const v = map[s[i]]; if (!v) return null; n += v; i++; }
    }
    return n || null;
  }
  function intToRoman(num) {
    if (!num || num < 1) return '';
    const vals = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = ''; for (const [v, sym] of vals) { while (num >= v) { out += sym; num -= v; } } return out;
  }
  function detectSeasonNumber(s) {
    if (!s) return null;
    const t = s.toLowerCase();
    let m = t.match(/\bseason\s*(\d{1,2})\b/); if (m) return parseInt(m[1], 10);
    m = t.match(/\bs\s*(\d{1,2})\b/); if (m) return parseInt(m[1], 10);
    m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*season\b/); if (m) return parseInt(m[1], 10);
    // roman numerals
    m = t.match(/\bseason\s*([ivxlcdm]+)\b/i); if (m) { const n = romanToInt(m[1]); if (n) return n; }
    m = t.match(/\b([ivxlcdm]+)\s*season\b/i); if (m) { const n = romanToInt(m[1]); if (n) return n; }
    // part/cour synonyms
    m = t.match(/\bpart\s*(\d{1,2})\b/); if (m) return parseInt(m[1], 10);
    m = t.match(/\bcour\s*(\d{1,2})\b/); if (m) return parseInt(m[1], 10);
    // phrases like "final season" cannot map to a number reliably → return null
    return null;
  }
  function stripSeasonPhrases(s) {
    if (!s) return s;
    return s
      .replace(/\b(\d{1,2})(?:st|nd|rd|th)\s*season\b/ig, '')
      .replace(/\bseason\s*[ivxlcdm]+\b/ig, '')
      .replace(/\b[ivxlcdm]+\s*season\b/ig, '')
      .replace(/\bseason\s*\d{1,2}\b/ig, '')
      .replace(/\bs\s*\d{1,2}\b/ig, '')
      .replace(/\s{2,}/g, ' ').trim();
  }
  function detectMovieIndexFromGuess(s) {
    if (!s) return null;
    const m = String(s).toLowerCase().match(/\b(?:movie|film)\s*(\d{1,2})\b/);
    return m ? parseInt(m[1], 10) : null;
  }
  function candidateMovieIndexFromTitles(node) {
    try {
      const arr = titlesOf(node) || [];
      for (const t of arr) {
        const m = String(t).toLowerCase().match(/\b(?:movie|film)\s*(\d{1,2})\b/);
        if (m) return parseInt(m[1], 10);
      }
    } catch { }
    return null;
  }
  function seasonVariants(base) {
    const out = new Set();
    const b = cleanTitle(base);
    const n = detectSeasonNumber(b);
    const core = stripSeasonPhrases(b);
    out.add(b);
    out.add(core);
    if (n) {
      const ord = (n % 10 === 1 && n % 100 !== 11) ? 'st' : (n % 10 === 2 && n % 100 !== 12) ? 'nd' : (n % 10 === 3 && n % 100 !== 13) ? 'rd' : 'th';
      out.add(`${core} Season ${n}`);
      out.add(`${core} ${n}${ord} Season`);
      out.add(`${core} ${intToRoman(n)}`);
      out.add(`${core} Season ${intToRoman(n)}`);
      out.add(`${core} S${n}`);
    }
    return Array.from(out).filter(x => x && x.length > 1);
  }
  function baseFranchise(title) {
    // Normalize to a “core” franchise key: strip years, season/cour/part markers, ep numbers, punctuation
    let s = (title || '').toLowerCase();
    s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/\b(tv|anime|official site)\b/g, '');
    s = s.replace(/\b(episode|ep|e)\s*\d+\b/g, '');
    s = s.replace(/\bpart\s*\d+\b/g, '');
    s = s.replace(/\bcour\s*\d+\b/g, '');
    s = s.replace(/\bseason\s*\d+\b/g, '');
    s = s.replace(/\bs\s*\d+\b/g, '');
    s = s.replace(/\b(19|20)\d{2}\b/g, '');
    s = s.replace(/[-_]+/g, ' ');
    s = s.replace(/[^a-z0-9 ]+/g, ' ');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s;
  }

  // Tokens that distinguish sub-series within a franchise (don't collapse away)
  const FRANCHISE_DISCRIM_TOKENS = [
    'z', 'kai', 'shippuden', 'brotherhood', 'super', 'final season',
    '64', '2011', 'remake', 'kings arc', 'part 2', 'part 3'
  ];

  function baseFranchiseWithDiscriminators(title) {
    // Start from the existing base
    const core = baseFranchise(title);
    if (!core) return core;

    // Build a normalized token string to search
    const norm = normalizeCmp(title);

    // Collect discriminator tokens present in the title (in stable order, no dups)
    const seen = new Set();
    const picks = [];
    for (const tok of FRANCHISE_DISCRIM_TOKENS) {
      const t = normalizeCmp(tok);
      // require full token boundary match
      const re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\b', 'i');
      if (re.test(norm) && !seen.has(t)) { seen.add(t); picks.push(tok.toLowerCase()); }
    }

    if (!picks.length) return core;

    // Attach discriminators to core; keep short and stable
    return (core + ' ' + picks.join(' ')).trim();
  }

  async function getCanonMap() {
    try { const raw = await gm.getValue(STORAGE.canon, ''); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  }
  async function setCanonMap(m) {
    try { await gm.setValue(STORAGE.canon, JSON.stringify(m || {})); } catch { }
  }
  async function rememberCanon(franchiseBase, malId, malTitle) {
    if (!franchiseBase || !malId) return;
    const m = await getCanonMap();
    // only set if empty or confirming same id; avoid flapping
    if (!m[franchiseBase] || m[franchiseBase] === malId) {
      m[franchiseBase] = malId;
      await setCanonMap(m);
      dlog('canon remember:', franchiseBase, '→', malId, malTitle || '');
    }
  }

  function titlesOf(node) {
    const alts = [];
    if (!node) return alts;
    if (node.title) alts.push(node.title);
    const at = node.alternative_titles || {};
    ['en', 'en_jp', 'ja', 'ja_jp', 'synonyms'].forEach(k => {
      const v = at[k];
      if (Array.isArray(v)) v.forEach(x => alts.push(x));
      else if (typeof v === 'string') alts.push(v);
    });
    return alts.filter(Boolean);
  }
  function fromOgUrlSlug() {
    try {
      const u = qs('meta[property="og:url"]')?.content || qs('meta[name="twitter:url"]')?.content;
      if (!u) return null;
      const url = new URL(u);
      const parts = url.pathname.split('/').filter(Boolean);
      let slug = parts[1] || parts[0] || '';
      const prefixes = new Set(['watch', 'anime', 'series', 'stream', 'show']);
      if (slug && prefixes.has((parts[0] || '').toLowerCase()) && parts[1]) slug = parts[1];
      slug = slug.replace(/-episode-?\d+.*$/i, '').replace(/-ep-?\d+.*$/i, '').replace(/-\d+$/i, '');
      return slug.replace(/[-_]+/g, ' ').trim();
    } catch { return null; }
  }
  function slugToTitle(slug) {
    if (!slug) return '';
    slug = slug.replace(/-episode-?\d+.*$/i, '').replace(/-ep-?\d+.*$/i, '').replace(/-\d+$/i, '');
    let s = slug.replace(/[-_]+/g, ' ').trim();
    return titleCase(s);
  }
  function parseJSONLDName() {
    try {
      const nodes = qsa('script[type="application/ld+json"]');
      for (const n of nodes) {
        const txt = n.textContent || '';
        if (!txt) continue;
        const data = JSON.parse(txt);
        const arr = Array.isArray(data) ? data : [data];
        for (const obj of arr) {
          const name = obj?.name || obj?.headline || (obj?.itemListElement && obj.itemListElement[0]?.name);
          if (typeof name === 'string' && name.trim().length > 1) return cleanTitle(name);
        }
      }
    } catch { }
    return null;
  }
  function guessTitle() {
    dlog('guessTitle: start');
    const provider = getProviderForHost(location.hostname);
    if (provider && provider.detectTitle) {
      const t = provider.detectTitle(document, location);
      if (t && t.trim().length > 1) {
        dlog('guessTitle: provider returned →', t);
        return preferExactTitle(t);
      }
    }

    if (document.title && document.title.trim().length > 1) {
      const dt = firstUsefulTitle([document.title]);
      if (dt) { dlog('guessTitle: exact document.title →', dt); return dt; }
    }

    const ogSlug = fromOgUrlSlug();
    if (ogSlug) { dlog('guessTitle: ogSlug →', ogSlug); return titleCase(ogSlug); }
    const ld = parseJSONLDName();
    if (ld) { dlog('guessTitle: JSON-LD →', ld); return ld; }

    const cand = firstUsefulTitle([
      qs('.film-name')?.textContent,
      qs('.anisc-detail .name')?.textContent,
      qs('.dynamic-name')?.textContent,
      qs('[data-name]')?.getAttribute('data-name'),
      qs('meta[property="og:title"]')?.content,
      qs('meta[name="og:title"]')?.content,
      qs('meta[name="twitter:title"]')?.content,
      qs('meta[itemprop="name"]')?.content,
      qs('h1')?.textContent,
      qs('header h1')?.textContent,
      qs('.title')?.textContent,
      document.title
    ]);

    if (cand) return cand;

    const parts = location.pathname.split('/').filter(Boolean);
    const prefixes = new Set(['watch', 'anime', 'series', 'stream', 'show']);
    let slug = parts[0] || '';
    if (slug && prefixes.has(slug.toLowerCase()) && parts[1]) slug = parts[1];
    // Expand short season markers in slug (e.g., "-s2" -> "Season 2")
    if (/\bs\d{1,2}\b/i.test(slug)) {
      const sn = parseInt(slug.match(/\bs(\d{1,2})\b/i)[1], 10);
      const base = slug.replace(/\bs\d{1,2}\b/i, '').replace(/-+/g, ' ').trim();
      dlog('guessTitle: path slug →', `${base} Season ${sn}`);
      return titleCase(`${base} Season ${sn}`);
    }
    dlog('guessTitle: path slug →', slug);
    return slugToTitle(slug);
  }

  function parseEpFromUrlString(s) {
    if (!s) return null;
    let m = s.match(/[?&#](?:ep|episode)=([0-9]+)/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/(?:^|\/)(?:ep|episode|e)[-_]?(\d{1,4})(?:[^0-9]|$)/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/\/(\d{1,4})(?:[^0-9]|$)/);
    if (m) return parseInt(m[1], 10);
    return null;
  }
  function guessEpisode() {
    const provider = getProviderForHost(location.hostname);
    if (provider && provider.detectEpisode) {
      const ep = provider.detectEpisode(document, location);
      if (ep != null) return ep;
    }

    // fallback: old logic
    return parseEpFromUrlString(location.href) ||
      parseEpFromUrlString(qs('meta[property="og:url"]')?.content || '') ||
      null;
  }

  // ---- MAL API wrappers ----
  async function ensureFreshToken() {
    const access = await getToken();
    const exp = await getExpiry();
    if (access && exp && Date.now() < exp) return access;
    const refresh = await getRefresh();
    if (!refresh) throw new Error('Not authenticated');
    const payload = { refresh_token: refresh };
    const res = await xhr('POST', `${WORKER_URL}/refresh`, { 'Content-Type': 'application/json' }, JSON.stringify(payload));
    if (!res || !res.access_token) throw new Error('Refresh failed');
    await setTokens(res.access_token, res.refresh_token || '', res.expires_in);
    return res.access_token;
  }
  async function malSearch(query) {
    const url = MAL_SEARCH + '?q=' + encodeURIComponent(query)
      + '&limit=50&nsfw=true&fields='
      + encodeURIComponent('id,title,alternative_titles,media_type,num_episodes,start_date,end_date');
    try {
      const res = await new Promise((resolve) => {
        gm.xmlHttpRequest({
          method: 'GET',
          url,
          headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID },
          onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { resolve(null); } },
          onerror: () => resolve(null)
        });
      });
      return res;
    } catch { return null; }
  }
  // Helper: unique-by-id merge of MAL candidates (handles {node:{id,...}} or {id,...})
  function _uniqById(arr) {
    const seen = new Set(); const out = [];
    for (const x of arr || []) {
      const n = x && (x.node || x);
      if (!n || !n.id) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id); out.push(x);
    }
    return out;
  }

  // Helper: produce a zero-padded movie/film index variant (e.g., "Movie 1" -> "Movie 01")
  function withZeroPaddedMovieIndex(title) {
    if (!title) return null;
    const m = String(title).match(/\b(movie|film)\s*(\d{1,2})\b/i);
    if (!m) return null;
    const idx = parseInt(m[2], 10);
    if (!(idx >= 1 && idx <= 9)) return null; // only pad 1..9
    const padded = m[1] + ' ' + ('0' + idx); // keep original keyword casing
    // replace only the matched portion
    return title.slice(0, m.index) + padded + title.slice(m.index + m[0].length);
  }

  // Build recall-friendly variants for MAL search (to cope with long streaming slugs)
  function buildSearchVariants(guess) {
    const variants = [];
    const exact = preferExactTitle(guess);
    variants.push(exact);

    // #1 core (strip season/part/cour, years)
    const core = stripSeasonPhrases(cleanTitle(exact));
    if (core && core !== exact) variants.push(core);

    // #2 drop after colon/dash/comma (marketing tails) — progressively shorter
    const cuts = [':', '—', '-', '–', ','].map(sep => exact.split(sep)[0].trim()).filter(Boolean);
    for (const c of cuts) if (c.length >= 6 && !variants.includes(c)) variants.push(c);

    // #3 keep strong tokens only (words >= 3 chars or digits), limit to first 6–9 tokens
    const toks = normalizeCmp(exact).split(' ').filter(t => t.length >= 3 || /^\d+$/.test(t));
    if (toks.length >= 3) {
      const compact6 = toks.slice(0, 6).join(' ');
      const compact9 = toks.slice(0, 9).join(' ');
      if (!variants.includes(compact6)) variants.push(compact6);
      if (!variants.includes(compact9)) variants.push(compact9);
    }

    // #4 zero-padded movie index variant (e.g., "Movie 1" -> "Movie 01")
    const zp = withZeroPaddedMovieIndex(exact);
    if (zp && !variants.includes(zp)) variants.push(zp);

    // De-dup and keep meaningful
    return Array.from(new Set(variants)).filter(v => v && v.length >= 3);
  }

  // Robust search: try variants, handle 429/5xx with short backoff, merge results
  async function malSearchMulti(guess) {
    const queries = buildSearchVariants(guess);
    let merged = [];
    for (const q of queries) {
      const url = MAL_SEARCH + '?q=' + encodeURIComponent(q)
        + '&limit=50&nsfw=true&fields='
        + encodeURIComponent('id,title,alternative_titles,media_type,num_episodes,start_date,end_date');

      const res = await new Promise((resolve) => {
        gm.xmlHttpRequest({
          method: 'GET',
          url,
          headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID },
          onload: (r) => {
            try {
              // Basic backoff on 429/5xx
              if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
                setTimeout(() => resolve({ data: [] }), 400);
                return;
              }
              resolve(JSON.parse(r.responseText || '{"data":[]}'));
            } catch { resolve({ data: [] }); }
          },
          onerror: () => resolve({ data: [] })
        });
      });

      const data = (res && res.data) || [];
      dlog('malSearchMulti: q=', q, '→', data.length);
      merged = _uniqById(merged.concat(data));

      // Early success: plenty of candidates
      if (merged.length >= 30) break;
    }
    return merged;
  }
  async function updateMyListEpisodes(malAnimeId, watchedEp) {
    const token = await ensureFreshToken();
    const url = `https://api.myanimelist.net/v2/anime/${encodeURIComponent(malAnimeId)}/my_list_status`;
    const body = encodeForm({ num_watched_episodes: watchedEp });
    const res = await xhr('PATCH', url, { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    return res;
  }
  async function getMyListStatus(malAnimeId) {
    const cached = getCachedStatus(malAnimeId);
    if (cached) return cached;
    const token = await ensureFreshToken();
    const base = `https://api.myanimelist.net/v2/anime/${encodeURIComponent(malAnimeId)}`;

    const gmGet = (url, headers) => new Promise((resolve) => {
      gm.xmlHttpRequest({
        method: 'GET',
        url,
        headers,
        onload: (r) => {
          let body = null;
          try { body = r.responseText ? JSON.parse(r.responseText) : null; } catch { }
          resolve({ status: r.status, body });
        },
        onerror: () => resolve({ status: 0, body: null })
      });
    });

    // Try 1: dedicated my_list_status endpoint with Bearer
    let resp = await gmGet(`${base}/my_list_status`, { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    if (resp.body && (resp.body.status || typeof resp.body.num_watched_episodes === 'number' || typeof resp.body.num_episodes_watched === 'number')) {
      if (typeof resp.body.num_watched_episodes !== 'number' && typeof resp.body.num_episodes_watched === 'number') {
        resp.body.num_watched_episodes = resp.body.num_episodes_watched;
      }
      setCachedStatus(malAnimeId, resp.body);
      return resp.body;
    }

    // Try 2: same endpoint but add X-MAL-CLIENT-ID as a nudge
    if (!resp.body || !(resp.body.status || typeof resp.body.num_watched_episodes === 'number')) {
      resp = await gmGet(`${base}/my_list_status`, { 'Authorization': `Bearer ${token}`, 'X-MAL-CLIENT-ID': MAL_CLIENT_ID, 'Accept': 'application/json' });
      if (resp.body && (resp.body.status || typeof resp.body.num_watched_episodes === 'number' || typeof resp.body.num_episodes_watched === 'number')) {
        if (typeof resp.body.num_watched_episodes !== 'number' && typeof resp.body.num_episodes_watched === 'number') {
          resp.body.num_watched_episodes = resp.body.num_episodes_watched;
        }
        setCachedStatus(malAnimeId, resp.body);
        return resp.body;
      }
    }

    // Try 3: fetch the anime with fields=my_list_status and extract
    resp = await gmGet(`${base}?fields=my_list_status`, { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    if (resp.body && resp.body.my_list_status) {
      const st = resp.body.my_list_status;
      if (typeof st.num_watched_episodes !== 'number' && typeof st.num_episodes_watched === 'number') {
        st.num_watched_episodes = st.num_episodes_watched;
      }
      setCachedStatus(malAnimeId, st);
      return st;
    }

    // Not in list or unavailable
    dlog('getMyListStatus: no list status available; maybe not in list yet');
    return null;
  }
  async function setMyStatusWatching(malAnimeId) {
    const token = await ensureFreshToken();
    const url = `https://api.myanimelist.net/v2/anime/${encodeURIComponent(malAnimeId)}/my_list_status`;
    const body = encodeForm({ status: 'watching' });
    const res = await xhr('PATCH', url, { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    return res;
  }

  async function getAnimeDetails(malAnimeId) {
    const token = await ensureFreshToken();
    const url = `https://api.myanimelist.net/v2/anime/${encodeURIComponent(malAnimeId)}?fields=num_episodes,media_type,title`;
    const resp = await new Promise((resolve) => {
      gm.xmlHttpRequest({
        method: 'GET',
        url,
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        onload: (r) => {
          let body = null;
          try { body = r.responseText ? JSON.parse(r.responseText) : null; } catch { }
          resolve({ status: r.status, body });
        },
        onerror: () => resolve({ status: 0, body: null })
      });
    });
    return resp.body || null;
  }

  async function setMyStatusCompletedIfFinished(malAnimeId, watchedEp) {
    try {
      const info = await getAnimeDetails(malAnimeId);
      const total = info && typeof info.num_episodes === 'number' ? info.num_episodes : 0;
      if (total > 0 && watchedEp >= total) {
        const token = await ensureFreshToken();
        const url = `https://api.myanimelist.net/v2/anime/${encodeURIComponent(malAnimeId)}/my_list_status`;
        const body = encodeForm({ status: 'completed' });
        await xhr('PATCH', url, { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
        setCachedStatus(malAnimeId, null);
        toast('Series completed ✅');
        try { window.dispatchEvent(new CustomEvent('at:status-changed', { detail: { malId: malAnimeId } })); } catch (_) { }
      }
    } catch (e) {
      dlog('setMyStatusCompletedIfFinished: skipped', e && e.message);
    }
  }

  async function startRewatch(malAnimeId) {
    const token = await ensureFreshToken();
    const url = `https://api.myanimelist.net/v2/anime/${encodeURIComponent(malAnimeId)}/my_list_status`;
    const body = encodeForm({ status: 'watching', is_rewatching: 'true', num_watched_episodes: 0 });
    const res = await xhr('PATCH', url, { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    setCachedStatus(malAnimeId, null);
    return res;
  }

  // ---- Site list & mapping ----
  async function seedSitesOnce() {
    try {
      const already = await gm.getValue(STORAGE.seeded, '');
      if (already) return;
      const set = new Set(await getJSON(STORAGE.sites, []));
      for (const h of SEEDED_HOSTS) set.add(h);
      await setJSON(STORAGE.sites, Array.from(set));
      await gm.setValue(STORAGE.seeded, '1');
    } catch { }
  }
  async function ensureHostInSites(host) {
    try {
      host = normalizeHost(host);
      if (!host) return;
      const set = new Set(await getJSON(STORAGE.sites, []));
      if ((SEEDED_HOSTS.has(host) || SITE_PROFILES[host]) && !set.has(host)) {
        set.add(host);
        await setJSON(STORAGE.sites, Array.from(set));
      }
    } catch { }
  }
  async function isSiteEnabled(host) {
    try {
      host = normalizeHost(host);
      const set = new Set((await getJSON(STORAGE.sites, [])).map(normalizeHost));
      return set.has(host) || !!SITE_PROFILES[host];
    }
    catch { return false; }
  }
  async function addSite(host) {
    try {
      host = normalizeHost(host);
      if (!host) return;
      const set = new Set((await getJSON(STORAGE.sites, [])).map(normalizeHost));
      set.add(host);
      await setJSON(STORAGE.sites, Array.from(set));
      await updateBubble();
    } catch { }
  }
  async function removeSite(host) {
    try {
      host = normalizeHost(host);
      const set = new Set((await getJSON(STORAGE.sites, [])).map(normalizeHost));
      set.delete(host);
      await setJSON(STORAGE.sites, Array.from(set));
    } catch { }
  }
  async function saveSiteProfile(host, profile) {
    host = normalizeHost(host);
    if (!host) throw new Error('Host is required');
    const profiles = await getSiteProfiles();
    profiles[host] = Object.assign({}, profiles[host] || {}, profile || {}, { host });
    await setSiteProfiles(profiles);
    await addSite(host);
    return profiles[host];
  }
  async function deleteSiteProfile(host) {
    host = normalizeHost(host);
    if (!host) return;
    const profiles = await getSiteProfiles();
    delete profiles[host];
    await setSiteProfiles(profiles);
    await removeSite(host);
  }

  async function getMap(key) {
    try {
      const m = await getJSON(STORAGE.maps, {});
      const v = m[key];
      if (!v) return null;
      if (typeof v === 'number') return { id: v, title: '' };
      return v;
    } catch { return null; }
  }
  async function setMap(key, malId, malTitle) {
    try {
      const m = await getJSON(STORAGE.maps, {});
      m[key] = { id: malId, title: malTitle || '' };
      await setJSON(STORAGE.maps, m);
      toast(`Mapped → ${malTitle || ('#' + malId)}`);
      await renderPanel();
    } catch { }
  }

  function getSeriesKey() {
    const host = normalizeHost(location.host);
    dlog('getSeriesKey: start host=', host);
    if (isHomePage()) { dlog('getSeriesKey: homepage → unresolved'); return host + '|unresolved'; }
    const provider = getProviderForHost(host);
    if (provider && typeof provider.getSeriesKey === 'function') {
      const providerKey = provider.getSeriesKey(document, location, host);
      if (providerKey) {
        dlog('getSeriesKey: provider key =', providerKey);
        return providerKey;
      }
    }
    // 1) Prefer canonical from og:url if available
    const og = (function () { try { return qs('meta[property="og:url"]')?.content || qs('meta[name="twitter:url"]')?.content; } catch { return ''; } })();
    dlog('getSeriesKey: og url =', og);
    let slug = '';
    if (og) {
      try {
        const u = new URL(og);
        slug = extractSeriesSlugFromPath(u.pathname);
        dlog('getSeriesKey: slug from og =', slug);
      } catch { }
    }
    // 2) Fallback to current path
    if (!slug) {
      dlog('getSeriesKey: slug from path (pre) =', location.pathname);
      slug = extractSeriesSlugFromPath(location.pathname);
      dlog('getSeriesKey: slug from path =', slug);
    }

    // Fallback: if slug still empty, build from guessed title
    if (!slug) {
      dlog('getSeriesKey: slug empty, using guessTitle fallback');
      const t = (typeof guessTitle === 'function') ? guessTitle() : '';
      if (t) {
        slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      }
      dlog('getSeriesKey: slug after title fallback =', slug);
    }

    // 3) Provider-specific tail cleanup (e.g., HiAnime numeric tails)
    if (provider) slug = slug.replace(/-\d{3,}$/, '');

    // 4) Final normalization
    slug = (slug || '').toLowerCase();
    if (!slug) slug = 'unresolved';
    dlog('getSeriesKey: final key =', host + '|' + slug);
    return host + '|' + slug;
  }
  function pickBestMatch(data, guess) {
    if (!data || !data.length) return null;
    const gRaw = guess || '';
    const gNorm = normalizeCmp(gRaw);

    function score(node) {
      const all = titlesOf(node);
      if (!all.length) return -1;
      let best = -1;
      const gTokens = new Set(normalizeCmp(gRaw).split(' ').filter(Boolean));
      for (const t of all) {
        const n = normalizeCmp(t);
        if (!n) continue;

        // --- Exact equality: decisive ---
        if (n === gNorm) return 150; // exact normalized title/alt-title wins decisively

        // --- Mutual containment (no single-word wins): require length and token count ---
        const nTokArr = n.split(' ').filter(Boolean);
        const gTokArr = Array.from(gTokens);
        const nHasWords = nTokArr.length >= 2;
        const gHasWords = gTokArr.length >= 2;
        const longEnough = (n.length >= 10 || gNorm.length >= 10);

        // Containment either way (e.g., MAL alt is short, slug is long; or vice versa)
        if (longEnough && nHasWords && gHasWords && (gNorm.includes(n) || n.includes(gNorm))) {
          // Strength by shorter string length to prefer more specific titles
          const shorter = Math.min(n.length, gNorm.length);
          return shorter >= 14 ? 138 : 130;
        }

        // --- Token overlap: require real agreement (≥2 shared tokens and ≥0.5 ratio) ---
        let s = -1;
        const nTokens = new Set(nTokArr);
        let inter = 0; for (const tok of gTokens) if (nTokens.has(tok)) inter++;
        const overlap = inter / Math.max(1, Math.min(gTokens.size, nTokens.size));
        if (inter >= 2 && overlap >= 0.5) {
          s = Math.floor(overlap * 100) - 5; // scale by overlap; discourage weak partials
        }
        // Generic media-type and length preferences (franchise-agnostic)
        if (s >= 0) {
          // If the guess indicates a MOVIE (e.g., "... movie 1"), invert the usual TV bias
          const wantedMovieIdx = detectMovieIndexFromGuess(gRaw);
          const movieWanted = /\b(movie|film)\b/i.test(gRaw) || (wantedMovieIdx != null);

          if (movieWanted) {
            if (node.media_type === 'movie') s += 28; else s -= 22;
          } else {
            // Default (series-first) bias
            if (node.media_type === 'tv') s += 14;
            else if (node.media_type === 'ona') s += 3;
            else if (node.media_type === 'ova' || node.media_type === 'special' || node.media_type === 'movie') s -= 35;
          }

          // Length bias (still useful to separate TV core vs shorts)
          if (typeof node.num_episodes === 'number') {
            if (node.num_episodes >= 100) s += 30;
            else if (node.num_episodes >= 50) s += 15;
            else if (!movieWanted) { // avoid penalizing single-episode movies
              if (node.num_episodes <= 20) s -= 15;
              else if (node.num_episodes <= 5) s -= 25;
            }
          }

          // Franchise base with discriminators for both guess and candidate titles
          const gBase = baseFranchiseWithDiscriminators(gRaw);
          if (gBase) {
            const candBases = titlesOf(node).map(baseFranchiseWithDiscriminators).filter(Boolean);
            const baseHit = candBases.some(b => b === gBase);
            if (baseHit) {
              // Apply priors unless the user intended a movie
              if (!movieWanted) {
                if (node.media_type === 'tv') s += 40;
                if (typeof node.num_episodes === 'number' && node.num_episodes >= 100) s += 25;
                if (node.media_type === 'movie' || node.media_type === 'special' || node.media_type === 'ova') s -= 40;

                const pr = priorFor(gBase);
                if (pr) {
                  if (pr.prefer === 'tv') {
                    if (node.media_type === 'tv') s += 20; else s -= 20;
                  }
                  if (typeof pr.minEpisodes === 'number' && typeof node.num_episodes === 'number') {
                    if (node.num_episodes >= pr.minEpisodes) s += 20; else s -= 15;
                  }
                }
              }
            }
          }

          // If a specific MOVIE NUMBER is requested, sharply prefer that index
          if (movieWanted) {
            const wantIdx = wantedMovieIdx; // can be null if "movie" present without number
            const candIdx = candidateMovieIndexFromTitles(node);
            if (wantIdx != null && candIdx != null) {
              if (candIdx === wantIdx) s += 42; // strong win for correct movie number
              else if (Math.abs(candIdx - wantIdx) <= 1) s += 8; // close-ish (some sites off-by-one)
              else s -= 30; // wrong movie number — push away
            }
          }
        }
        // If the exact guess likely refers to a TV season (contains 'season'...'cour' or a number), penalize movie/ova/special harder
        if (/\b(season|cour|part)\b|\b\d{1,2}\b/.test(gRaw.toLowerCase())) {
          if (node.media_type === 'movie' || node.media_type === 'special' || node.media_type === 'ova') s -= 20;
        }
        // If the guess clearly indicates a movie, penalize TV candidates slightly
        if (/\b(movie|film)\b/i.test(gRaw) && node.media_type === 'tv') {
          s -= 15;
        }
        best = Math.max(best, s);
      }
      return best;
    }
    let bestNode = null, bestScore = -1;
    let secondBest = -1;
    for (const x of data) {
      const node = x.node || x;
      const s = score(node);
      if (s > bestScore) { secondBest = bestScore; bestScore = s; bestNode = node; }
      else if (s > secondBest) { secondBest = s; }
    }
    pickBestMatch._last = { bestScore, secondBest };
    // Learn canonical mapping for this franchise if this looks like the core TV entry
    try {
      const gBase = baseFranchise(gRaw);
      const chosen = bestNode || (data[0] && (data[0].node || data[0])) || null;
      const conf = (pickBestMatch._last && pickBestMatch._last.bestScore) || -1;
      if (gBase && chosen && chosen.media_type === 'tv'
        && typeof chosen.num_episodes === 'number' && chosen.num_episodes >= 50
        && conf >= 120) {
        rememberCanon(gBase, chosen.id, chosen.title);
      }
    } catch (_) { }
    return bestNode || (data[0] && (data[0].node || data[0])) || null;
  }
  async function ensureAutoMappingIfNeeded() {
    dlog('ensureAutoMappingIfNeeded: start');
    if (isHomePage()) { dlog('ensureAutoMappingIfNeeded: homepage → skip'); return null; }
    const key = getSeriesKey();
    const mapped = await getMap(key);
    dlog('ensureAutoMappingIfNeeded: key=', key, 'mapped=', mapped);
    if (mapped && mapped.id) return mapped;
    const guess = guessTitle();
    dlog('ensureAutoMappingIfNeeded: guess=', guess);
    // If we already learned a canonical id for this franchise, try to reuse it directly
    const base = baseFranchise(guess || '');
    if (base) {
      try {
        const canon = await getCanonMap();
        const canonId = canon[base];
        if (canonId) {
          dlog('ensureAutoMappingIfNeeded: using learned canon for', base, '→', canonId);
          await setMap(key, canonId, guess);
          return { id: canonId, title: guess };
        }
      } catch (_) { }
    }
    if (!guess || guess.length < 2) return null;
    let picked = null;
    const merged = await malSearchMulti(guess);
    dlog('ensureAutoMappingIfNeeded: merged candidates =', merged.length);

    if (merged.length) {
      picked = pickBestMatch(merged, guess);
      const conf = (pickBestMatch._last && pickBestMatch._last.bestScore) || -1;
      const gap = (pickBestMatch._last && pickBestMatch._last.secondBest != null)
        ? (pickBestMatch._last.bestScore - pickBestMatch._last.secondBest)
        : -1;
      dlog('ensureAutoMappingIfNeeded: bestScore=', conf, 'gap=', gap);

      // Easier gate for decisive title/alt-title hits; otherwise original strict gate
      const decisive = (conf >= 138);  // exact alt/title (150) or strong containment (≈138)
      if (!(decisive && gap >= 10) && !(conf >= 125 && gap >= 35)) {
        dlog('ensureAutoMappingIfNeeded: gate not met; keeping but not confident');
      }
    }
    if (picked) {
      const last = pickBestMatch._last || {};
      dlog('ensureAutoMappingIfNeeded: PICK', { id: picked.id, title: picked.title, score: last.bestScore, gap: (last.bestScore - last.secondBest) });
      dlog('ensureAutoMappingIfNeeded: picked=', picked && { id: picked.id, title: picked.title });
    }
    if (!picked) { toast('Title not found. Use search to map.'); return null; }
    await setMap(key, picked.id, picked.title);
    return { id: picked.id, title: picked.title };
  }

  // ---- Bubble logic ----
  function isMAL() { return location.hostname === 'myanimelist.net'; }
  async function updateBubble() {
    if (!bubble) return;
    const host = location.hostname;
    let enabled = false;
    try { enabled = await isSiteEnabled(host); } catch { }
    const show = isMAL() || enabled || (isAnimeyPage() && !isHomePage());
    bubble.style.display = show ? 'flex' : 'none';
    bubble.classList.toggle('disabled', !enabled && !isMAL());
    bubble.title = isMAL() ? 'AnimeTrack — MyAnimeList' :
      (enabled ? 'AnimeTrack — click to open/close' : 'AnimeTrack — click to open, enable site via panel');
  }

  // ---- 80% Auto-mark tracker (HiAnime-safe, SPA-safe) ----
  const AUTO = {
    attachedVideo: null,
    attachedSrc: '',
    lastProgressTs: 0,
    lastRatio: 0,
    firedForKey: '',     // `${seriesKey}#${ep}`
    obs: null,
    tickTimer: null
  };

  function isFiniteDuration(d) {
    return typeof d === 'number' && isFinite(d) && d > 1;
  }

  function currentEpisodeKey(seriesKey, ep) {
    if (!seriesKey || !ep) return '';
    return `${seriesKey}#${ep}`;
  }

  async function tryAutoMarkWatched(reason) {
    // uses guards you already have: SESSION.scrobbleInFlight + SESSION.lastMarkKey
    try {
      if (SESSION.scrobbleInFlight) return;
      const onMAL = isMAL();
      if (onMAL) return;
      if (isHomePage()) return;

      const seriesKey = getSeriesKey();
      const mapped = await getMap(seriesKey) || await ensureAutoMappingIfNeeded();
      if (!mapped || !mapped.id) return;

      const ep = guessEpisode();
      if (!ep || ep <= 0) return;

      const key = currentEpisodeKey(seriesKey, ep);
      if (!key) return;

      // avoid duplicates
      if (SESSION.lastMarkKey === key || AUTO.firedForKey === key) return;

      // check already watched
      const st = await getMyListStatus(mapped.id);
      const watched = st && typeof st.num_watched_episodes === 'number' ? st.num_watched_episodes : null;
      const status = st && st.status ? String(st.status).toLowerCase() : '';

      if (watched != null && ep <= watched) {
        AUTO.firedForKey = key;
        SESSION.lastMarkKey = key;
        return;
      }

      // require "watching" unless empty/not set (your UX wants to prompt)
      if (status && status !== 'watching') {
        toast('Set status to Watching to enable auto-mark.');
        return;
      }

      SESSION.scrobbleInFlight = true;
      SESSION.lastMarkKey = key;
      AUTO.firedForKey = key;

      await updateMyListEpisodes(mapped.id, ep);
      await setMyStatusCompletedIfFinished(mapped.id, ep);
      setCachedStatus(mapped.id, null);

      toast(`Auto-marked episode ${ep} watched ✅ (${reason})`);
      try { window.dispatchEvent(new CustomEvent('at:status-changed', { detail: { malId: mapped.id } })); } catch (_) { }
      try { if (panelOpen) renderPanel(); } catch (_) { }
    } catch (e) {
      // clear lastMarkKey so a retry is possible if it failed
      SESSION.lastMarkKey = '';
      AUTO.firedForKey = '';
      toast('Auto-mark failed: ' + (e && e.message || e));
    } finally {
      SESSION.scrobbleInFlight = false;
    }
  }

  function detachVideo() {
    const v = AUTO.attachedVideo;
    if (!v) return;
    try {
      v.removeEventListener('timeupdate', onVideoProgress);
      v.removeEventListener('ended', onVideoEnded);
      v.removeEventListener('durationchange', onVideoProgress);
      v.removeEventListener('loadedmetadata', onVideoProgress);
    } catch { }
    AUTO.attachedVideo = null;
    AUTO.attachedSrc = '';
    AUTO.lastRatio = 0;
  }

  function attachToVideo(v) {
    if (!v) return false;
    const src = v.currentSrc || v.src || '';
    // if the element or src changed, reattach
    if (AUTO.attachedVideo === v && AUTO.attachedSrc === src) return true;

    detachVideo();
    AUTO.attachedVideo = v;
    AUTO.attachedSrc = src;

    dlog('autoTracker: attached video', {
      hasSrc: !!src,
      src: src ? src.slice(0, 140) : '',
      currentTime: v.currentTime,
      duration: v.duration,
      paused: v.paused,
      readyState: v.readyState
    });

    try {
      v.addEventListener('timeupdate', onVideoProgress, { passive: true });
      v.addEventListener('durationchange', onVideoProgress, { passive: true });
      v.addEventListener('loadedmetadata', onVideoProgress, { passive: true });
      v.addEventListener('ended', onVideoEnded, { passive: true });
    } catch { }

    // also poll lightly (some players don’t fire timeupdate consistently)
    if (!AUTO.tickTimer) {
      AUTO.tickTimer = setInterval(() => {
        if (AUTO.attachedVideo) onVideoProgress();
      }, 2500);
    }

    return true;
  }

  function pickBestVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    dlog('autoTracker: videos found =', vids.length);
    if (!vids.length) {
      try {
        const ifs = Array.from(document.querySelectorAll('iframe'))
          .map(f => (f.src || '').slice(0, 220))
          .filter(Boolean);
        if (ifs.length) dlog('autoTracker: iframe src sample =', ifs.slice(0, 4));
      } catch { }
      return null;
    }
    // pick playing / most advanced / with src
    vids.sort((a, b) => {
      const as = (a.currentSrc || a.src || '') ? 1 : 0;
      const bs = (b.currentSrc || b.src || '') ? 1 : 0;
      if (bs !== as) return bs - as;
      return (b.currentTime || 0) - (a.currentTime || 0);
    });
    const v = vids[0] || null;
    if (v) dlog('autoTracker: picked video', { hasSrc: !!(v.currentSrc || v.src), currentTime: v.currentTime, duration: v.duration, paused: v.paused, readyState: v.readyState });
    return v;
  }

  function onVideoEnded() {
    // if ended, mark regardless of duration weirdness
    tryAutoMarkWatched('ended');
  }

  function onVideoProgress() {
    const v = AUTO.attachedVideo;
    if (!v) return;

    // throttle
    const now = safeNow();
    if (now - AUTO.lastProgressTs < 900) return;
    AUTO.lastProgressTs = now;

    const d = v.duration;
    const t = v.currentTime;

    // If duration is unusable, rely on ended()
    if (!isFiniteDuration(d) || !(t >= 0)) return;

    const ratio = t / d;
    AUTO.lastRatio = ratio;

    // Log occasionally so we can debug without the browser console (appears in Copy logs)
    if (ratio > 0 && ratio < 1 && (ratio >= 0.75 || ratio <= 0.05)) {
      dlog('autoTracker: progress', { t: Math.round(t * 10) / 10, d: Math.round(d * 10) / 10, ratio: Math.round(ratio * 1000) / 1000 });
    }

    if (ratio >= 0.80) {
      tryAutoMarkWatched('80%');
    }
  }

  function startAutoTracker() {
    // reattach whenever DOM changes (SPA)
    if (AUTO.obs) return;
    dlog('autoTracker: startAutoTracker()');

    const kick = () => {
      const v = pickBestVideo();
      if (v) {
        attachToVideo(v);
      } else {
        // Likely iframe player; 80% tracking cannot work until a <video> exists in this document
        dlog('autoTracker: no <video> in page (iframe player?) — will rely on iframe tracker if available');
      }
    };

    try {
      AUTO.obs = new MutationObserver(() => {
        kick();
      });
      AUTO.obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch { }

    // initial + delayed kicks
    kick();
    setTimeout(kick, 1200);
    setTimeout(kick, 4000);
  }

  // ---- Frame player tracker (for sites that embed the <video> in a cross-origin iframe) ----
  // Runs inside the iframe (if our userscript matches that domain) and reports progress to the top window.
  const FRAME = {
    attached: null,
    lastTs: 0,
    lastRatio: 0,
    tick: null
  };

  function framePost(type, payload) {
    try {
      window.top.postMessage({
        source: 'animetrack-player',
        type,
        payload: payload || null
      }, '*');
    } catch { }
  }

  function frameOnProgress() {
    const v = FRAME.attached;
    if (!v) return;
    const now = safeNow();
    if (now - FRAME.lastTs < 900) return;
    FRAME.lastTs = now;

    const d = v.duration;
    const t = v.currentTime;
    if (!isFiniteDuration(d) || !(t >= 0)) return;

    const ratio = t / d;
    FRAME.lastRatio = ratio;

    // log only near the threshold to keep logs small
    if (ratio >= 0.75) {
      framePost('progress', { ratio, t, d, src: (v.currentSrc || v.src || '').slice(0, 140) });
    }

    if (ratio >= 0.80) {
      framePost('hit80', { ratio, t, d });
    }
  }

  function frameAttachToVideo(v) {
    if (!v) return false;
    if (FRAME.attached === v) return true;
    try {
      if (FRAME.attached) {
        FRAME.attached.removeEventListener('timeupdate', frameOnProgress);
        FRAME.attached.removeEventListener('durationchange', frameOnProgress);
        FRAME.attached.removeEventListener('loadedmetadata', frameOnProgress);
        FRAME.attached.removeEventListener('ended', frameOnEnded);
      }
    } catch { }

    FRAME.attached = v;
    framePost('attached', {
      src: (v.currentSrc || v.src || '').slice(0, 160),
      duration: v.duration,
      readyState: v.readyState
    });

    try {
      v.addEventListener('timeupdate', frameOnProgress, { passive: true });
      v.addEventListener('durationchange', frameOnProgress, { passive: true });
      v.addEventListener('loadedmetadata', frameOnProgress, { passive: true });
      v.addEventListener('ended', frameOnEnded, { passive: true });
    } catch { }

    if (!FRAME.tick) {
      FRAME.tick = setInterval(frameOnProgress, 2500);
    }
    return true;
  }

  function frameOnEnded() {
    framePost('ended', { ratio: 1 });
  }

  function startFrameTracker() {
    // Only relevant inside iframes
    if (!isFrame) return;

    const kick = () => {
      const vids = Array.from(document.querySelectorAll('video'));
      if (vids.length) {
        // Prefer the playing/most advanced one
        vids.sort((a, b) => (b.currentTime || 0) - (a.currentTime || 0));
        frameAttachToVideo(vids[0]);
      }
    };

    try {
      const mo = new MutationObserver(() => kick());
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch { }

    kick();
    setTimeout(kick, 1200);
    setTimeout(kick, 4000);
    // If we still can't see a <video> after a few seconds, tell the parent (helps debugging on anti-devtools sites)
    setTimeout(() => {
      try {
        const vidsNow = Array.from(document.querySelectorAll('video'));
        if (!vidsNow.length) framePost('novideo', { host: location.host, href: location.href });
      } catch { }
    }, 5500);
  }

  // Parent receives progress from iframe player and triggers the existing auto-mark logic.
  // NOTE: we intentionally keep this very small; the parent still does all MAL work.
  if (!isFrame) {
    try {
      window.addEventListener('message', (ev) => {
        const d = ev && ev.data;
        if (!d || d.source !== 'animetrack-player') return;
        if (d.type === 'hit80' || d.type === 'ended') {
          // Use the parent page context for series/episode; iframe can be cross-origin.
          tryAutoMarkWatched(d.type === 'ended' ? 'ended' : '80%');
        }
        // Keep a breadcrumb for debugging via Copy logs
        try {
          if (d.type === 'attached') {
            dlog('autoTracker: iframe player attached', d.payload);
          } else if (d.type === 'progress') {
            dlog('autoTracker: iframe progress', {
              ratio: Math.round((d.payload?.ratio || 0) * 1000) / 1000,
              t: d.payload?.t,
              d: d.payload?.d
            });
          } else if (d.type === 'novideo') {
            dlog('autoTracker: iframe reports no <video> element', d.payload);
          }
        } catch { }
      });
    } catch { }
  } else {
    // iframe context
    // Only run inside iframe players when embedded by a supported anime site,
    // OR when the iframe host itself is a known player host.
    try {
      if (__AT_ALLOW_FRAME) startFrameTracker();
    } catch { }
  }

  async function clearOAuthFlowState() {
    sessionStorage.removeItem('animetrack_pkce_verifier');
    try { await gm.setValue(STORAGE.pkceVer, ''); } catch { }
    try { await gm.setValue(STORAGE.oauthState, ''); } catch { }
  }

  async function prepareOAuthFlow() {
    await getSettings();
    const verifier = randomString(96);
    const state = randomString(32);
    const challenge = await pkceS256(verifier);
    sessionStorage.setItem('animetrack_pkce_verifier', verifier);
    await gm.setValue(STORAGE.pkceVer, verifier);
    await gm.setValue(STORAGE.oauthState, state);

    const url = new URL(MAL_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', MAL_CLIENT_ID);
    url.searchParams.set('redirect_uri', MAL_REDIRECT_URI);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async function beginOAuth() {
    const popup = window.open('about:blank', '_blank', 'noopener,noreferrer');
    const authUrl = await prepareOAuthFlow();
    if (popup) popup.location.replace(authUrl);
    else window.open(authUrl, '_blank', 'noopener,noreferrer');
    return authUrl;
  }

  async function exchangeOAuthCode(code, incomingState = '') {
    if (!code) throw new Error('Missing OAuth code');

    const savedState = await gm.getValue(STORAGE.oauthState, '');
    if (savedState && incomingState && incomingState !== savedState) {
      await gm.setValue(STORAGE.oauthErr, 'State mismatch');
      throw new Error('State mismatch');
    }

    await getSettings();
    let verifier = sessionStorage.getItem('animetrack_pkce_verifier');
    if (!verifier) verifier = await gm.getValue(STORAGE.pkceVer, '');
    if (!verifier) throw new Error('Missing PKCE verifier');

    try {
      const payload = { code: String(code), code_verifier: verifier, redirect_uri: MAL_REDIRECT_URI };
      const res = await xhr('POST', `${WORKER_URL}/token`, { 'Content-Type': 'application/json' }, JSON.stringify(payload));
      if (!res || !res.access_token) throw new Error('OAuth exchange failed');
      await setTokens(res.access_token, res.refresh_token || '', res.expires_in);
      await gm.setValue(STORAGE.oauthErr, '');
      toast('Connected to MAL');
      try { window.dispatchEvent(new CustomEvent('at:status-changed', { detail: { malId: 'any' } })); } catch { }
      await renderPanel();
      return true;
    } catch (e) {
      const msg = 'OAuth failed: ' + (e && e.message || e);
      await gm.setValue(STORAGE.oauthErr, String(msg));
      throw new Error(msg);
    } finally {
      await clearOAuthFlowState();
    }
  }

  async function disconnectMAL() {
    await gm.setValue(STORAGE.access, '');
    await gm.setValue(STORAGE.refresh, '');
    await gm.setValue(STORAGE.expires, '0');
    await gm.setValue(STORAGE.oauthErr, '');
    await clearOAuthFlowState();
  }

  function extractOAuthPayload(raw) {
    const out = { code: String(raw || '').trim(), state: '' };
    try {
      const parsed = new URL(out.code);
      out.code = parsed.searchParams.get('code') || '';
      out.state = parsed.searchParams.get('state') || '';
      if (!out.code && parsed.hash) {
        const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
        out.code = hash.get('code') || '';
        out.state = out.state || hash.get('state') || '';
      }
    } catch { }
    return out;
  }

  // ---- Auto OAuth (message from oauth.html) ----
  window.addEventListener('message', async (ev) => {
    try {
      const okOrigin = /:\/\/shaharaviram1\.github\.io$/i.test(ev.origin);
      if (!okOrigin) return;
      const data = ev.data || {};
      if (data.source !== 'animetrack-oauth' || !data.code) return;

      try {
        if (ev.source && ev.origin) {
          ev.source.postMessage({ source: 'animetrack-ack', received: true }, ev.origin);
        }
      } catch { }

      try {
        await exchangeOAuthCode(String(data.code), typeof data.state === 'string' ? data.state : '');
        try {
          if (ev.source && ev.origin) {
            ev.source.postMessage({ source: 'animetrack-connected', ok: true }, ev.origin);
          }
        } catch { }
      } catch (e) {
        toast(e && e.message || 'OAuth failed');
        console.warn('[AnimeTrack] token error', e && e.message || e);
      }
    } catch (e) { console.warn('[AnimeTrack] postMessage handler error', e); }
  });

  // ---- Settings / Panel ----
  async function getSettings() {
    const s = await getJSON(STORAGE.settings, {});
    if (s.redirect_uri) MAL_REDIRECT_URI = s.redirect_uri;
    const pk = (typeof s.pkce_plain === 'boolean') ? s.pkce_plain : false;
    return { client_id: MAL_CLIENT_ID, redirect_uri: MAL_REDIRECT_URI, pkce_plain: pk };
  }
  async function saveSettings(obj) {
    const cur = await getJSON(STORAGE.settings, {});
    const nx = Object.assign({}, cur, obj || {});
    await setJSON(STORAGE.settings, nx);
    if (nx.redirect_uri) MAL_REDIRECT_URI = nx.redirect_uri;
  }

  function _host() {
    return normalizeHost(location.hostname || '');
  }

  function _seriesKeySafe() {
    try {
      return isHomePage() ? (_host() + '|unresolved') : getSeriesKey();
    } catch {
      return _host() + '|unresolved';
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function statusLabel(status) {
    if (!status) return 'Not in list';
    return titleCase(String(status).replace(/_/g, ' '));
  }

  function providerLabel(host) {
    const provider = getProviderForHost(host);
    if (!provider) return 'Generic';
    if (provider.key && provider.key.startsWith('custom:')) return 'Custom Site';
    const key = provider.key || Object.keys(PROVIDERS).find(k => PROVIDERS[k] === provider) || host;
    return titleCase(String(key).replace(/custom:/i, '').replace(/[-_]+/g, ' '));
  }

  function defaultProfileDraft(host) {
    host = normalizeHost(host || '');
    const saved = SITE_PROFILES[host] || {};
    const animetsuLike = /animetsu/i.test(host);
    return {
      host,
      label: saved.label || '',
      mode: saved.mode || (animetsuLike ? 'path-id' : 'slug'),
      pathPrefixes: Array.isArray(saved.pathPrefixes) ? saved.pathPrefixes.join(', ') : (saved.pathPrefixes || 'watch, anime, series, show'),
      seriesQueryParam: saved.seriesQueryParam || 'id',
      episodeQueryParam: saved.episodeQueryParam || 'ep',
      titleSelectors: Array.isArray(saved.titleSelectors)
        ? saved.titleSelectors.join(', ')
        : (saved.titleSelectors || (animetsuLike
          ? 'a[href^="/anime/"], h1, [class*="title"], meta[property="og:title"], meta[name="twitter:title"]'
          : 'h1, [class*="title"], meta[property="og:title"], meta[name="twitter:title"]')),
      episodeSelectors: Array.isArray(saved.episodeSelectors)
        ? saved.episodeSelectors.join(', ')
        : (saved.episodeSelectors || '[aria-current="page"], [data-active], [data-selected], .active, .current')
    };
  }

  async function renderPanel() {
    if (!panel) return;

    const card = panel.querySelector('#at-card');
    if (!card) return;

    try {
      await getSettings();

      const host = _host();
      const token = await getToken();
      const authed = !!token;
      const onMAL = isMAL();
      const onHome = isHomePage();
      const enabled = onMAL ? true : await isSiteEnabled(host);

      const seriesKey = (!onMAL && !onHome) ? _seriesKeySafe() : '';
      const mapped = (onMAL || onHome) ? null : (await getMap(seriesKey) || await ensureAutoMappingIfNeeded());
      const epGuess = (onMAL || onHome) ? null : guessEpisode();
      const titleGuess = (!onMAL && !onHome) ? guessTitle() : '';
      const lastErr = await gm.getValue(STORAGE.oauthErr, '');
      const profileDraft = defaultProfileDraft(!onMAL ? host : '');

      let myStatus = null;
      let watchedCount = null;
      let needsWatching = false;
      let needsRewatch = false;

      if (!onMAL && authed && mapped && mapped.id) {
        try {
          myStatus = await getMyListStatus(mapped.id);
          if (myStatus) {
            if (typeof myStatus.num_watched_episodes === 'number') watchedCount = myStatus.num_watched_episodes;
            else if (typeof myStatus.num_episodes_watched === 'number') watchedCount = myStatus.num_episodes_watched;
          }
          const st = (myStatus && myStatus.status) ? String(myStatus.status).toLowerCase() : '';
          if (st === 'completed') needsRewatch = true;
          else if (!st || st !== 'watching') needsWatching = true;
        } catch { }
      }

      const alreadyWatched = (!onMAL && authed && mapped && mapped.id && watchedCount != null && epGuess != null && Number(epGuess) <= Number(watchedCount));
      const displayTitle = onMAL
        ? 'AnimeTrack'
        : onHome
          ? 'Open an episode page'
          : (mapped?.title || titleGuess || 'Ready to map');
      const providerText = onMAL ? 'MyAnimeList' : `${providerLabel(host)} · ${host}`;
      const authText = authed ? 'Connected to MAL' : 'Connect MAL to sync watch progress';
      const statusText = (!onMAL && authed && mapped && mapped.id) ? statusLabel(myStatus && myStatus.status) : 'Pending';
      const watchedText = (!onMAL && authed && mapped && typeof watchedCount === 'number') ? String(watchedCount) : '—';
      const mapText = !onMAL ? (mapped?.title || (titleGuess || 'Not mapped')) : 'Your control panel';

      card.innerHTML = `
        <div class="at-shell">
          <div class="at-header">
            <div class="at-brand">
              <span class="eyebrow">${escapeHtml(providerText)}</span>
              <span class="headline">${escapeHtml(displayTitle)}</span>
              <span class="muted">${escapeHtml(onMAL ? authText : (epGuess ? `Episode ${epGuess}` : 'Episode not detected yet'))}</span>
            </div>
            <button id="at-close" class="icon-btn" type="button">×</button>
          </div>

          <div class="surface hero">
            <div class="chip-row">
              <span class="chip">${authed ? 'MAL linked' : 'MAL offline'}</span>
              ${!onMAL ? `<span class="chip">${enabled ? 'Site active' : 'Site disabled'}</span>` : ''}
              ${!onMAL && mapped && mapped.id ? `<span class="chip">Mapped</span>` : (!onMAL ? '<span class="chip">Needs mapping</span>' : '')}
            </div>
            <div class="row">
              <div class="metric">
                <span class="label">Series</span>
                <span class="value">${escapeHtml(mapText)}</span>
              </div>
              <div class="metric">
                <span class="label">Status</span>
                <span class="value">${escapeHtml(statusText)}</span>
              </div>
              ${!onMAL ? `
              <div class="metric">
                <span class="label">Watched</span>
                <span class="value">${escapeHtml(watchedText)}</span>
              </div>` : ''}
            </div>
            ${!onMAL && !enabled ? `<div class="hint">This host is blocked until you enable it or save a site profile for it.</div>` : ''}
            ${!authed && lastErr ? `<div class="hint" style="color:#ffc5c5">${escapeHtml(lastErr)}</div>` : ''}
          </div>

          <div class="actions">
            ${!enabled && !onMAL ? '<button id="at-enable" class="primary" type="button">Enable This Site</button>' : ''}
            <button id="at-auth" class="${authed ? 'ghost' : 'primary'}" type="button">${authed ? 'Reconnect MAL' : 'Connect MAL'}</button>
            ${authed ? '<button id="at-disc" class="ghost" type="button">Disconnect</button>' : '<button id="at-copy-auth" class="ghost" type="button">Copy Auth Link</button>'}
            ${authed ? '' : '<button id="at-paste-auth" class="ghost" type="button">Paste Code</button>'}
            ${!onMAL && (needsWatching || needsRewatch) ? `<button id="at-setwatch" class="ghost" type="button">${needsRewatch ? 'Start Rewatch' : 'Set Watching'}</button>` : ''}
            ${!onMAL ? `<button id="at-mark" class="primary" type="button" ${(authed && mapped && mapped.id && epGuess && !alreadyWatched) ? '' : 'disabled'}>${alreadyWatched ? 'Already Watched' : 'Mark Watched'}</button>` : ''}
            ${!onMAL && mapped && mapped.id ? '<button id="at-unmap" class="ghost" type="button">Clear Mapping</button>' : ''}
            <button id="at-refresh" class="ghost" type="button">Refresh</button>
          </div>

          ${!onMAL ? `
          <details ${(!mapped || !mapped.id) ? 'open' : ''}>
            <summary>Remap Title</summary>
            <div class="stack" style="margin-top:10px">
              <div class="row">
                <input id="at-query" value="${escapeHtml((mapped?.title || titleGuess || '').trim())}" placeholder="Search MAL title" style="flex:1">
                <button id="at-search" class="ghost" type="button">Search</button>
              </div>
              <div id="at-results" class="results"></div>
            </div>
          </details>` : ''}

          <details ${(!onMAL && !enabled) ? 'open' : ''}>
            <summary>Site Profiles</summary>
            <div class="stack" style="margin-top:10px">
              <div class="field-grid">
                <div class="field">
                  <label for="at-profile-host">Host</label>
                  <input id="at-profile-host" value="${escapeHtml(profileDraft.host)}" placeholder="example.com">
                </div>
                <div class="field">
                  <label for="at-profile-mode">Route mode</label>
                  <select id="at-profile-mode">
                    <option value="slug" ${profileDraft.mode === 'slug' ? 'selected' : ''}>Slug from path</option>
                    <option value="path-id" ${profileDraft.mode === 'path-id' ? 'selected' : ''}>Numeric id in path</option>
                    <option value="query-id" ${profileDraft.mode === 'query-id' ? 'selected' : ''}>Id from query param</option>
                  </select>
                </div>
                <div class="field">
                  <label for="at-profile-label">Label</label>
                  <input id="at-profile-label" value="${escapeHtml(profileDraft.label)}" placeholder="Optional">
                </div>
                <div class="field">
                  <label for="at-profile-prefixes">Path prefixes</label>
                  <input id="at-profile-prefixes" value="${escapeHtml(profileDraft.pathPrefixes)}" placeholder="watch, anime">
                </div>
                <div class="field">
                  <label for="at-profile-series-param">Series query param</label>
                  <input id="at-profile-series-param" value="${escapeHtml(profileDraft.seriesQueryParam)}" placeholder="id">
                </div>
                <div class="field">
                  <label for="at-profile-episode-param">Episode query param</label>
                  <input id="at-profile-episode-param" value="${escapeHtml(profileDraft.episodeQueryParam)}" placeholder="ep">
                </div>
              </div>
              <div class="field">
                <label for="at-profile-title-selectors">Title selectors</label>
                <input id="at-profile-title-selectors" value="${escapeHtml(profileDraft.titleSelectors)}" placeholder="h1, meta[property=&quot;og:title&quot;]">
              </div>
              <div class="field">
                <label for="at-profile-episode-selectors">Episode selectors</label>
                <input id="at-profile-episode-selectors" value="${escapeHtml(profileDraft.episodeSelectors)}" placeholder="[aria-current=&quot;page&quot;], .active">
              </div>
              <div class="actions">
                <button id="at-save-profile" class="primary" type="button">Save Profile</button>
                <button id="at-delete-profile" class="ghost" type="button">Delete Profile</button>
              </div>
              <div class="hint">Saved hosts start running on their own pages after reload because the execution guard reads this profile list at boot.</div>
            </div>
          </details>

          <details>
            <summary>Advanced</summary>
            <div class="stack" style="margin-top:10px">
              <div class="actions">
                <button id="at-toggle-debug" class="ghost" type="button">Toggle Debug</button>
                <button id="at-copy-logs" class="ghost" type="button">Copy Logs</button>
                <button id="at-clear-logs" class="ghost" type="button">Clear Logs</button>
              </div>
              ${seriesKey ? `<div class="hint">Series key: <span class="mono">${escapeHtml(seriesKey)}</span></div>` : ''}
              <div class="hint">Auto-mark triggers at 80% playback or on video end. Cross-origin iframe players are handled through the frame tracker.</div>
            </div>
          </details>
        </div>
      `;

      try {
        const $ = (id) => card.querySelector('#' + id);

        if ($('at-close')) $('at-close').addEventListener('click', () => {
          panelOpen = false;
          if (panel) panel.style.display = 'none';
        });

        if ($('at-refresh')) $('at-refresh').addEventListener('click', () => { renderPanel(); });

        if ($('at-toggle-debug')) $('at-toggle-debug').addEventListener('click', () => {
          DEBUG = !DEBUG;
          toast('Debug ' + (DEBUG ? 'ON' : 'OFF'));
        });

        if ($('at-copy-logs')) $('at-copy-logs').addEventListener('click', async () => {
          try { await copyToClipboard(__AT_LOGS.join('\n')); } catch { toast('Copy failed'); }
        });

        if ($('at-clear-logs')) $('at-clear-logs').addEventListener('click', () => {
          __AT_LOGS.length = 0;
          toast('Logs cleared');
        });

        if ($('at-enable')) $('at-enable').addEventListener('click', async () => {
          try {
            await addSite(host);
            toast('Site enabled');
            await updateBubble();
            await renderPanel();
          } catch {
            toast('Enable failed');
          }
        });

        if ($('at-auth')) $('at-auth').addEventListener('click', async () => {
          try { await beginOAuth(); } catch (e) { toast(e && e.message || 'Auth flow unavailable'); }
        });

        if ($('at-disc')) $('at-disc').addEventListener('click', async () => {
          try {
            await disconnectMAL();
            toast('Disconnected');
            await renderPanel();
          } catch {
            toast('Disconnect failed');
          }
        });

        if ($('at-copy-auth')) $('at-copy-auth').addEventListener('click', async () => {
          try {
            const url = await prepareOAuthFlow();
            await copyToClipboard(url);
            toast('Auth link copied');
          } catch (e) {
            toast(e && e.message || 'Copy failed');
          }
        });

        if ($('at-paste-auth')) $('at-paste-auth').addEventListener('click', async () => {
          try {
            const raw = prompt('Paste the MAL code or full callback URL:');
            if (!raw) return;
            const { code, state } = extractOAuthPayload(raw);
            if (!code) return toast('No OAuth code found');
            await exchangeOAuthCode(code, state);
          } catch (e) {
            toast(e && e.message || 'OAuth failed');
          }
        });

        if ($('at-unmap')) $('at-unmap').addEventListener('click', async () => {
          try {
            const key = _seriesKeySafe();
            const maps = await getJSON(STORAGE.maps, {});
            delete maps[key];
            await setJSON(STORAGE.maps, maps);
            toast('Mapping cleared');
            await renderPanel();
          } catch {
            toast('Clear failed');
          }
        });

        if ($('at-setwatch')) $('at-setwatch').addEventListener('click', async () => {
          try {
            const currentMapped = await getMap(_seriesKeySafe()) || await ensureAutoMappingIfNeeded();
            if (!currentMapped || !currentMapped.id) return toast('Not mapped');
            const st = await getMyListStatus(currentMapped.id);
            const status = st && st.status ? String(st.status).toLowerCase() : '';
            if (status === 'completed') {
              await startRewatch(currentMapped.id);
              toast('Rewatch started');
            } else {
              await setMyStatusWatching(currentMapped.id);
              toast('Status set to Watching');
            }
            setCachedStatus(currentMapped.id, null);
            await renderPanel();
          } catch (e) {
            toast('Status update failed: ' + (e && e.message || e));
          }
        });

        if ($('at-mark')) $('at-mark').addEventListener('click', async () => {
          try {
            const currentMapped = await getMap(_seriesKeySafe()) || await ensureAutoMappingIfNeeded();
            if (!currentMapped || !currentMapped.id) return toast('Not mapped');
            const ep = guessEpisode();
            if (!ep) return toast('Episode not detected');
            await updateMyListEpisodes(currentMapped.id, Number(ep));
            await setMyStatusCompletedIfFinished(currentMapped.id, Number(ep));
            setCachedStatus(currentMapped.id, null);
            toast('Marked episode ' + ep);
            try { window.dispatchEvent(new CustomEvent('at:status-changed', { detail: { malId: currentMapped.id } })); } catch { }
            await renderPanel();
          } catch (e) {
            toast('Mark failed: ' + (e && e.message || e));
          }
        });

        const renderSearchResults = async () => {
          const resultsRoot = $('at-results');
          const input = $('at-query');
          if (!resultsRoot || !input) return;
          const query = input.value.trim() || titleGuess || mapped?.title || '';
          if (!query) return toast('Enter a title to search');
          resultsRoot.innerHTML = '<div class="hint">Searching MAL…</div>';
          const results = await malSearchMulti(query);
          if (!results.length) {
            resultsRoot.innerHTML = '<div class="hint">No results found.</div>';
            return;
          }
          resultsRoot.innerHTML = results.slice(0, 12).map(item => {
            const node = item.node || item;
            return `
              <button type="button" class="result" data-mal-id="${node.id}" data-mal-title="${escapeHtml(node.title || '')}">
                <strong>${escapeHtml(node.title || ('#' + node.id))}</strong>
                <span>${escapeHtml([node.media_type || '', node.num_episodes ? `${node.num_episodes} eps` : ''].filter(Boolean).join(' · '))}</span>
              </button>
            `;
          }).join('');
          qsa('.result', resultsRoot).forEach(btn => {
            btn.addEventListener('click', async () => {
              try {
                const malId = parseInt(btn.getAttribute('data-mal-id') || '0', 10);
                const malTitle = btn.getAttribute('data-mal-title') || '';
                if (!malId) return;
                await setMap(_seriesKeySafe(), malId, malTitle);
                toast('Mapped to ' + malTitle);
                await renderPanel();
              } catch {
                toast('Mapping failed');
              }
            });
          });
        };

        if ($('at-search')) $('at-search').addEventListener('click', renderSearchResults);
        if ($('at-query')) $('at-query').addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            renderSearchResults();
          }
        });

        if ($('at-save-profile')) $('at-save-profile').addEventListener('click', async () => {
          try {
            const targetHost = normalizeHost(($('at-profile-host')?.value || '').trim());
            if (!targetHost) return toast('Host is required');
            await saveSiteProfile(targetHost, {
              label: ($('at-profile-label')?.value || '').trim(),
              mode: $('at-profile-mode')?.value || 'slug',
              pathPrefixes: parseSelectorList(($('at-profile-prefixes')?.value || '').trim(), ['watch', 'anime']),
              seriesQueryParam: ($('at-profile-series-param')?.value || 'id').trim() || 'id',
              episodeQueryParam: ($('at-profile-episode-param')?.value || 'ep').trim() || 'ep',
              titleSelectors: parseSelectorList(($('at-profile-title-selectors')?.value || '').trim(), ['h1']),
              episodeSelectors: parseSelectorList(($('at-profile-episode-selectors')?.value || '').trim(), [])
            });
            toast(`Saved site profile for ${targetHost}`);
            if (targetHost === host) await updateBubble();
            await renderPanel();
          } catch (e) {
            toast(e && e.message || 'Save failed');
          }
        });

        if ($('at-delete-profile')) $('at-delete-profile').addEventListener('click', async () => {
          try {
            const targetHost = normalizeHost(($('at-profile-host')?.value || '').trim());
            if (!targetHost) return toast('Host is required');
            await deleteSiteProfile(targetHost);
            toast(`Removed site profile for ${targetHost}`);
            if (targetHost === host) await updateBubble();
            await renderPanel();
          } catch {
            toast('Delete failed');
          }
        });

      } catch (e) {
        dlog('renderPanel: wiring error', e && e.message || e);
      }

    } catch (e) {
      try {
        card.innerHTML = `
          <div class="at-shell">
            <div class="at-header">
              <div class="at-brand">
                <span class="eyebrow">AnimeTrack</span>
                <span class="headline">Panel error</span>
                <span class="muted">${escapeHtml(String(e && e.message || e))}</span>
              </div>
              <button id="at-close" class="icon-btn" type="button">×</button>
            </div>
            <div class="actions">
              <button id="at-refresh" class="ghost" type="button">Refresh</button>
              <button id="at-toggle-debug" class="ghost" type="button">Toggle Debug</button>
            </div>
          </div>
        `;
        const btnR = card.querySelector('#at-refresh');
        if (btnR) btnR.addEventListener('click', () => { try { renderPanel(); } catch (_) { } });
        const btnD = card.querySelector('#at-toggle-debug');
        if (btnD) btnD.addEventListener('click', () => { DEBUG = !DEBUG; try { toast('Debug ' + (DEBUG ? 'ON' : 'OFF')); } catch (_) { } });
        const btnC = card.querySelector('#at-close');
        if (btnC) btnC.addEventListener('click', () => { panelOpen = false; panel.style.display = 'none'; });
      } catch (_) { }
      dlog('renderPanel: crashed hard', e && e.message || e);
    }
  }

  // ---- Bootstrap / SPA-safe refresh ----
  function onRouteChange() {
    try { if (!isFrame) ensureShell(); } catch (_) { }
    try { updateBubble(); } catch (_) { }
    try { if (panelOpen) renderPanel(); } catch (_) { }
  }

  // Initial boot
  try { if (!isFrame) ensureShell(); } catch (_) { }
  try { seedSitesOnce(); } catch (_) { }
  try { getSiteProfiles(); } catch (_) { }
  try { updateBubble(); } catch (_) { }

  // React to SPA navigations
  try {
    const _ps = history.pushState;
    history.pushState = function () { const r = _ps.apply(this, arguments); setTimeout(onRouteChange, 0); return r; };
    const _rs = history.replaceState;
    history.replaceState = function () { const r = _rs.apply(this, arguments); setTimeout(onRouteChange, 0); return r; };
    window.addEventListener('popstate', () => setTimeout(onRouteChange, 0));
  } catch (_) { }

  // Also refresh on focus (helps when changing episodes in background tabs)
  try { window.addEventListener('focus', () => setTimeout(onRouteChange, 0)); } catch (_) { }

})();
