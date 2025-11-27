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
      const upLen = r.headers.get('content-length');
      const bodyTxt = req.method === 'HEAD' ? '' : await r.text();
      const len = req.method === 'HEAD' ? (upLen || '0') : String(new TextEncoder().encode(bodyTxt).length);
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
          'Content-Length': len
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
      const upLen = r.headers.get('content-length');
      const bodyTxt = req.method === 'HEAD' ? '' : await r.text();
      const len = req.method === 'HEAD' ? (upLen || '0') : String(new TextEncoder().encode(bodyTxt).length);
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
          'Content-Length': len
        }
      });
    }

    // Dynamic downloader: always serves the user.js pointed by the latest meta on main
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

      // 2) Extract @downloadURL from meta
      const m = metaTxt.match(/@downloadURL\s+([^\s]+)/);
      if (!m) {
        return new Response('downloadURL not found in meta', { status: 500, headers: baseHeaders });
      }
      const target = m[1];

      // 3) Fetch the actual script at that URL and stream it back
      const scriptResp = await fetch(target, {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (req.method === 'HEAD') {
        // Return only headers
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
            'Content-Disposition': 'inline; filename="AnimeTrack.user.js"'
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
            'Content-Disposition': 'inline; filename="AnimeTrack.user.js"'
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