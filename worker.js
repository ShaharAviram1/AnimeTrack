export default {
  async fetch(req, env) {
    // Basic CORS (safe-list your origins)
    const origin = req.headers.get('Origin') || '';
    const allow = (origin === 'https://shaharaviram1.github.io') || (origin.endsWith('.github.io'));
    const baseHeaders = {
      'Access-Control-Allow-Origin': allow ? origin : '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    };

    const url = new URL(req.url);

    // Preflight
    if (req.method === 'OPTIONS') {
      return new Response('', { status: 204, headers: baseHeaders });
    }

    // No-cache proxy for userscript meta (update checks)
    if (url.pathname === '/meta') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: baseHeaders });
      }
      const upstream = 'https://raw.githubusercontent.com/ShaharAviram1/AnimeTrack/main/animeTrack.meta.js';
      const r = await fetch(upstream, {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: { 'Cache-Control': 'no-cache' }
      });
      const metaTxtFull = await r.text();
      const metaLen = String(new TextEncoder().encode(metaTxtFull).length);
      const bodyTxt = (req.method === 'HEAD') ? '' : metaTxtFull;
      const len = (req.method === 'HEAD') ? metaLen : metaLen;
      const now = new Date().toUTCString();
      const mVer = metaTxtFull.match(/@version\s+([^\s]+)/);
      const hashBuf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(metaTxtFull || ''));
      const hashArr = Array.from(new Uint8Array(hashBuf));
      const etag = 'W/"' + hashArr.map(b => b.toString(16).padStart(2,'0')).join('') + '"';
      return new Response(bodyTxt, {
        status: 200,
        headers: {
          ...baseHeaders,
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'Vary': '*',
          'Content-Length': len,
          'Last-Modified': now,
          'ETag': etag,
          'Accept-Ranges': 'bytes',
          'X-Revision': (mVer && mVer[1]) ? mVer[1] : 'unknown'
        }
      });
    }

    // Friendly filename + JS MIME for Safari Userscripts validator
    if (url.pathname === '/AnimeTrack.meta.js') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: baseHeaders });
      }
      const upstream = 'https://raw.githubusercontent.com/ShaharAviram1/AnimeTrack/main/animeTrack.meta.js';
      const r = await fetch(upstream, {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: { 'Cache-Control': 'no-cache' }
      });
      const metaTxtFull = await r.text();
      const metaLen = String(new TextEncoder().encode(metaTxtFull).length);
      const bodyTxt = (req.method === 'HEAD') ? '' : metaTxtFull;
      const len = metaLen;
      const now = new Date().toUTCString();
      const mVer = metaTxtFull.match(/@version\s+([^\s]+)/);
      const hashBuf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(metaTxtFull || ''));
      const hashArr = Array.from(new Uint8Array(hashBuf));
      const etag = 'W/"' + hashArr.map(b => b.toString(16).padStart(2,'0')).join('') + '"';
      return new Response(bodyTxt, {
        status: 200,
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Disposition': 'inline; filename="AnimeTrack.meta.js"',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'Vary': '*',
          'Content-Length': len,
          'Last-Modified': now,
          'ETag': etag,
          'Accept-Ranges': 'bytes',
          'X-Revision': (mVer && mVer[1]) ? mVer[1] : 'unknown'
        }
      });
    }

    // Dynamic downloader: always serves the user.js pointed by the latest meta on main,
    // and avoids recursion if meta's @downloadURL points back to this Worker.
    if (url.pathname === '/download') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: baseHeaders });
      }

      // 1) Fetch latest meta from main
      const metaUrl = 'https://raw.githubusercontent.com/ShaharAviram1/AnimeTrack/main/animeTrack.meta.js';
      const metaResp = await fetch(metaUrl, {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: { 'Cache-Control': 'no-cache' }
      });
      const metaTxt = await metaResp.text();

      // 2) Extract @downloadURL and @version from meta
      const mUrl = metaTxt.match(/@downloadURL\s+([^\s]+)/);
      const mVer = metaTxt.match(/@version\s+([0-9]+\.[0-9]+\.[0-9]+)/);
      if (!mUrl) {
        return new Response('downloadURL not found in meta', { status: 500, headers: baseHeaders });
      }
      const advertised = mUrl[1];
      const version = mVer ? mVer[1] : '';

      // 3) Resolve target: if advertised URL points back to this Worker, construct GitHub tag URL
      const selfOrigin = `${url.protocol}//${url.host}`; // e.g., https://anime-track-oauth.shaharaviram.workers.dev
      let target = advertised;
      if (advertised.startsWith(selfOrigin)) {
        if (version) {
          target = `https://raw.githubusercontent.com/ShaharAviram1/AnimeTrack/v${version}/AnimeTrack.user.js`;
        } else {
          return new Response('Refusing recursive /download without version in meta', { status: 500, headers: baseHeaders });
        }
      }

      // 4) Fetch the actual script at the resolved URL and stream it back
      const scriptResp = await fetch(target, {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (req.method === 'HEAD') {
        const len = scriptResp.headers.get('content-length') || '0';
        return new Response('', {
          status: 200,
          headers: {
            ...baseHeaders,
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Content-Type-Options': 'nosniff',
            'Content-Length': len,
            'Content-Disposition': 'inline; filename="AnimeTrack.user.js"',
            'Last-Modified': new Date().toUTCString(),
            'Accept-Ranges': 'bytes',
            'X-Revision': version || 'unknown'
          }
        });
      } else {
        const txt = await scriptResp.text();
        const len = String(new TextEncoder().encode(txt).length);
        return new Response(txt, {
          status: 200,
          headers: {
            ...baseHeaders,
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Content-Type-Options': 'nosniff',
            'Content-Length': len,
            'Content-Disposition': 'inline; filename="AnimeTrack.user.js"',
            'Last-Modified': new Date().toUTCString(),
            'Accept-Ranges': 'bytes',
            'X-Revision': version || 'unknown',
            'ETag': (await (async()=>{ const hb = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(txt||'')); const ha = Array.from(new Uint8Array(hb)); return 'W/"'+ha.map(b=>b.toString(16).padStart(2,'0')).join('')+'"'; })())
          }
        });
      }
    }

    // Stable filename path for download (some managers require .user.js suffix)
    if (url.pathname === '/AnimeTrack.user.js') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: baseHeaders });
      }

      // 1) Fetch latest meta from main
      const metaUrl = 'https://raw.githubusercontent.com/ShaharAviram1/AnimeTrack/main/animeTrack.meta.js';
      const metaResp = await fetch(metaUrl, {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: { 'Cache-Control': 'no-cache' }
      });
      const metaTxt = await metaResp.text();

      // 2) Extract @downloadURL and @version
      const mUrl = metaTxt.match(/@downloadURL\s+([^\s]+)/);
      const mVer = metaTxt.match(/@version\s+([0-9]+\.[0-9]+\.[0-9]+)/);
      if (!mUrl) {
        return new Response('downloadURL not found in meta', { status: 500, headers: baseHeaders });
      }
      const advertised = mUrl[1];
      const version = mVer ? mVer[1] : '';

      // 3) Resolve target; avoid recursion back to this Worker
      const selfOrigin = `${url.protocol}//${url.host}`;
      let target = advertised;
      if (advertised.startsWith(selfOrigin)) {
        if (version) {
          target = `https://raw.githubusercontent.com/ShaharAviram1/AnimeTrack/v${version}/AnimeTrack.user.js`;
        } else {
          return new Response('Refusing recursive /AnimeTrack.user.js without version in meta', { status: 500, headers: baseHeaders });
        }
      }

      const scriptResp = await fetch(target, {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (req.method === 'HEAD') {
        const len = scriptResp.headers.get('content-length') || '0';
        return new Response('', {
          status: 200,
          headers: {
            ...baseHeaders,
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Content-Type-Options': 'nosniff',
            'Content-Length': len,
            'Content-Disposition': 'inline; filename="AnimeTrack.user.js"',
            'Last-Modified': new Date().toUTCString(),
            'Accept-Ranges': 'bytes',
            'X-Revision': version || 'unknown'
          }
        });
      } else {
        const txt = await scriptResp.text();
        const len = String(new TextEncoder().encode(txt).length);
        return new Response(txt, {
          status: 200,
          headers: {
            ...baseHeaders,
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Content-Type-Options': 'nosniff',
            'Content-Length': len,
            'Content-Disposition': 'inline; filename="AnimeTrack.user.js"',
            'Last-Modified': new Date().toUTCString(),
            'Accept-Ranges': 'bytes',
            'X-Revision': version || 'unknown',
            'ETag': (await (async()=>{ const hb = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(txt||'')); const ha = Array.from(new Uint8Array(hb)); return 'W/"'+ha.map(b=>b.toString(16).padStart(2,'0')).join('')+'"'; })())
          }
        });
      }
    }

    // All other routes require POST with JSON body
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: baseHeaders });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_request', message: 'Invalid JSON' }), {
        status: 400, headers: { ...baseHeaders, 'Content-Type': 'application/json' }
      });
    }

    let form;
    let tokenEndpoint = 'https://myanimelist.net/v1/oauth2/token';

    if (url.pathname === '/token') {
      // Authorization Code → Token
      // Required: code, code_verifier, redirect_uri
      const { code, code_verifier, redirect_uri } = body || {};
      if (!code || !code_verifier || !redirect_uri) {
        return new Response(JSON.stringify({ error: 'invalid_request', message: 'Missing fields' }), {
          status: 400, headers: { ...baseHeaders, 'Content-Type': 'application/json' }
        });
      }
      form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.MAL_CLIENT_ID,
        client_secret: env.MAL_CLIENT_SECRET,
        code,
        code_verifier,
        redirect_uri,
      });
    } else if (url.pathname === '/refresh') {
      // Refresh Token → New Access Token
      // Required: refresh_token
      const { refresh_token } = body || {};
      if (!refresh_token) {
        return new Response(JSON.stringify({ error: 'invalid_request', message: 'Missing refresh_token' }), {
          status: 400, headers: { ...baseHeaders, 'Content-Type': 'application/json' }
        });
      }
      form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.MAL_CLIENT_ID,
        client_secret: env.MAL_CLIENT_SECRET,
        refresh_token,
      });
    } else {
      return new Response('Not Found', { status: 404, headers: baseHeaders });
    }

    const r = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });

    const txt = await r.text();
    // Pass through MAL’s response, but ensure JSON content type
    return new Response(txt, {
      status: r.status,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' }
    });
  }
}