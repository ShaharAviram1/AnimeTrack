// ==UserScript==
// @name         AnimeTrack
// @namespace    https://github.com/ShaharAviram1/AnimeTrack
// @description  Fast anime scrobbler for MAL: auto-map titles, seeded anime sites, MAL OAuth (PKCE S256), auto-mark at 80%, clean Shadow-DOM UI.
// @version      1.3.4
// @author       Shahar Aviram
// @license      GPL-3.0
// @homepageURL  https://github.com/ShaharAviram1/AnimeTrack
// @supportURL   https://github.com/ShaharAviram1/AnimeTrack/issues
// @updateURL    https://cdn.jsdelivr.net/gh/ShaharAviram1/AnimeTrack@latest/animeTrack.meta.js
// @downloadURL  https://cdn.jsdelivr.net/gh/ShaharAviram1/AnimeTrack@v1.3.4/AnimeTrack.user.js
// @run-at       document-start
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
// @match        *://*/*
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
  try { console.debug('[AnimeTrack] booting…', location.href); } catch {}

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

  // ---- Constants ----
  let MAL_CLIENT_ID = '10093a3f9f0174b6b5577c40e9accdae';
  let MAL_REDIRECT_URI = 'https://shaharaviram1.github.io/AnimeTrack/oauth.html';
  const MAL_AUTH_URL  = 'https://myanimelist.net/v1/oauth2/authorize';
  const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
  const MAL_SEARCH    = 'https://api.myanimelist.net/v2/anime';
  const STORAGE = {
    access: 'animetrack.malToken',
    refresh: 'animetrack.malRefresh',
    sites:   'animetrack.sites',
    maps:    'animetrack.seriesMaps',
    seeded:  'animetrack.seeded',
    settings:'animetrack.settings',
    oauthErr:'animetrack.oauthErr'
  };
  const SEEDED_HOSTS = new Set([
    '9anime.to','aniwatch.to','aniwatchtv.to','gogoanime.dk','gogoanime.fi','gogoanimehd.to','hianime.to','hianime.tv','zoro.to'
  ]);

  // ---- Utils ----
  const qsa = (s, r=document) => Array.from(r.querySelectorAll(s));
  const qs = (s, r=document) => r.querySelector(s);
  const isFrame = (window.top !== window.self);
  function norm(s){ return (s||'').replace(/\s+/g,' ').trim(); }
  function encodeForm(obj){ return Object.keys(obj).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`).join('&'); }
  function titleCase(s){ return (s||'').split(' ').map(w => w ? (w[0].toUpperCase()+w.slice(1)) : w).join(' '); }

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
    if (root || isFrame) return;
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

    try {
      domObs = new MutationObserver(() => updateBubble());
      domObs.observe(document.documentElement, {childList:true, subtree:true});
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

  // ---- Storage helpers ----
  async function getJSON(key, fallback){ try { const raw = await gm.getValue(key, ''); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
  async function setJSON(key, val){ try { return gm.setValue(key, JSON.stringify(val)); } catch { return; } }
  async function getToken(){ return (await gm.getValue(STORAGE.access,'')) || ''; }
  async function getRefresh(){ return (await gm.getValue(STORAGE.refresh,'')) || ''; }
  async function setTokens(access, refresh){ await gm.setValue(STORAGE.access, access||''); if (refresh!==undefined) await gm.setValue(STORAGE.refresh, refresh||''); }

  // ---- Network helpers ----
  function xhr(method, url, headers={}, data=null){
    return new Promise((resolve, reject) => {
      if (!gm.xmlHttpRequest) return reject(new Error('No GM.xmlHttpRequest'));
      gm.xmlHttpRequest({
        method, url, headers, data,
        onload: (r) => {
          let json = null;
          try { json = r.responseText ? JSON.parse(r.responseText) : null; } catch {}
          const ok = r.status >= 200 && r.status < 300;
          if (ok) resolve(json);
          else {
            const msg = (json && (json.error || json.message || JSON.stringify(json))) || `HTTP ${r.status}`;
            reject(new Error(msg));
          }
        },
        onerror: () => reject(new Error('Network error'))
      });
    });
  }

  // ---- Title/Episode heuristics ----
  function cleanTitle(t){
    t = norm(t);
    if (!t) return t;
    t = t.replace(/^watch\s+/i, '');
    t = t.replace(/\b(episode|ep)\s*\d+\b/ig, '');
    t = t.replace(/\[[^\]]*\]/g, '').replace(/\([^\)]*\)/g, '');
    t = t.replace(/-\s*(watch\s*online|anime|official site).*$/i, '');
    t = t.replace(/\s{2,}/g, ' ').trim();
    return t.trim();
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
    const ogSlug = fromOgUrlSlug();
    if (ogSlug) return titleCase(ogSlug);
    const ld = parseJSONLDName();
    if (ld) return ld;
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
    ].filter(Boolean).map(cleanTitle).map(norm).filter(Boolean);
    for (const c of cand) { if (c && c.length > 1) return c; }
    const parts = location.pathname.split('/').filter(Boolean);
    const prefixes = new Set(['watch','anime','series','stream','show']);
    let slug = parts[0] || '';
    if (slug && prefixes.has(slug.toLowerCase()) && parts[1]) slug = parts[1];
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
    const epQ = parseEpFromUrlString(location.href);
    if (epQ) return epQ;
    const og = qs('meta[property="og:url"]')?.content || qs('meta[name="twitter:url"]')?.content;
    const epOg = parseEpFromUrlString(og||'');
    if (epOg) return epOg;

    const hiActive = qs('a.ep-item.active, .ep-item.active a, .list-episode a.active, .detail-infor-content .active.episode, .ss-list a.active');
    if (hiActive){
      const numAttr = hiActive.getAttribute('data-number') || hiActive.dataset?.number;
      if (/^\d+$/.test(numAttr||'')) return parseInt(numAttr,10);
      const href = hiActive.getAttribute('href') || '';
      const viaHref = parseEpFromUrlString(href);
      if (viaHref) return viaHref;
      const t = hiActive.textContent || '';
      const m = t.match(/(\d{1,4})/);
      if (m) return parseInt(m[1],10);
    }
    const act = Array.from(document.querySelectorAll('[aria-current="page"],[aria-current="true"],.active,.current'));
    for (const el of act) {
      const t = el.textContent || '';
      const m = t.match(/\b(?:ep|episode)?\s*(\d{1,4})\b/i);
      if (m) return parseInt(m[1],10);
    }
    return null;
  }

  // ---- MAL API wrappers ----
  async function ensureFreshToken(){
    const access = await getToken();
    if (access) return access;
    const refresh = await getRefresh();
    if (!refresh) throw new Error('Not authenticated');
    const payload = encodeForm({ client_id: MAL_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refresh });
    const res = await xhr('POST', MAL_TOKEN_URL, { 'Content-Type': 'application/x-www-form-urlencoded' }, payload);
    if (!res || !res.access_token) throw new Error('Refresh failed');
    await setTokens(res.access_token, res.refresh_token || '');
    return res.access_token;
  }
  async function malSearch(query){
    const url = MAL_SEARCH + '?q=' + encodeURIComponent(query) + '&limit=8&fields=id,title,mean,media_type,alternative_titles';
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
    const {host, pathname} = location;
    const parts = pathname.split('/').filter(Boolean);
    const prefixes = new Set(['watch','anime','series','stream','show']);
    let slug = parts[0] || '';
    if (slug && prefixes.has(slug.toLowerCase()) && parts[1]) slug = parts[1];
    slug = slug.replace(/-episode-?\d+.*$/i, '').replace(/-ep-?\d+.*$/i, '').replace(/-\d+$/i, '');
    return host + '|' + slug;
  }
  function pickBestMatch(data, guess){
    if (!data || !data.length) return null;
    const g = (guess||'').toLowerCase();
    let exact = data.find(x => (x.node.title||'').toLowerCase() === g);
    if (exact) return exact.node;
    let starts = data.find(x => (x.node.title||'').toLowerCase().startsWith(g));
    if (starts) return starts.node;
    let contains = data.find(x => (x.node.title||'').toLowerCase().includes(g));
    if (contains) return contains.node;
    return data[0].node;
  }
  async function ensureAutoMappingIfNeeded(){
    const key = getSeriesKey();
    const mapped = await getMap(key);
    if (mapped && mapped.id) return mapped;
    const guess = guessTitle();
    if (!guess || guess.length < 2) return null;
    const res = await malSearch(guess);
    const data = (res && res.data) || [];
    if (!data.length) { toast('Title not found. Use search to map.'); return null; }
    const picked = pickBestMatch(data, guess);
    if (!picked) return null;
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
    const show = isMAL() || enabled || SEEDED_HOSTS.has(host) || isAnimeyPage();
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
        console.debug('[AnimeTrack] Received OAuth code via postMessage');
        // Ack receipt back to oauth.html so it knows we heard it
        try {
          if (ev.source && ev.origin) {
            ev.source.postMessage({ source: 'animetrack-ack', received: true }, ev.origin);
          }
        } catch(_) {}
        await getSettings(); // ensure MAL_CLIENT_ID / MAL_REDIRECT_URI loaded
        const code = String(data.code);
        const verifier = sessionStorage.getItem('animetrack_pkce_verifier') || code;
        const payload = encodeForm({ client_id: MAL_CLIENT_ID, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: MAL_REDIRECT_URI });
        try {
          const res = await xhr('POST', MAL_TOKEN_URL, { 'Content-Type': 'application/x-www-form-urlencoded' }, payload);
          if (res && res.access_token) {
            await setTokens(res.access_token, res.refresh_token || '');
            await gm.setValue(STORAGE.oauthErr, '');
            toast('Connected to MAL');
            console.debug('[AnimeTrack] OAuth success');
            await renderPanel();
            try {
              if (ev.source && ev.origin) {
                ev.source.postMessage({ source: 'animetrack-connected', ok: true }, ev.origin);
              }
            } catch(_) {}
          } else {
            const msg = 'OAuth exchange failed';
            await gm.setValue(STORAGE.oauthErr, msg);
            toast(msg);
            console.warn('[AnimeTrack]', msg);
          }
        } catch(e) {
          const msg = 'OAuth failed: ' + (e && e.message || e);
          await gm.setValue(STORAGE.oauthErr, String(msg));
          toast(msg);
          console.warn('[AnimeTrack]', msg);
        } finally {
          sessionStorage.removeItem('animetrack_pkce_verifier');
        }
      }
    } catch(e){ console.warn('[AnimeTrack] postMessage handler error', e); }
  });

  // ---- Settings / Panel ----
  async function getSettings(){
    const s = await getJSON(STORAGE.settings, {});
    if (s.client_id) MAL_CLIENT_ID = s.client_id;
    if (s.redirect_uri) MAL_REDIRECT_URI = s.redirect_uri;
    return { client_id: MAL_CLIENT_ID, redirect_uri: MAL_REDIRECT_URI };
  }
  async function saveSettings(obj){
    const cur = await getJSON(STORAGE.settings, {});
    const nx = Object.assign({}, cur, obj||{});
    await setJSON(STORAGE.settings, nx);
    if (nx.client_id) MAL_CLIENT_ID = nx.client_id;
    if (nx.redirect_uri) MAL_REDIRECT_URI = nx.redirect_uri;
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
    const seriesKey = getSeriesKey();
    const mapped = onMAL ? null : (await getMap(seriesKey) || await ensureAutoMappingIfNeeded());
    const epGuess = onMAL ? null : guessEpisode();
    const mappedLine = mapped && mapped.id ? `${mapped.title || 'Mapped'} (#${mapped.id})` : '—';
    const lastErr = await gm.getValue(STORAGE.oauthErr, '');

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
        <button id="at-auth" class="${authed ? 'ghost':'primary'}">${authed ? 'Re-connect' : 'Connect MAL'}</button>
        ${authed ? '' : '<button id="at-copy" class="ghost">Copy Auth Link</button>'}
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
        <button id="at-mark" class="ghost">Mark watched</button>
      </div>` : ``}

      ${onMAL ? `
      <div class="row">
        <input id="at-addhost" placeholder="Add site (hostname, e.g. hianime.to)" style="flex:1">
        <button id="at-addbtn" class="primary">Add site</button>
      </div>` : ``}

      <div class="row">
        <details>
          <summary class="sub">Settings</summary>
          <div class="sub hint">You can set your own MAL Client ID and Redirect URI.</div>
          <div class="row" style="margin-top:8px">
            <input id="at-client" placeholder="MAL Client ID" style="flex:1">
            <button id="at-save-client" class="ghost">Save</button>
          </div>
          <div class="row">
            <input id="at-redirect" placeholder="Redirect URI (default: https://shaharaviram1.github.io/AnimeTrack/oauth.html)" style="flex:1">
            <button id="at-save-redirect" class="ghost">Save</button>
          </div>
        </details>
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
    card.querySelector('#at-client').value = s.client_id || '';
    card.querySelector('#at-redirect').value = s.redirect_uri || 'https://shaharaviram1.github.io/AnimeTrack/oauth.html';
    card.querySelector('#at-save-client').onclick = async () => {
      const v = card.querySelector('#at-client').value.trim();
      await saveSettings({ client_id: v });
      toast('Saved Client ID');
    };
    card.querySelector('#at-save-redirect').onclick = async () => {
      const v = card.querySelector('#at-redirect').value.trim();
      await saveSettings({ redirect_uri: v || 'https://shaharaviram1.github.io/AnimeTrack/oauth.html' });
      toast('Saved Redirect URI');
    };

    async function buildAuthURL(){
      const verifier = randomString(64);
      sessionStorage.setItem('animetrack_pkce_verifier', verifier);
      const challenge = await pkceS256(verifier);
      const state = Math.random().toString(36).slice(2,10);
      const authURL = `${MAL_AUTH_URL}?response_type=code&client_id=${encodeURIComponent(MAL_CLIENT_ID)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(MAL_REDIRECT_URI)}`;
      return authURL;
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
          const verifier = sessionStorage.getItem('animetrack_pkce_verifier') || code;
          const payload = encodeForm({ client_id: MAL_CLIENT_ID, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: MAL_REDIRECT_URI });
          const res = await xhr('POST', MAL_TOKEN_URL, { 'Content-Type': 'application/x-www-form-urlencoded' }, payload);
          if (res && res.access_token) {
            await setTokens(res.access_token, res.refresh_token || '');
            await gm.setValue(STORAGE.oauthErr, '');
            toast('Connected to MAL');
            await renderPanel();
          } else {
            toast('OAuth exchange failed');
          }
        } catch(e) {
          toast('OAuth failed: ' + (e && e.message || e));
        } finally {
          sessionStorage.removeItem('animetrack_pkce_verifier');
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
        try { await updateMyListEpisodes(m.id, ep); toast('Marked ep ' + ep + ' watched.'); }
        catch(e) { toast('Update failed: ' + (e && e.message || e)); }
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