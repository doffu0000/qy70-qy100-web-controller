// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// Offline support. Every file the console needs is saved when the service
// worker installs. Requests always try the network first, so an uploaded
// update shows up on the next load, and fall back to the saved copy when
// offline. Bump CACHE when the file list below changes (a file added or
// renamed); edits to existing files need no bump. Only caches named
// qy-console-* are ever deleted, so nothing else stored on the site is touched.
// Only a response that really is the console counts as the network
// answering (see isConsoleResponse): if the site later goes down, starts
// showing a host error page, redirects elsewhere, or the domain ends up
// parked, the saved copy keeps running instead.
// v2: replaces a v1 cache that a stray copy of this worker at the site root
// had filled with WordPress files.
const CACHE_PREFIX = 'qy-console-';
const CACHE = `${CACHE_PREFIX}v2`;

const FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'css/fonts.css',
  'fonts/sora-latin.woff2',
  'fonts/sora-latin-ext.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/app.js',
  'js/bmp.js',
  'js/controllers.js',
  'js/gif.js',
  'js/install.js',
  'js/knob.js',
  'js/midi.js',
  'js/params.js',
  'js/qydevice.js',
  'js/qyfiles.js',
  'js/qysong.js',
  'js/smf.js',
  'js/sysex.js',
  'js/voices.js',
  'data/drum_notes.json',
  'data/effect_params.json',
  'data/effect_types.json',
  'data/effect_value_tables.json',
  'data/fx_presets.json',
  'data/graphics_animation_presets.json',
  'data/graphics_presets.json',
  'data/parameters.json',
  'data/presets.json',
  'data/voices.json',
  // Site images the console shows (same site, so they can be saved too).
  '/wp-content/uploads/2024/09/QY-Mounting-Banner.png',
  '/wp-content/uploads/2024/09/SM-Card-30.jpg',
];

// Marker index.html carries (<meta name="qy-console">), so a page that
// merely answers 200 (a host's error or parking page) isn't taken for it.
const CONSOLE_MARKER = 'name="qy-console"';

const expectsHtml = (req, url) => req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');

// True if `res` is a real copy of the file `req` asked for: a 200 from
// this site (not a redirect away or an error page), not an HTML page where
// a script, stylesheet, font, image or data file was expected, and for
// the page itself, the console's own HTML.
async function isConsoleResponse(req, res) {
  if (!res || !res.ok || res.type === 'opaqueredirect' || res.redirected) return false;
  const url = new URL(req.url);
  const isHtml = (res.headers.get('content-type') || '').includes('text/html');
  if (!expectsHtml(req, url)) return !isHtml;
  if (!isHtml) return false;
  return (await res.clone().text()).includes(CONSOLE_MARKER);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One file failing (e.g. an image) shouldn't stop the rest being saved.
    await Promise.all(FILES.map(async (f) => {
      const req = new Request(f, { cache: 'reload' });
      const res = await fetch(req);
      if (await isConsoleResponse(req, res)) await cache.put(req, res);
    }).map((p) => p.catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // A worker registered at the site root (files uploaded to the wrong
  // folder) must never take over the rest of the website.
  if (new URL(self.registration.scope).pathname === '/' && self.location.hostname !== 'localhost') return;
  const url = new URL(req.url);
  // Only this site's files; never the membership check or WordPress itself.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/wp-admin/') || url.pathname.startsWith('/wp-json/')) return;
  const inScope = url.pathname.startsWith(new URL('./', self.registration.scope).pathname);
  const isSiteImage = url.pathname.startsWith('/wp-content/uploads/') && req.destination === 'image';
  if (!inScope && !isSiteImage) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = async () => (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? cache.match('index.html') : undefined);
    let res;
    try {
      res = await fetch(req, { cache: 'no-cache' });
    } catch {
      return (await saved()) || Response.error();
    }
    if (await isConsoleResponse(req, res)) {
      cache.put(req, res.clone());
      return res;
    }
    // The site answered, but not with the console (an error or parking
    // page, a redirect away): the saved copy wins whenever there is one.
    return (await saved()) || res;
  })());
});
