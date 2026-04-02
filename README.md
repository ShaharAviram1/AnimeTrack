# AnimeTrack

Fast anime scrobbler for MyAnimeList with a focused floating UI.

- Built-in support for **Animetsu** and HiAnime-style sites
- **Site profiles** for adding new hosts without editing the script
- Per-site **Enable here** toggle
- **MAL OAuth (PKCE)** — access + refresh tokens stored via GM storage
- **Search + map** the current series to a MAL ID (stored per provider-aware site key)
- **Auto-mark watched** at ~80% playback (or manual mark)
- **Shadow DOM** panel, no jQuery, no icon fonts

## Install (auto-updating)
1. Create the GitHub repo `ShaharAviram1/AnimeTrack`.
2. Upload `animeTrack.user.js` to the repo root.
3. Userscript managers will auto-update using:
   - `@updateURL` https://raw.githubusercontent.com/ShaharAviram1/AnimeTrack/main/animeTrack.user.js
   - `@downloadURL` https://raw.githubusercontent.com/ShaharAviram1/AnimeTrack/main/animeTrack.user.js

## Safari setup
- Safari → Settings → Extensions → Userscripts → Edit Websites → Allow on your anime sites.

## OAuth
This uses MAL's official OAuth flow with PKCE (plain) and the existing callback path `https://malsync.moe/mal/oauth`. The script matches `*://*/*`, so the callback page executes and stores tokens.

## Mappings
Series mapping keys are provider-aware, so slug sites and numeric-id sites can both map reliably.
You can clear mapping from the panel, or remap by searching again.

## Privacy
- Only connects to `myanimelist.net` and `api.myanimelist.net` (no `@connect *`).
- No analytics, no third-party CDNs.

## License
GPL-3.0-or-later
