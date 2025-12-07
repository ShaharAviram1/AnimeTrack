// ==UserScript==
// @name         AnimeTrack
// @namespace    https://github.com/ShaharAviram1/AnimeTrack
// @description  Fast anime scrobbler for MAL: auto-map titles, seeded anime sites, MAL OAuth (PKCE S256), auto-mark at 80%, clean Shadow-DOM UI.
// @version      1.6.6
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
// @noframes
// @match        *://myanimelist.net/*
// @match        *://hianime.to/*
// @match        *://hianime.tv/*
// @match        *://aniwatch.to/*
// @match        *://aniwatchtv.to/*
// @match        *://9anime.to/*
// @match        *://zoro.to/*
// @match        *://gogoanime.fi/*
// @match        *://gogoanime.dk/*
// @match        *://gogoanimehd.to/*
// ==/UserScript==

(() => {
  'use strict';
  try { console.log('[AnimeTrack] booting…', location.href); } catch {}
  // Catch hard errors early (helps Safari which may reload SPA routes on exceptions)
  try {
    window.addEventListener('error', (e)=>{
      try { console.log('[AnimeTrack] window error:', e && (e.message||e.error)); } catch {}
    });
    window.addEventListener('unhandledrejection', (e)=>{
      try { console.log('[AnimeTrack] unhandled rejection:', e && (e.reason && e.reason.message) || e && e.reason || e); } catch {}
    });
  } catch {}

  let DEBUG = true; // can be toggled at runtime
  function dlog(){
    if (!DEBUG) return;
    try { console.log('[AnimeTrack]', ...arguments); } catch {}
  }
  // Expose quick toggles for debugging
  try {
    window.AnimeTrackDebug = {
      on(){ DEBUG = true; try { console.log('[AnimeTrack] DEBUG ON'); } catch {} },
      off(){ DEBUG = false; try { console.log('[AnimeTrack] DEBUG OFF'); } catch {} },
      toggle(){ DEBUG = !DEBUG; try { console.log('[AnimeTrack] DEBUG', DEBUG); } catch {} }
    };
  } catch {}

  // ---- GM polyfill ----
  const gm = (function(){
    const g = (typeof GM !== 'undefined' && GM) ? GM : {};
    if (typeof g.xmlHttpRequest === 'undefined' && typeof GM_xmlhttpRequest !== 'undefined') {
      g.xmlHttpRequest = GM_xmlhttpRequest;
    }
    if (typeof g.getValue !== 'function') g.getValue = async (_k, fallback='') => fallback;
    if (typeof g.setValue !== 'function') g.setValue = async (_k, _v) => {};
    if (typeof g.registerMenuCommand !== 'function') g.registerMenuCommand = (_t,_f)=>{};
    return g;
  })();

  try {
    if (gm && typeof gm.registerMenuCommand === 'function') {
      gm.registerMenuCommand('AnimeTrack: Toggle Debug', () => {
        DEBUG = !DEBUG;
        try { console.log('[AnimeTrack] DEBUG', DEBUG); } catch {}
        try { toast('Debug ' + (DEBUG ? 'ON' : 'OFF')); } catch {}
      });
    }
  } catch {}

  // ---- Constants ----
  let MAL_CLIENT_ID = '8cdc30a4b5c47b9aebe8372b6c5883ee';
  let MAL_REDIRECT_URI = 'https://shaharaviram1.github.io/AnimeTrack/oauth.html';
  const MAL_AUTH_URL  = 'https://myanimelist.net/v1/oauth2/authorize';
  const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
  const MAL_SEARCH = 'https://api.myanimelist.net/v2/anime';
  const WORKER_URL   = 'https://anime-track-oauth.shaharaviram.workers.dev';
  const STORAGE = {
  access: 'animetrack.malToken',
  refresh: 'animetrack.malRefresh',
  sites:   'animetrack.sites',
  maps:    'animetrack.seriesMaps',
  seeded:  'animetrack.seeded',
  settings:'animetrack.settings',
  pkce:    'animetrack.pkce',
  oauthErr:'animetrack.oauthErr'
  , pkceVer: 'animetrack.pkce_ver'
  ,oauthState:'animetrack.oauthState'
  ,expires:'animetrack.expires'
  , canon:  'animetrack.franchiseCanon'
  };
  const SEEDED_HOSTS = new Set([
    '9anime.to','aniwatch.to','aniwatchtv.to','gogoanime.dk','gogoanime.fi','gogoanimehd.to','hianime.to','hianime.tv','zoro.to'
  ]);
  // Soft scoring priors per franchise base (no hard MAL IDs)
  const FRANCHISE_PRIORS = {
    'one piece': { prefer: 'tv', minEpisodes: 100 },
    'detective conan': { prefer: 'tv', minEpisodes: 100 },
    'bleach': { prefer: 'tv', minEpisodes: 50 },
    'gintama': { prefer: 'tv', minEpisodes: 50 },
    'naruto': { prefer: 'tv', minEpisodes: 50 },
    'dragon ball': { prefer: 'tv', minEpisodes: 50 }
  };

  function priorFor(base){
    if (!base) return null;
    // try exact base, then without discriminators
    return FRANCHISE_PRIORS[base] || FRANCHISE_PRIORS[baseFranchise(base)];
  }

  // ---- Utils ----
  const qsa = (s, r=document) => Array.from(r.querySelectorAll(s));
  const qs = (s, r=document) => r.querySelector(s);
  const isFrame = (window.top !== window.self);
  function norm(s){ return (s||'').replace(/\s+/g,' ').trim(); }
  function encodeForm(obj){ return Object.keys(obj).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`).join('&'); }
  function titleCase(s){ return (s||'').split(' ').map(w => w ? (w[0].toUpperCase()+w.slice(1)) : w).join(' '); }

  // Prefer exact title (only trim/collapse spaces) for first MAL search to avoid partial matches
  function preferExactTitle(s){
    return (s||'').replace(/\s+/g,' ').trim();
  }

  function _decSlug(s){ try { return decodeURIComponent(s); } catch { return s || ''; } }
  // Extract a canonical series slug from a pathname
  function extractSeriesSlugFromPath(pathname){
    dlog('extractSeriesSlugFromPath: in', pathname);
    const parts = (pathname||'').split('/').filter(Boolean);
    const prefixes = new Set(['watch','anime','series','stream','show']);
    let slug = parts.length > 1 && prefixes.has((parts[0]||'').toLowerCase()) ? parts[1] : (parts[0] || '');
    slug = _decSlug(String(slug).toLowerCase());
    // strip episode tails like -episode-12, -ep-12, -e12, -season-2, -s2
    slug = slug.replace(/-(?:episode|ep|e|season|s)[-_]?\d+.*$/i, '');
    // strip trailing numeric site id like -19908 (3+ digits to avoid s2)
    slug = slug.replace(/-\d{3,}$/i, '');
    // remove common junk tokens at end
    slug = slug.replace(/-(?:1080p|720p|sub|dub|watch|full|free)$/gi, '');
    // collapse dashes and trim
    slug = slug.replace(/-+/g,'-').replace(/^-|-$/g,'');
    dlog('extractSeriesSlugFromPath: out', slug);
    return slug;
  }

  // PKCE helpers (S256)
  function b64url(buf){
    let str = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return str.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  async function pkceS256(verifier){
    const enc = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    return b64url(digest);
  }
  function randomString(len=64){
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
    let out=''; for (let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
    return out;
  }

  // ---- UI shell ----
  let root, shadow, bubble, panel, panelOpen=false, domObs=null;
  function ensureShell() {
    if (root || isFrame || window.top !== window.self) return;
    root = document.createElement('div');
    root.id = 'animetrack-root';
    document.documentElement.appendChild(root);
    shadow = root.attachShadow({mode:'open'});
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .bubble { position: fixed; right: 16px; bottom: 16px; width: 28px; height: 28px;
                border-radius: 50%; background:#2d7ef7; color:#fff; display:flex; align-items:center;
                justify-content:center; font-weight:700; font-size:12px; box-shadow:0 6px 18px rgba(0,0,0,.35);
                cursor:pointer; z-index:2147483647; }
      .bubble.disabled { background:#5b6b87; opacity:.9 }
      .panel { position: fixed; right: 16px; bottom: 56px; z-index: 2147483647;
               font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu; }
      .card { background: rgba(18,18,18,.94); color: #fff; border-radius: 14px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
              padding: 12px 14px; min-width: 360px; }
      .row { display:flex; align-items:center; gap:10px; }
      .title { font-weight:700; font-size:14px; margin-bottom:8px; opacity:.95 }
      .sub { font-size:12px; opacity:.75; }
      button { border:0; border-radius:10px; padding:8px 10px; cursor:pointer; font-weight:600; }
      .primary { background:#2d7ef7; color:#fff; }
      .ghost { background:transparent; color:#fff; border:1px solid #ffffff2a; }
      input { border:1px solid #ffffff2a; background:transparent; color:#fff; border-radius:8px; padding:6px 8px; }
      input[type="number"]{ width:110px; }
      .row + .row { margin-top:8px; }
      .list { margin-top:8px; max-height:160px; overflow:auto; border:1px solid #ffffff1a; border-radius:10px; }
      .li { padding:8px; border-bottom:1px solid #ffffff10; cursor:pointer; }
      .li:hover { background:#ffffff10; }
      .toast { position: fixed; right: 16px; bottom: 96px; background: rgba(18,18,18,.94); color:#fff;
               padding:10px 12px; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
      .hint { font-size:11px; opacity:.7 }
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

    try { console.log('[AnimeTrack] UI shell ready'); } catch {}

    try {
      let t = null;
      domObs = new MutationObserver(() => {
        if (t) return; // debounce to once per frame
        t = requestAnimationFrame(()=>{ t=null; updateBubble(); });
      });
      domObs.observe(document.body || document.documentElement, {childList:true, subtree:true});
    } catch {}
  }
  function toast(msg){
    if (!shadow) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    shadow.appendChild(t);
    setTimeout(()=> t.remove(), 2600);
  }
  function isAnimeyPage(){ const p = location.pathname.toLowerCase(); return /anime|watch|episode|series|ep|stream/.test(p); }
  function isHomePage(){
    const p = (location.pathname || '/').replace(/\/+$/,'/');
    if (p === '/' || p === '/home' || p === '/index' || p === '/index.html') return true;
    if (p === '/' && location.search) return true;
    return false;
  }

  // ---- Storage helpers ----
  async function getJSON(key, fallback){ try { const raw = await gm.getValue(key, ''); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
  async function setJSON(key, val){ try { return gm.setValue(key, JSON.stringify(val)); } catch { return; } }
  async function getToken(){ return (await gm.getValue(STORAGE.access,'')) || ''; }
  async function getRefresh(){ return (await gm.getValue(STORAGE.refresh,'')) || ''; }
  async function getExpiry(){ const v = await gm.getValue(STORAGE.expires,'0'); const n = parseInt(v,10)||0; return n; }
  async function setTokens(access, refresh, expiresIn){
    await gm.setValue(STORAGE.access, access||'');
    if (refresh!==undefined) await gm.setValue(STORAGE.refresh, refresh||'');
    if (typeof expiresIn === 'number') {
      const exp = Date.now() + Math.max(0, (expiresIn|0)) * 1000 - 60000; // minus 60s buffer
      await gm.setValue(STORAGE.expires, String(exp));
    }
  }

  // ---- Network helpers ----
  function xhr(method, url, headers={}, data=null){
    return new Promise((resolve, reject) => {
      if (!gm.xmlHttpRequest) return reject(new Error('No GM.xmlHttpRequest'));
      gm.xmlHttpRequest({
        method, url, headers, data,
        onload: (r) => {
          const status = r.status;
          const statusText = r.statusText || '';
          const txt = r.responseText || '';
          let json = null;
          try { json = txt ? JSON.parse(txt) : null; } catch {}
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
  const PROVIDERS = {
    hianime: {
      domains: ['hianime.to', 'hianime.tv', 'aniwave.to', 'aniwave.se', 'aniwatch.to', 'aniwatchtv.to'],
      detectTitle(doc, loc) {
        dlog('hianime.detectTitle: start', loc && loc.href);
        // 1) Canonical/OG/Twitter URL → slug → title
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
              if (slug) {
                dlog('hianime.detectTitle: canonical slug →', slug);
                return titleCase(slug);
              }
            }
          } catch {}
        }

        // 2) JSON-LD structured data
        try {
          const nodes = doc.querySelectorAll('script[type="application/ld+json"]');
          for (const n of nodes) {
            const data = JSON.parse(n.textContent || 'null');
            const arr = Array.isArray(data) ? data : [data];
            for (const obj of arr) {
              const nm = obj?.name || obj?.headline || obj?.['@name'] || obj?.alternateName;
              if (nm && String(nm).trim().length > 1) {
                dlog('hianime.detectTitle: JSON-LD name →', nm);
                return cleanTitle(nm);
              }
            }
          }
        } catch {}

        // 3) Common title containers on HiAnime/9anime clones
        const cand = [
          doc.querySelector('.film-name a')?.textContent,
          doc.querySelector('.film-name')?.textContent,
          doc.querySelector('.anisc-detail .name')?.textContent,
          doc.querySelector('.dynamic-name')?.textContent,
          doc.querySelector('h1')?.textContent,
          doc.querySelector('meta[property="og:title"]')?.content,
          doc.querySelector('meta[name="twitter:title"]')?.content
        ].filter(Boolean).map(cleanTitle).find(x => x && x.length > 1);
        if (cand) {
          dlog('hianime.detectTitle: DOM cand →', cand);
          return cand;
        }

        // 4) Fallback from current path
        try {
          const parts = loc.pathname.split('/').filter(Boolean);
          let slug = parts.includes('watch') ? parts[parts.indexOf('watch') + 1] : parts[0] || '';
          slug = slug
            .replace(/-episode-?\d+.*/i, '')
            .replace(/-ep-?\d+.*/i, '')
            .replace(/-s(?:eason)?-?\d+$/i, '')
            .replace(/-\d{3,}$/i, '')
            .replace(/[-_]+/g, ' ')
            .trim();
          if (slug) {
            dlog('hianime.detectTitle: fallback path →', slug);
            return titleCase(slug);
          }
        } catch {}

        dlog('hianime.detectTitle: fallback empty');
        return '';
      },

      detectEpisode(doc, loc) {
        dlog('hianime.detectEpisode: start', loc && loc.href);
        const currentEpFromURL = (() => {
          const m = loc.href.match(/[?&]ep=([0-9]+)/i);
          return m ? m[1] : null;
        })();
        dlog('hianime.detectEpisode: url ep=', currentEpFromURL);

        // Active element first
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
        for (const sel of activeSelectors) {
          const el = doc.querySelector(sel);
          dlog('hianime.detectEpisode: active sel', sel, '→', el && (el.getAttribute('data-number')||el.getAttribute('data-ep')||el.getAttribute('data-episode')||el.textContent));
          if (!el) continue;

          const data = el.getAttribute('data-number') ||
                       el.getAttribute('data-ep') ||
                       el.getAttribute('data-episode');
          if (data && /^\d+$/.test(data)) {
            dlog('hianime.detectEpisode: active number →', parseInt(data));
            return parseInt(data);
          }

          const t = el.textContent;
          const m = t?.match(/(\d{1,4})/);
          if (m) {
            dlog('hianime.detectEpisode: active number →', parseInt(m[1]));
            return parseInt(m[1]);
          }
        }

        // If URL has ep=xxxx, match anchor with same internal id
        if (currentEpFromURL) {
          const link = [...doc.querySelectorAll('.ep-item a, a.ep-item, a')].find(a =>
            a.href.includes(`ep=${currentEpFromURL}`) ||
            a.getAttribute('data-id') === currentEpFromURL
          );
          if (link) {
            const num = link.getAttribute('data-number') ||
                        link.getAttribute('data-ep') ||
                        link.textContent.match(/\d+/)?.[0];
            if (num) {
              dlog('hianime.detectEpisode: matched by URL anchor →', parseInt(num));
              return parseInt(num);
            }
          }
        }

        // Fallback: highest visible episode number in list
        const nums = [...doc.querySelectorAll('.ep-item, .ep-item a, .list-episode a')]
          .map(x => {
            const v = x.getAttribute('data-number') ||
                      x.getAttribute('data-ep') ||
                      x.textContent;
            const m = v?.match(/\d+/);
            return m ? parseInt(m[0]) : null;
          })
          .filter(Boolean);
        if (nums.length) {
          dlog('hianime.detectEpisode: fallback list nums =', nums);
          dlog('hianime.detectEpisode: fallback picked max →', Math.max(...nums));
          return Math.max(...nums);
        }

        return null;
      }
    }
  };

  function getProviderForHost(host) {
    host = host.replace(/^www\./i,'').toLowerCase();
    for (const key in PROVIDERS) {
      if (PROVIDERS[key].domains.includes(host)) return PROVIDERS[key];
    }
    return null;
  }
  function cleanTitle(t){
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
    t = t.replace(/\(?\b(19|20)\d{2}\b\)?$/,'');
    // Normalize Part/Cour phrases for comparison (do not delete numbers here)
    t = t.replace(/\bpart\s*(\d{1,2})\b/ig, 'season $1');
    t = t.replace(/\bcour\s*(\d{1,2})\b/ig, 'season $1');
    t = t.replace(/\s{2,}/g,' ');
    return t.trim();
  }
  // --- MAL-Sync-inspired title normalization helpers ---
function normalizeCmp(s){
  return (s||'')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')     // strip diacritics
    .replace(/[^a-z0-9]+/g, ' ')         // collapse non-alnum
    .replace(/\b(tv|anime|official site)\b/g, '')
    .replace(/\s+/g,' ')
    .trim();
}
function romanToInt(roman){
  if (!roman) return null;
  const map = {M:1000,CM:900,D:500,CD:400,C:100,XC:90,L:50,XL:40,X:10,IX:9,V:5,IV:4,I:1};
  let i=0, n=0, s=roman.toUpperCase();
  while (i < s.length){
    if (i+1<s.length && map[s.slice(i,i+2)]){ n += map[s.slice(i,i+2)]; i+=2; }
    else { const v = map[s[i]]; if (!v) return null; n += v; i++; }
  }
  return n || null;
}
function intToRoman(num){
  if (!num || num<1) return '';
  const vals = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let out=''; for(const [v,sym] of vals){ while(num>=v){ out+=sym; num-=v; } } return out;
}
function detectSeasonNumber(s){
  if (!s) return null;
  const t = s.toLowerCase();
  let m = t.match(/\bseason\s*(\d{1,2})\b/); if (m) return parseInt(m[1],10);
  m = t.match(/\bs\s*(\d{1,2})\b/);          if (m) return parseInt(m[1],10);
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*season\b/); if (m) return parseInt(m[1],10);
  // roman numerals
  m = t.match(/\bseason\s*([ivxlcdm]+)\b/i); if (m){ const n = romanToInt(m[1]); if (n) return n; }
  m = t.match(/\b([ivxlcdm]+)\s*season\b/i); if (m){ const n = romanToInt(m[1]); if (n) return n; }
  // part/cour synonyms
  m = t.match(/\bpart\s*(\d{1,2})\b/); if (m) return parseInt(m[1],10);
  m = t.match(/\bcour\s*(\d{1,2})\b/); if (m) return parseInt(m[1],10);
  // phrases like "final season" cannot map to a number reliably → return null
  return null;
}
function stripSeasonPhrases(s){
  if (!s) return s;
  return s
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\s*season\b/ig,'')
    .replace(/\bseason\s*[ivxlcdm]+\b/ig,'')
    .replace(/\b[ivxlcdm]+\s*season\b/ig,'')
    .replace(/\bseason\s*\d{1,2}\b/ig,'')
    .replace(/\bs\s*\d{1,2}\b/ig,'')
    .replace(/\s{2,}/g,' ').trim();
}
function seasonVariants(base){
  const out = new Set();
  const b = cleanTitle(base);
  const n = detectSeasonNumber(b);
  const core = stripSeasonPhrases(b);
  out.add(b);
  out.add(core);
  if (n){
    const ord = (n%10===1&&n%100!==11)?'st':(n%10===2&&n%100!==12)?'nd':(n%10===3&&n%100!==13)?'rd':'th';
    out.add(`${core} Season ${n}`);
    out.add(`${core} ${n}${ord} Season`);
    out.add(`${core} ${intToRoman(n)}`);
    out.add(`${core} Season ${intToRoman(n)}`);
    out.add(`${core} S${n}`);
  }
  return Array.from(out).filter(x=>x && x.length>1);
}
function baseFranchise(title){
  // Normalize to a “core” franchise key: strip years, season/cour/part markers, ep numbers, punctuation
  let s = (title||'').toLowerCase();
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
  s = s.replace(/\b(tv|anime|official site)\b/g,'');
  s = s.replace(/\b(episode|ep|e)\s*\d+\b/g,'');
  s = s.replace(/\bpart\s*\d+\b/g,'');
  s = s.replace(/\bcour\s*\d+\b/g,'');
  s = s.replace(/\bseason\s*\d+\b/g,'');
  s = s.replace(/\bs\s*\d+\b/g,'');
  s = s.replace(/\b(19|20)\d{2}\b/g,'');
  s = s.replace(/[-_]+/g,' ');
  s = s.replace(/[^a-z0-9 ]+/g,' ');
  s = s.replace(/\s{2,}/g,' ').trim();
  return s;
}

// Tokens that distinguish sub-series within a franchise (don't collapse away)
const FRANCHISE_DISCRIM_TOKENS = [
  'z','kai','shippuden','brotherhood','super','final season',
  '64','2011','remake','kings arc','part 2','part 3'
];

function baseFranchiseWithDiscriminators(title){
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
    const re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&') + '\\b', 'i');
    if (re.test(norm) && !seen.has(t)) { seen.add(t); picks.push(tok.toLowerCase()); }
  }

  if (!picks.length) return core;

  // Attach discriminators to core; keep short and stable
  return (core + ' ' + picks.join(' ')).trim();
}

async function getCanonMap(){
  try { const raw = await gm.getValue(STORAGE.canon, ''); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
async function setCanonMap(m){
  try { await gm.setValue(STORAGE.canon, JSON.stringify(m||{})); } catch {}
}
async function rememberCanon(franchiseBase, malId, malTitle){
  if (!franchiseBase || !malId) return;
  const m = await getCanonMap();
  // only set if empty or confirming same id; avoid flapping
  if (!m[franchiseBase] || m[franchiseBase] === malId) {
    m[franchiseBase] = malId;
    await setCanonMap(m);
    dlog('canon remember:', franchiseBase, '→', malId, malTitle||'');
  }
}

function titlesOf(node){
  const alts = [];
  if (!node) return alts;
  if (node.title) alts.push(node.title);
  const at = node.alternative_titles || {};
  ['en','en_jp','ja','ja_jp','synonyms'].forEach(k => {
    const v = at[k];
    if (Array.isArray(v)) v.forEach(x => alts.push(x));
    else if (typeof v === 'string') alts.push(v);
  });
  return alts.filter(Boolean);
}
  function fromOgUrlSlug(){
    try{
      const u = qs('meta[property="og:url"]')?.content || qs('meta[name="twitter:url"]')?.content;
      if (!u) return null;
      const url = new URL(u);
      const parts = url.pathname.split('/').filter(Boolean);
      let slug = parts[1] || parts[0] || '';
      const prefixes = new Set(['watch','anime','series','stream','show']);
      if (slug && prefixes.has((parts[0]||'').toLowerCase()) && parts[1]) slug = parts[1];
      slug = slug.replace(/-episode-?\d+.*$/i, '').replace(/-ep-?\d+.*$/i, '').replace(/-\d+$/i, '');
      return slug.replace(/[-_]+/g,' ').trim();
    }catch{ return null; }
  }
  function slugToTitle(slug){
    if (!slug) return '';
    slug = slug.replace(/-episode-?\d+.*$/i, '').replace(/-ep-?\d+.*$/i, '').replace(/-\d+$/i, '');
    let s = slug.replace(/[-_]+/g, ' ').trim();
    return titleCase(s);
  }
  function parseJSONLDName(){
    try{
      const nodes = qsa('script[type="application/ld+json"]');
      for(const n of nodes){
        const txt = n.textContent || '';
        if(!txt) continue;
        const data = JSON.parse(txt);
        const arr = Array.isArray(data)?data:[data];
        for(const obj of arr){
          const name = obj?.name || obj?.headline || (obj?.itemListElement && obj.itemListElement[0]?.name);
          if (typeof name === 'string' && name.trim().length>1) return cleanTitle(name);
        }
      }
    }catch{}
    return null;
  }
  function guessTitle(){
    dlog('guessTitle: start');
    const provider = getProviderForHost(location.hostname);
    if (provider && provider.detectTitle) {
      const t = provider.detectTitle(document, location);
      if (t && t.trim().length > 1) {
        dlog('guessTitle: provider returned →', t);
        return preferExactTitle(t);
      }
    }

    // Try exact document.title first (no aggressive cleaning) to keep season/part tokens
    if (document.title && document.title.trim().length > 1) {
      const dt = preferExactTitle(document.title);
      if (dt) { dlog('guessTitle: exact document.title →', dt); return dt; }
    }

    // fallback to existing logic
    const ogSlug = fromOgUrlSlug();
    if (ogSlug) { dlog('guessTitle: ogSlug →', ogSlug); return titleCase(ogSlug); }
    const ld = parseJSONLDName();
    if (ld) { dlog('guessTitle: JSON-LD →', ld); return ld; }

    const cand = [
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
    ]
    .filter(Boolean)
    .map(cleanTitle)
    .filter(Boolean);

    if (cand.length) return cand[0];

    const parts = location.pathname.split('/').filter(Boolean);
    const prefixes = new Set(['watch','anime','series','stream','show']);
    let slug = parts[0] || '';
    if (slug && prefixes.has(slug.toLowerCase()) && parts[1]) slug = parts[1];
    // Expand short season markers in slug (e.g., "-s2" -> "Season 2")
    if (/\bs\d{1,2}\b/i.test(slug)){
      const sn = parseInt(slug.match(/\bs(\d{1,2})\b/i)[1], 10);
      const base = slug.replace(/\bs\d{1,2}\b/i,'').replace(/-+/g,' ').trim();
      dlog('guessTitle: path slug →', `${base} Season ${sn}`);
      return titleCase(`${base} Season ${sn}`);
    }
    dlog('guessTitle: path slug →', slug);
    return slugToTitle(slug);
  }

  function parseEpFromUrlString(s){
    if (!s) return null;
    let m = s.match(/[?&#](?:ep|episode)=([0-9]+)/i);
    if (m) return parseInt(m[1],10);
    m = s.match(/(?:^|\/)(?:ep|episode|e)[-_]?(\d{1,4})(?:[^0-9]|$)/i);
    if (m) return parseInt(m[1],10);
    m = s.match(/\/(\d{1,4})(?:[^0-9]|$)/);
    if (m) return parseInt(m[1],10);
    return null;
  }
  function guessEpisode(){
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
  async function ensureFreshToken(){
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
  async function malSearch(query){
    const url = MAL_SEARCH + '?q=' + encodeURIComponent(query)
      + '&limit=50&nsfw=true&fields='
      + encodeURIComponent('id,title,alternative_titles,media_type,num_episodes,start_date,end_date');
    try {
      const res = await new Promise((resolve) => {
        gm.xmlHttpRequest({
          method: 'GET',
          url,
          headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID },
          onload: (r)=>{ try { resolve(JSON.parse(r.responseText)); } catch { resolve(null); } },
          onerror: ()=> resolve(null)
        });
      });
      return res;
    } catch { return null; }
  }
  async function updateMyListEpisodes(malAnimeId, watchedEp){
    const token = await ensureFreshToken();
    const url = `https://api.myanimelist.net/v2/anime/${encodeURIComponent(malAnimeId)}/my_list_status`;
    const body = encodeForm({ num_watched_episodes: watchedEp });
    const res = await xhr('PATCH', url, { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    return res;
  }
  async function getMyListStatus(malAnimeId){
    const token = await ensureFreshToken();
    const base = `https://api.myanimelist.net/v2/anime/${encodeURIComponent(malAnimeId)}`;

    const gmGet = (url, headers) => new Promise((resolve) => {
      gm.xmlHttpRequest({
        method: 'GET',
        url,
        headers,
        onload: (r) => {
          let body = null;
          try { body = r.responseText ? JSON.parse(r.responseText) : null; } catch {}
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
      return resp.body;
    }

    // Try 2: same endpoint but add X-MAL-CLIENT-ID as a nudge
    if (!resp.body || !(resp.body.status || typeof resp.body.num_watched_episodes === 'number')) {
      resp = await gmGet(`${base}/my_list_status`, { 'Authorization': `Bearer ${token}`, 'X-MAL-CLIENT-ID': MAL_CLIENT_ID, 'Accept': 'application/json' });
      if (resp.body && (resp.body.status || typeof resp.body.num_watched_episodes === 'number' || typeof resp.body.num_episodes_watched === 'number')) {
        if (typeof resp.body.num_watched_episodes !== 'number' && typeof resp.body.num_episodes_watched === 'number') {
          resp.body.num_watched_episodes = resp.body.num_episodes_watched;
        }
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
      return st;
    }

    // Not in list or unavailable
    dlog('getMyListStatus: no list status available; maybe not in list yet');
    return null;
  }
  async function setMyStatusWatching(malAnimeId){
    const token = await ensureFreshToken();
    const url = `https://api.myanimelist.net/v2/anime/${encodeURIComponent(malAnimeId)}/my_list_status`;
    const body = encodeForm({ status: 'watching' });
    const res = await xhr('PATCH', url, { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    return res;
  }

  // ---- Site list & mapping ----
  async function seedSitesOnce(){
    try{
      const already = await gm.getValue(STORAGE.seeded, '');
      if (already) return;
      const set = new Set(await getJSON(STORAGE.sites, []));
      for (const h of SEEDED_HOSTS) set.add(h);
      await setJSON(STORAGE.sites, Array.from(set));
      await gm.setValue(STORAGE.seeded, '1');
    }catch{}
  }
  async function ensureHostInSites(host){
    try{
      const set = new Set(await getJSON(STORAGE.sites, []));
      if (SEEDED_HOSTS.has(host) && !set.has(host)) {
        set.add(host);
        await setJSON(STORAGE.sites, Array.from(set));
      }
    }catch{}
  }
  async function isSiteEnabled(host){
    try{ const set = new Set(await getJSON(STORAGE.sites, [])); return set.has(host); }
    catch{ return false; }
  }
  async function addSite(host){
    try{
      const set = new Set(await getJSON(STORAGE.sites, []));
      set.add(host);
      await setJSON(STORAGE.sites, Array.from(set));
      await updateBubble();
    }catch{}
  }

  async function getMap(key){
    try{
      const m = await getJSON(STORAGE.maps, {});
      const v = m[key];
      if (!v) return null;
      if (typeof v === 'number') return { id: v, title: '' };
      return v;
    }catch{ return null; }
  }
  async function setMap(key, malId, malTitle){
    try{
      const m = await getJSON(STORAGE.maps, {});
      m[key] = { id: malId, title: malTitle || '' };
      await setJSON(STORAGE.maps, m);
      toast(`Mapped → ${malTitle || ('#'+malId)}`);
      await renderPanel();
    }catch{}
  }

  function getSeriesKey(){
    const host = location.host.replace(/^www\./i,'').toLowerCase();
    dlog('getSeriesKey: start host=', host);
    if (isHomePage()) { dlog('getSeriesKey: homepage → unresolved'); return host + '|unresolved'; }
    // 1) Prefer canonical from og:url if available
    const og = (function(){ try { return qs('meta[property="og:url"]')?.content || qs('meta[name="twitter:url"]')?.content; } catch { return ''; } })();
    dlog('getSeriesKey: og url =', og);
    let slug = '';
    if (og) {
      try {
        const u = new URL(og);
        slug = extractSeriesSlugFromPath(u.pathname);
        dlog('getSeriesKey: slug from og =', slug);
      } catch {}
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
        slug = t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
      }
      dlog('getSeriesKey: slug after title fallback =', slug);
    }

    // 3) Provider-specific tail cleanup (e.g., HiAnime numeric tails)
    const provider = getProviderForHost(host);
    if (provider) slug = slug.replace(/-\d{3,}$/,'');

    // 4) Final normalization
    slug = (slug||'').toLowerCase();
    if (!slug) slug = 'unresolved';
    dlog('getSeriesKey: final key =', host + '|' + slug);
    return host + '|' + slug;
  }
  function pickBestMatch(data, guess){
    if (!data || !data.length) return null;
    const gRaw = guess || '';
    const gNorm = normalizeCmp(gRaw);

    function score(node){
      const all = titlesOf(node);
      if (!all.length) return -1;
      let best = -1;
      const gTokens = new Set(normalizeCmp(gRaw).split(' ').filter(Boolean));
      for (const t of all){
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
          // Prefer TV series strongly, lightly prefer ONA, penalize movies/specials/OVA
          if (node.media_type === 'tv') s += 14;
          else if (node.media_type === 'ona') s += 3;
          else if (node.media_type === 'ova' || node.media_type === 'special' || node.media_type === 'movie') s -= 35;

          // Length bias
          if (typeof node.num_episodes === 'number') {
            if (node.num_episodes >= 100) s += 30;
            else if (node.num_episodes >= 50) s += 15;
            else if (node.num_episodes <= 20) s -= 15;
            else if (node.num_episodes <= 5)  s -= 25;
          }

          // Franchise base with discriminators for both guess and candidate titles
          const gBase = baseFranchiseWithDiscriminators(gRaw);
          if (gBase) {
            const candBases = titlesOf(node).map(baseFranchiseWithDiscriminators).filter(Boolean);
            const baseHit = candBases.some(b => b === gBase);
            if (baseHit) {
              if (node.media_type === 'tv') s += 40;
              if (typeof node.num_episodes === 'number' && node.num_episodes >= 100) s += 25;
              if (node.media_type === 'movie' || node.media_type === 'special' || node.media_type === 'ova') s -= 40;

              // Soft priors: prefer TV and ensure min episodes if declared
              const pr = priorFor(gBase);
              if (pr) {
                if (pr.prefer === 'tv') {
                  if (node.media_type === 'tv') s += 20; else s -= 20;
                }
                if (typeof pr.minEpisodes === 'number' && typeof node.num_episodes === 'number') {
                  if (node.num_episodes >= pr.minEpisodes) s += 20;
                  else s -= 15;
                }
              }
            }
          }
        }
        // If the exact guess likely refers to a TV season (contains 'season'/'cour' or a number), penalize movie/ova/special harder
        if (/\b(season|cour|part)\b|\b\d{1,2}\b/.test(gRaw.toLowerCase())) {
          if (node.media_type === 'movie' || node.media_type === 'special' || node.media_type === 'ova') s -= 20;
        }
        best = Math.max(best, s);
      }
      return best;
    }
    let bestNode = null, bestScore = -1;
    let secondBest = -1;
    for (const x of data){
      const node = x.node || x;
      const s = score(node);
      if (s > bestScore){ secondBest = bestScore; bestScore = s; bestNode = node; }
      else if (s > secondBest){ secondBest = s; }
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
    } catch(_) {}
    return bestNode || (data[0] && (data[0].node || data[0])) || null;
  }
  async function ensureAutoMappingIfNeeded(){
    dlog('ensureAutoMappingIfNeeded: start');
    if (isHomePage()) { dlog('ensureAutoMappingIfNeeded: homepage → skip'); return null; }
    const key = getSeriesKey();
    const mapped = await getMap(key);
    dlog('ensureAutoMappingIfNeeded: key=', key, 'mapped=', mapped);
    if (mapped && mapped.id) return mapped;
    const guess = guessTitle();
    dlog('ensureAutoMappingIfNeeded: guess=', guess);
    // If we already learned a canonical id for this franchise, try to reuse it directly
    const base = baseFranchise(guess||'');
    if (base) {
      try {
        const canon = await getCanonMap();
        const canonId = canon[base];
        if (canonId) {
          dlog('ensureAutoMappingIfNeeded: using learned canon for', base, '→', canonId);
          await setMap(key, canonId, guess);
          return { id: canonId, title: guess };
        }
      } catch(_) {}
    }
    if (!guess || guess.length < 2) return null;
    let picked = null, data = [];
    // Search order: exact title first, then relaxed variants
    const cands = [preferExactTitle(guess), ...seasonVariants(guess)];
    dlog('ensureAutoMappingIfNeeded: cands=', cands);
    for (const q of cands){
      const res = await malSearch(q);
      data = (res && res.data) || [];
      dlog('ensureAutoMappingIfNeeded: search q=', q, 'results=', data && data.length);
      if (!data.length) continue;

      picked = pickBestMatch(data, q);
      const conf = (pickBestMatch._last && pickBestMatch._last.bestScore) || -1;
      const gap  = (pickBestMatch._last && pickBestMatch._last.secondBest != null)
                   ? (pickBestMatch._last.bestScore - pickBestMatch._last.secondBest)
                   : -1;
      dlog('ensureAutoMappingIfNeeded: bestScore=', conf, 'gap=', gap);

      // Accept only if clearly ahead; otherwise try next variant
      if (conf >= 125 && gap >= 35) break;
      // If nothing else left, keep this as fallback
    }
    if (picked) dlog('ensureAutoMappingIfNeeded: picked=', picked && {id:picked.id, title:picked.title});
    if (!picked){ toast('Title not found. Use search to map.'); return null; }
    await setMap(key, picked.id, picked.title);
    return { id: picked.id, title: picked.title };
  }

  // ---- Bubble logic ----
  function isMAL(){ return location.hostname === 'myanimelist.net'; }
  async function updateBubble(){
    if (!bubble) return;
    const host = location.hostname;
    let enabled = false;
    try { enabled = await isSiteEnabled(host); } catch {}
    const show = isMAL() || enabled || (isAnimeyPage() && !isHomePage());
    bubble.style.display = show ? 'flex' : 'none';
    bubble.classList.toggle('disabled', !enabled && !isMAL());
    bubble.title = isMAL() ? 'AnimeTrack — MyAnimeList' :
      (enabled ? 'AnimeTrack — click to open/close' : 'AnimeTrack — click to open, enable site via panel');
  }

  // ---- Auto OAuth (message from oauth.html) ----
  window.addEventListener('message', async (ev) => {
    try {
      const okOrigin = /:\/\/shaharaviram1\.github\.io$/i.test(ev.origin);
      if (!okOrigin) return;
      const data = ev.data || {};
      if (data.source === 'animetrack-oauth' && data.code) {
        // Verify OAuth state to prevent mismatched/tabbed flows
        try {
          const savedState = await gm.getValue(STORAGE.oauthState, '');
          const incomingState = (typeof data.state === 'string') ? data.state : '';
          if (savedState && incomingState && incomingState !== savedState) {
            await gm.setValue(STORAGE.oauthErr, 'State mismatch');
            toast('OAuth failed: state mismatch');
            return;
          }
        } catch (_) {}
        console.debug('[AnimeTrack] Received OAuth code via postMessage');
        // Ack receipt back to oauth.html so it knows we heard it
        try {
          if (ev.source && ev.origin) {
            ev.source.postMessage({ source: 'animetrack-ack', received: true }, ev.origin);
          }
        } catch(_) {}
        await getSettings(); // ensure MAL_CLIENT_ID / MAL_REDIRECT_URI loaded
        const code = String(data.code);
        let verifier = sessionStorage.getItem('animetrack_pkce_verifier');
        if (!verifier) { try { verifier = await gm.getValue(STORAGE.pkceVer, ''); } catch(_) { verifier = ''; } }
        if (!verifier) { throw new Error('Missing PKCE verifier'); }
        const payload = { code, code_verifier: verifier, redirect_uri: MAL_REDIRECT_URI };
        try {
          const res = await xhr('POST', `${WORKER_URL}/token`, { 'Content-Type': 'application/json' }, JSON.stringify(payload));
          if (res && res.access_token) {
            await setTokens(res.access_token, res.refresh_token || '', res.expires_in);
            await gm.setValue(STORAGE.oauthErr, '');
            toast('Connected to MAL');
            console.debug('[AnimeTrack] OAuth success');
            await renderPanel();
            try {
              if (ev.source && ev.origin) {
                ev.source.postMessage({ source: 'animetrack-connected', ok: true }, ev.origin);
              }
            } catch (_) { }
          } else {
            const msg = 'OAuth exchange failed';
            await gm.setValue(STORAGE.oauthErr, msg);
            toast(msg);
            console.warn('[AnimeTrack]', msg);
          }
        } catch(e) {
          const tmsg = 'OAuth failed: ' + (e && e.message || e);
          await gm.setValue(STORAGE.oauthErr, String(tmsg));
          toast(tmsg);
          console.warn('[AnimeTrack] token error', tmsg);
        } finally {
          sessionStorage.removeItem('animetrack_pkce_verifier');
          try { await gm.setValue(STORAGE.pkceVer, ''); } catch(_){}
          try { await gm.setValue(STORAGE.oauthState, ''); } catch(_){}
        }
      }
    } catch(e){ console.warn('[AnimeTrack] postMessage handler error', e); }
  });

  // ---- Settings / Panel ----
  async function getSettings(){
    const s = await getJSON(STORAGE.settings, {});
    if (s.redirect_uri) MAL_REDIRECT_URI = s.redirect_uri;
    const pk = (typeof s.pkce_plain === 'boolean') ? s.pkce_plain : false;
    return { client_id: MAL_CLIENT_ID, redirect_uri: MAL_REDIRECT_URI, pkce_plain: pk };
  }
  async function saveSettings(obj){
    const cur = await getJSON(STORAGE.settings, {});
    const nx = Object.assign({}, cur, obj||{});
    await setJSON(STORAGE.settings, nx);
    if (nx.redirect_uri) MAL_REDIRECT_URI = nx.redirect_uri;
    if (typeof nx.pkce_plain === 'boolean') { /* persisted; runtime read via getSettings() */ }
  }

  async function renderPanel(){
    if (!panel) return;
    const card = panel.querySelector('#at-card');
    await getSettings();
    const host = location.hostname;
    const token = await getToken();
    const authed = !!token;
    const onMAL = isMAL();
    const enabled = onMAL ? true : await isSiteEnabled(host);
    const onHome = isHomePage();
    if (onHome && !onMAL) {
      card.innerHTML = `
        <div class="title">AnimeTrack</div>
        <div class="row"><span class="sub">Tip:</span><span>Open an episode page to detect the show.</span></div>
      `;
      return;
    }
    const seriesKey = onHome ? (location.host.replace(/^www\./i,'').toLowerCase() + '|unresolved') : getSeriesKey();
    const mapped = (onMAL || onHome) ? null : (await getMap(seriesKey) || await ensureAutoMappingIfNeeded());
    const epGuess = (onMAL || onHome) ? null : guessEpisode();

    // Fetch status BEFORE computing alreadyWatched to avoid TDZ/undefined issues
    let myStatus = null; let watchedCount = null; let needsWatching = false;
    if (authed && mapped && mapped.id) {
      try {
        myStatus = await getMyListStatus(mapped.id);
        if (myStatus) {
          if (typeof myStatus.num_watched_episodes === 'number') watchedCount = myStatus.num_watched_episodes;
          else if (typeof myStatus.num_episodes_watched === 'number') watchedCount = myStatus.num_episodes_watched;
        }
        const st = (myStatus && myStatus.status) || '';
        if (!st || (st.toLowerCase && st.toLowerCase() !== 'watching')) needsWatching = true;
      } catch(_) {}
    }

    const alreadyWatched = (authed && mapped && mapped.id && watchedCount != null && epGuess != null && Number(epGuess) <= Number(watchedCount));
    const mappedLine = mapped && mapped.id ? `${mapped.title || 'Mapped'} (#${mapped.id})` : '—';
    const lastErr = await gm.getValue(STORAGE.oauthErr, '');

    const statusText = (authed && mapped && mapped.id) ? ((myStatus && myStatus.status) ? myStatus.status : 'Not in list') : '—';
    const watchedText = (authed && mapped && typeof watchedCount === 'number') ? String(watchedCount) : '—';

    card.innerHTML = `
      <div class="title">AnimeTrack</div>

      ${!enabled && !onMAL ? `
      <div class="row">
        <span class="sub">This site is disabled.</span>
        <div style="flex:1"></div>
        <button id="at-enable" class="primary">Enable here</button>
      </div>` : ``}

      <div class="row">
        <span class="sub">${authed ? 'Connected to MAL ✅' : 'Not connected ❌'}</span>
        <div style="flex:1"></div>
        <button id="at-auth" class="${authed ? 'ghost' : 'primary'}">${authed ? 'Re-connect' : 'Connect MAL'}</button>
        ${authed ? '<button id="at-disc" class="ghost">Disconnect</button>' : '<button id="at-copy" class="ghost">Copy Auth Link</button>'}
        ${authed ? '' : '<button id="at-paste" class="ghost">Paste Code</button>'}
      </div>
        
      ${!authed && lastErr ? `<div class="row"><span class="sub" style="color:#ffb3b3">Last error: ${lastErr}</span></div>` : ''}

      ${!onMAL ? `
      <div class="row">
        <span class="sub">Mapped:</span>
        <span class="sub" id="at-map">${mappedLine}</span>
        <div style="flex:1"></div>
        <button id="at-unmap" class="ghost"${mapped && mapped.id ? '' : ' disabled'}>Clear</button>
      </div>` : ``}
      
      ${(!onMAL && authed && mapped && mapped.id) ? `
      <div class="row">
        <span class="sub">Status:</span>
        <span class="sub" id="at-statline">${statusText}</span>
        <div style="flex:1"></div>
        ${needsWatching ? '<button id="at-setwatch" class="primary">Set to Watching</button>' : ''}
      </div>
      <div class="row">
        <span class="sub">Watched:</span>
        <span class="sub" id="at-wcount">${watchedText}</span>
      </div>
      ` : ``}

      ${(!onMAL && (!mapped || !mapped.id)) ? `
      <div class="row">
        <input id="at-query" placeholder="Search MAL title…" style="flex:1">
        <button id="at-search" class="ghost">Search</button>
      </div>
      <div id="at-results" class="list" style="display:none"></div>
      ` : ``}

      ${!onMAL ? `
      <div class="row">
        <span class="sub">Episode:</span>
        <input id="at-ep" type="number" min="0" step="1" value="${epGuess ?? ''}" placeholder="ep">
        <button id="at-mark" class="ghost" ${alreadyWatched ? 'disabled' : ''}>${alreadyWatched ? 'Already watched ✓' : 'Mark watched'}</button>
      </div>` : ``}

      ${onMAL ? `
      <div class="row">
        <input id="at-addhost" placeholder="Add site (hostname, e.g. hianime.to)" style="flex:1">
        <button id="at-addbtn" class="primary">Add site</button>
      </div>` : ``}

      <div class="row">
        <details>
          <summary class="sub">Settings</summary>
          <div class="sub hint">Client ID is fixed in the script. You can change the Redirect URI if needed.</div>
          <div class="row" style="margin-top:8px">
            <input id="at-client" placeholder="MAL Client ID" style="flex:1">
            <button id="at-save-client" class="ghost">Save</button>
          </div>
          <div class="row">
            <input id="at-redirect" placeholder="Redirect URI (default: https://shaharaviram1.github.io/AnimeTrack/oauth.html)" style="flex:1">
            <button id="at-save-redirect" class="ghost">Save</button>
          </div>
          <div class="row">
            <label class="sub" style="min-width:130px">PKCE method</label>
            <select id="at-pkce" style="flex:1">
              <option value="S256">S256 (recommended)</option>
              <option value="plain">plain (legacy)</option>
            </select>
            <button id="at-save-pkce" class="ghost">Save</button>
          </div>
        </details>
      </div>
      <div class="row" style="margin-top:8px">
        <button id="at-status" class="ghost">Check MAL status</button>
        <span class="sub" id="at-status-out"></span>
      </div>
      <div class="row">
        <span class="hint" id="at-diag"></span>
      </div>
    `;

    if (!onMAL && !enabled) {
      card.querySelector('#at-enable').onclick = async () => {
        await addSite(host);
        await updateBubble();
        await renderPanel();
      };
    }

    const s = await getSettings();
    card.querySelector('#at-client').value = MAL_CLIENT_ID;
    card.querySelector('#at-client').disabled = true;
    card.querySelector('#at-redirect').value = s.redirect_uri || 'https://shaharaviram1.github.io/AnimeTrack/oauth.html';
    card.querySelector('#at-save-client').onclick = async () => {
      toast('Client ID is fixed in the script.');
    };
    card.querySelector('#at-save-redirect').onclick = async () => {
      const v = card.querySelector('#at-redirect').value.trim();
      await saveSettings({ redirect_uri: v || 'https://shaharaviram1.github.io/AnimeTrack/oauth.html' });
      toast('Saved Redirect URI');
    };
    // Initialize PKCE method selector
    (async () => {
      const s2 = await getSettings();
      const sel = card.querySelector('#at-pkce');
      if (sel) sel.value = s2.pkce_plain ? 'plain' : 'S256';
      const btn = card.querySelector('#at-save-pkce');
      if (btn && sel) btn.onclick = async () => {
        const plain = sel.value === 'plain';
        await saveSettings({ pkce_plain: plain });
        toast('Saved PKCE method: ' + (plain ? 'plain' : 'S256'));
      };
    })();
    // Diagnostics line (shows effective client & redirect)
    const diag = card.querySelector('#at-diag');
    if (diag) {
      const s3 = await getSettings();
      const pkceMode = s3.pkce_plain ? 'plain' : 'S256';
      diag.textContent = `Diag → client ${MAL_CLIENT_ID.slice(0, 8)}…  redirect ${MAL_REDIRECT_URI}  pkce ${pkceMode}`;
    }

    // Live status check against MAL
    const statusBtn = card.querySelector('#at-status');
    const statusOut = card.querySelector('#at-status-out');
    if (statusBtn) statusBtn.onclick = async () => {
      if (statusOut) statusOut.textContent = 'Checking…';
      try {
        const token = await ensureFreshToken();

        // Helper: GET via GM.xmlHttpRequest to avoid CORS/page-context surprises
        const gmGet = (url, headers) => new Promise((resolve) => {
          gm.xmlHttpRequest({
            method: 'GET',
            url,
            headers,
            onload: (r) => {
              let body = null;
              try { body = r.responseText ? JSON.parse(r.responseText) : null; } catch {}
              resolve({ status: r.status, body, raw: r.responseText || '' });
            },
            onerror: () => resolve({ status: 0, body: null, raw: '' })
          });
        });

        // Try 1: explicit fields=name (Bearer only)
        let resp = await gmGet('https://api.myanimelist.net/v2/users/@me?fields=name', { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });

        // Try 2: without fields
        if (!resp.body || !(resp.body.name || resp.body.id)) {
          resp = await gmGet('https://api.myanimelist.net/v2/users/@me', { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
        }

        // Try 3: with X-MAL-CLIENT-ID header as a nudge
        if (!resp.body || !(resp.body.name || resp.body.id)) {
          resp = await gmGet('https://api.myanimelist.net/v2/users/@me?fields=name', { 'Authorization': `Bearer ${token}`, 'X-MAL-CLIENT-ID': MAL_CLIENT_ID, 'Accept': 'application/json' });
        }

        const me = resp.body;

        if (me && (me.name || me.id)) {
          if (statusOut) statusOut.textContent = `Connected ✓ — ${me.name || ('ID ' + me.id)}`;
          await gm.setValue(STORAGE.oauthErr, '');
        } else if (me && (me.error || me.message || me.error_description)) {
          const m = me.error_description || me.message || me.error || 'Unknown response';
          if (statusOut) statusOut.textContent = `Not connected: ${m}`;
          await gm.setValue(STORAGE.oauthErr, 'OAuth failed: ' + m);
        } else {
          // Show a short diagnostic snippet to help debug quickly
          const snippet = (resp && (resp.raw || JSON.stringify(resp.body))) ? String(resp.raw || JSON.stringify(resp.body)).slice(0, 160) : `HTTP ${resp?.status || '?'} (no body)`;
          if (statusOut) statusOut.textContent = `Connected? No name/ID returned. Resp: ${snippet}`;
          await gm.setValue(STORAGE.oauthErr, 'OAuth: @me returned no name/ID');
        }

        await renderPanel();
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        if (statusOut) statusOut.textContent = 'Not connected: ' + msg;
        await gm.setValue(STORAGE.oauthErr, 'OAuth failed: ' + msg);
        await renderPanel();
      }
    };

    async function buildAuthURL(){
        const verifier = randomString(64);
        sessionStorage.setItem('animetrack_pkce_verifier', verifier);
        try { await gm.setValue(STORAGE.pkceVer, verifier); } catch(_) {}
        const s4 = await getSettings();
        const usePlain = !!s4.pkce_plain;
        const state = Math.random().toString(36).slice(2, 10);
        try { await gm.setValue(STORAGE.oauthState, state); } catch(_) {}
        if (usePlain) {
          const authURL = `${MAL_AUTH_URL}?response_type=code&client_id=${encodeURIComponent(MAL_CLIENT_ID)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(verifier)}&code_challenge_method=plain&redirect_uri=${encodeURIComponent(MAL_REDIRECT_URI)}`;
          return authURL;
        } else {
          const challenge = await pkceS256(verifier);
          const authURL = `${MAL_AUTH_URL}?response_type=code&client_id=${encodeURIComponent(MAL_CLIENT_ID)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(MAL_REDIRECT_URI)}`;
          return authURL;
        }
    }

    card.querySelector('#at-auth').onclick = async () => {
      await getSettings();
      try {
        const url = await buildAuthURL();
        window.open(url, '_blank');
        toast('Complete login in the new tab; it will auto-connect.');
      } catch(e) {
        toast('Failed to build auth URL');
      }
    };

    // Wire up Disconnect button
    const discBtn = card.querySelector('#at-disc');
    if (discBtn) discBtn.onclick = async () => {
      await setTokens('', '');
      await gm.setValue(STORAGE.oauthErr, '');
      toast('Disconnected from MAL');
      await renderPanel();
    };

    const copyBtn = card.querySelector('#at-copy');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          const url = await buildAuthURL();
          await navigator.clipboard.writeText(url);
          toast('Auth link copied. Paste into a new tab to log in.');
        } catch(e) {
          toast('Could not copy link');
        }
      };
    }

    const pasteBtn = card.querySelector('#at-paste');
    if (pasteBtn) {
      pasteBtn.onclick = async () => {
        const code = prompt('Paste the `code` value from the oauth.html URL here:');
        if (!code) return;
        await getSettings();
        try {
            let verifier = sessionStorage.getItem('animetrack_pkce_verifier');
            if (!verifier) { try { verifier = await gm.getValue(STORAGE.pkceVer, ''); } catch(_) { verifier = ''; } }
            if (!verifier) { toast('Missing PKCE verifier — click Connect MAL to generate it, then paste.'); return; }
            const payload = { code, code_verifier: verifier, redirect_uri: MAL_REDIRECT_URI };
            const res = await xhr('POST', `${WORKER_URL}/token`, { 'Content-Type': 'application/json' }, JSON.stringify(payload));
          if (res && res.access_token) {
            await setTokens(res.access_token, res.refresh_token || '', res.expires_in);
            await gm.setValue(STORAGE.oauthErr, '');
            toast('Connected to MAL');
            await renderPanel();
          } else {
            toast('OAuth exchange failed');
          }
        } catch(e) {
          const tmsg = 'OAuth failed: ' + (e && e.message || e);
          await gm.setValue(STORAGE.oauthErr, String(tmsg));
          toast(tmsg);
          console.warn('[AnimeTrack] token error', tmsg);
        } finally {
          sessionStorage.removeItem('animetrack_pkce_verifier');
          try { await gm.setValue(STORAGE.pkceVer, ''); } catch(_){ }
        }
      };
    }

    if (!onMAL) {
      const seriesKey = getSeriesKey();
      const unmapBtn = card.querySelector('#at-unmap');
      if (unmapBtn) unmapBtn.onclick = async () => {
        const m = await getJSON(STORAGE.maps, {});
        delete m[seriesKey];
        await setJSON(STORAGE.maps, m);
        await renderPanel();
      };
      const searchBtn = card.querySelector('#at-search');
      if (searchBtn) {
        searchBtn.onclick = async () => {
          const q = card.querySelector('#at-query').value.trim();
          if (!q) return;
          const out = card.querySelector('#at-results');
          out.style.display = 'block';
          out.innerHTML = '<div class="li sub">Searching…</div>';
          const res = await malSearch(q);
          const data = (res && res.data) || [];
          if (!data.length) { out.innerHTML = '<div class="li sub">No results.</div>'; return; }
          out.innerHTML = data.map(x => `<div class="li" data-id="${x.node.id}" data-title="${(x.node.title||'').replace(/"/g,'&quot;')}">#${x.node.id} — ${x.node.title} <span class="sub">(${x.node.media_type||''})</span></div>`).join('');
          out.querySelectorAll('.li').forEach(li => {
            li.addEventListener('click', async () => {
              const id = Number(li.getAttribute('data-id'));
              const title = li.getAttribute('data-title') || '';
              await setMap(seriesKey, id, title);
            });
          });
        };
      }
      const epInput = card.querySelector('#at-ep');
      if (epInput && !epInput.value) {
        const eg = guessEpisode();
        if (eg) epInput.value = eg;
      }
      const markBtn = card.querySelector('#at-mark');
      if (markBtn) markBtn.onclick = async () => {
        const m = await getMap(seriesKey) || await ensureAutoMappingIfNeeded();
        const ep = Number(card.querySelector('#at-ep').value || 0);
        if (!m || !m.id) return toast('Map this series to a MAL title first.');
        if (!ep) return toast('Enter an episode number.');
        let st = null;
        try { st = await getMyListStatus(m.id); } catch {}
        const stName = (st && st.status) ? String(st.status).toLowerCase() : '';
        const watched = (st && typeof st.num_watched_episodes === 'number') ? st.num_watched_episodes : null;
        if (stName && stName !== 'watching') {
          toast('Set status to "Watching" to enable marking.');
          const btn = card.querySelector('#at-setwatch');
          if (btn) btn.classList.add('primary');
          return;
        }
        if (watched != null && ep <= watched) {
          return toast(`You already have ep ${watched} watched.`);
        }
        try {
          await updateMyListEpisodes(m.id, ep);
          // Refresh watched count immediately
          try {
            const st2 = await getMyListStatus(m.id);
            if (st2 && typeof st2.num_watched_episodes === 'number') {
              const wEl = card.querySelector('#at-wcount');
              if (wEl) wEl.textContent = String(st2.num_watched_episodes);
            }
          } catch {}
          toast('Marked ep ' + ep + ' watched.');
          await renderPanel();
        } catch(e) { toast('Update failed: ' + (e && e.message || e)); }
      };
      const setWatchBtn = card.querySelector('#at-setwatch');
      if (setWatchBtn) setWatchBtn.onclick = async () => {
        const m = await getMap(seriesKey) || await ensureAutoMappingIfNeeded();
        if (!m || !m.id) return toast('Map this series first.');
        try { await setMyStatusWatching(m.id); toast('Status set to Watching'); await renderPanel(); }
        catch(e){ toast('Failed to set status: ' + (e && e.message || e)); }
      };
    } else {
      const addBtn = card.querySelector('#at-addbtn');
      if (addBtn) addBtn.onclick = async () => {
        const val = (card.querySelector('#at-addhost').value || '').trim().toLowerCase();
        if (!val || !/^[a-z0-9.-]+$/.test(val)) { toast('Enter a valid hostname.'); return; }
        await addSite(val);
        toast('Site added: ' + val);
      };
    }
  }

  // ---- Scrobble loop ----
  async function scrobbleLoop(){
    try {
      const host = location.hostname;
      await seedSitesOnce();
      await ensureHostInSites(host);
      await updateBubble();

      let allowed = await isSiteEnabled(host);
      let activeInTop = false;

      if (!isFrame) {
        const vidsTop = qsa('video');
        activeInTop = allowed && vidsTop.length > 0;
      } else {
        const refHost = (function(href){ try{ return new URL(href).hostname; }catch{ return ''; } })(document.referrer);
        if (refHost) allowed = await isSiteEnabled(refHost);
      }
      if (!allowed) return requestAnimationFrame(scrobbleLoop);

      const envOK = (!isFrame && activeInTop) || (isFrame && allowed);
      if (!envOK) return requestAnimationFrame(scrobbleLoop);

      const v = qsa('video').find(x => !x.paused) || qsa('video')[0];
      if (!v) return requestAnimationFrame(scrobbleLoop);

      const pct = v.duration ? (v.currentTime / v.duration) : 0;
      if (pct >= 0.8) {
        const key = getSeriesKey();
        let m = await getMap(key);
        if (!m || !m.id) m = await ensureAutoMappingIfNeeded();
        const ep = guessEpisode() || 1;
        if (m && m.id && !(scrobbleLoop._markedForEp||{})[ep]) {
          try {
            // respect MAL status: require Watching
            try {
              const st = await getMyListStatus(m.id);
              const stName = (st && st.status) ? String(st.status).toLowerCase() : '';
              if (stName && stName !== 'watching') {
                toast('Set status to "Watching" to enable auto-mark.');
                return requestAnimationFrame(scrobbleLoop);
              }
              const watched = (st && typeof st.num_watched_episodes === 'number') ? st.num_watched_episodes : 0;
              if (ep <= watched) return requestAnimationFrame(scrobbleLoop);
            } catch (_) {}
            await updateMyListEpisodes(m.id, ep);
            scrobbleLoop._markedForEp = scrobbleLoop._markedForEp || {};
            scrobbleLoop._markedForEp[ep] = true;
            toast(`Marked ep ${ep} watched on MAL`);
          } catch(e) {
            toast('Scrobble failed: ' + (e && e.message || e));
          }
        }
      }
    } catch(e) {
      try { console.warn('[AnimeTrack] loop error:', e); } catch {}
    }
    requestAnimationFrame(scrobbleLoop);
  }

  // ---- Boot ----
  function boot(){
    const run = () => {
      ensureShell();
      updateBubble();
      if (location.hostname==='myanimelist.net') { panel.style.display='block'; renderPanel(); }
      requestAnimationFrame(scrobbleLoop);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once:true }); else run();
  }
  boot();
})();
