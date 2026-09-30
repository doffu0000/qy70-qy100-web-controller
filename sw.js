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

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One file failing (e.g. an image) shouldn't stop the rest being saved.
    await Promise.all(FILES.map((f) => cache.add(new Request(f, { cache: 'reload' })).catch(() => {})));
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
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      return Response.error();
    }
  })());
});
