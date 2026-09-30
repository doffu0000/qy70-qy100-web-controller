// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// Installable app, offline support and the browser check.
//
// - Offline: registers sw.js for everyone, so the console keeps working
//   without a connection once it has loaded.
// - Install App: installing is an Explorer perk on Patreon. The site's
//   WordPress (same origin, so the visitor's login cookie comes along)
//   answers "guest / none / free / explorer" through admin-ajax. Only a
//   verified Explorer gets the web app manifest added to the page, which is
//   what makes the browser offer to install it; everyone else gets a dialog
//   pointing to Patreon, with a "verify" link that runs the Patreon login
//   and comes straight back here.
// - Browser check: the console needs a Chromium-based browser (Web MIDI to
//   reach the QY, and web app installs). In one, nothing is shown; in
//   anything else a banner lists every Chromium browser for that system.

const MEMBERSHIP_URL = '/wp-admin/admin-ajax.php?action=qy_console_membership';
const JOIN_URL = 'https://www.patreon.com/doffu/membership';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- browser

const BROWSERS = {
  chrome: ['Google Chrome', 'https://www.google.com/chrome/'],
  edge: ['Microsoft Edge', 'https://www.microsoft.com/edge/download'],
  brave: ['Brave', 'https://brave.com/download/'],
  opera: ['Opera', 'https://www.opera.com/download'],
  vivaldi: ['Vivaldi', 'https://vivaldi.com/download/'],
  chromium: ['Chromium', 'https://www.chromium.org/getting-involved/download-chromium/'],
};

function platform() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return 'other';
}

// Chrome, Edge, Brave, Opera, Vivaldi, Samsung Internet... all report the
// "Chromium" brand; Safari and Firefox don't support userAgentData at all.
const isChromium = () => !!navigator.userAgentData?.brands?.some((b) => b.brand === 'Chromium');
export const browserQualifies = () => isChromium() && !!navigator.requestMIDIAccess;

function browserListHtml(os) {
  const keys = {
    windows: ['edge', 'chrome', 'brave', 'opera', 'vivaldi'],
    mac: ['chrome', 'edge', 'brave', 'opera', 'vivaldi'],
    linux: ['chrome', 'chromium', 'edge', 'brave', 'opera', 'vivaldi'],
    android: ['chrome', 'edge', 'brave', 'opera', 'vivaldi'],
    other: ['chrome', 'edge', 'brave', 'opera', 'vivaldi', 'chromium'],
  }[os];
  return keys.map((k) => {
    const [name, url] = BROWSERS[k];
    const note = os === 'windows' && k === 'edge' ? ' (already installed)' : '';
    return `<a href="${url}" target="_blank" rel="noopener">${name}</a>${note}`;
  }).join(', ');
}

function showBrowserBanner() {
  if (browserQualifies()) return;
  const banner = $('browser-banner');
  if (!banner) return;
  const os = platform();
  if (os === 'ios') {
    banner.innerHTML = 'iPhone and iPad browsers can\'t connect to MIDI devices (Apple requires every iOS browser to use Safari\'s engine, which has no MIDI support), so the console can\'t talk to your QY70/QY100 here. Please open this page on a Windows, Mac or Linux computer, or an Android device, in a Chromium-based browser such as Google Chrome or Microsoft Edge.';
  } else {
    const reason = navigator.requestMIDIAccess
      ? 'The console needs a Chromium-based browser to connect reliably to your QY70/QY100 and to install as an offline app.'
      : 'This browser can\'t connect to MIDI devices, so the console can\'t talk to your QY70/QY100.';
    const edge = os === 'windows'
      ? ` <a class="browser-banner-button" href="microsoft-edge:${location.href.split('#')[0]}">Open in Microsoft Edge</a>`
      : '';
    banner.innerHTML = `${reason} Please open this page in one of these browsers: ${browserListHtml(os)}.${edge}`;
  }
  banner.hidden = false;
}

// ---------------------------------------------------------------- offline

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // The console lives in its own folder. If its files ever end up in the
  // site root, a worker registered there would cover the whole website, so
  // don't register one (the local test server is the only exception).
  const folder = new URL('./', location.href).pathname;
  if (folder === '/' && location.hostname !== 'localhost') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is a bonus, never an error */ });
}

// ---------------------------------------------------------------- membership

let membership = null; // { level: 'guest' | 'none' | 'free' | 'explorer', patreon: bool } or { level: 'unknown' }

async function checkMembership() {
  try {
    const res = await fetch(MEMBERSHIP_URL, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    membership = ['guest', 'none', 'free', 'explorer'].includes(data.level) ? data : { level: 'unknown' };
  } catch {
    membership = { level: 'unknown' };
  }
  if (membership.level === 'explorer') offerInstall();
  return membership;
}

// Adding the manifest is what makes the browser consider the page an
// installable app, so it only happens for a verified Explorer.
function offerInstall() {
  if (document.querySelector('link[rel="manifest"]')) return;
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = 'manifest.json';
  document.head.appendChild(link);
}

function verifyUrl() {
  return `/patreon-flow/?patreon-login=yes&patreon-final-redirect=${encodeURIComponent(location.href.split('#')[0])}`;
}

// ---------------------------------------------------------------- install

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (evt) => {
  evt.preventDefault();
  deferredPrompt = evt;
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  showDialog({
    title: 'App installed',
    body: '<p>The QY70 / QY100 Web Console is now installed. Open it from your Start menu, Dock or app launcher; it works offline and updates itself whenever you\'re online.</p>',
    actions: [{ label: 'OK', primary: true }],
  });
});

const isInstalledApp = () => window.navigator.standalone === true ||
  ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'].some((m) => window.matchMedia(`(display-mode: ${m})`).matches);

function waitForInstallPrompt(ms) {
  if (deferredPrompt) return Promise.resolve(deferredPrompt);
  return new Promise((resolve) => {
    const done = () => { window.removeEventListener('beforeinstallprompt', onPrompt); resolve(deferredPrompt); };
    const onPrompt = () => setTimeout(done, 0);
    window.addEventListener('beforeinstallprompt', onPrompt);
    setTimeout(done, ms);
  });
}

async function onInstallClick() {
  if (!browserQualifies()) {
    showDialog({
      title: 'Install App needs a Chromium browser',
      body: `<p>Installing the console as an app works in Chromium-based browsers: ${browserListHtml(platform() === 'ios' ? 'other' : platform())}.</p><p>Open this page in one of them, then click Install App again.</p>`,
      actions: [{ label: 'OK', primary: true }],
    });
    return;
  }
  // A verified Explorer whose browser is already offering the app goes
  // straight to the install window: Chrome only opens it within a few
  // seconds of a real click, so there's no time for another online check.
  const { level } = (membership?.level === 'explorer' && deferredPrompt) ? membership : await checkMembership();
  if (level === 'explorer') {
    const prompt = await waitForInstallPrompt(3000);
    if (prompt) {
      try {
        await prompt.prompt();
        await prompt.userChoice;
        deferredPrompt = null;
        return;
      } catch {
        // Refused (e.g. the click was too long ago): fall through to the manual steps.
      }
    }
    showDialog({
      title: 'Install the QY Console app',
      body: '<p>Thanks for being an Explorer! Your browser didn\'t open its install window. That usually means the app is <strong>already installed</strong> on this computer (look for "QY Console" in your apps).</p>'
        + '<p>If it isn\'t, install it from the browser menu:</p><ul>'
        + '<li><strong>Chrome, Brave, Vivaldi:</strong> menu &#8942; &rarr; <em>Cast, save, and share</em> &rarr; <em>Install page as app</em> (or the install icon at the right of the address bar)</li>'
        + '<li><strong>Edge:</strong> menu &hellip; &rarr; <em>Apps</em> &rarr; <em>Install this site as an app</em></li>'
        + '<li><strong>Opera:</strong> the install icon in the address bar</li></ul>',
      actions: [{ label: 'OK', primary: true }],
    });
    return;
  }
  if (level === 'free') {
    showDialog({
      patreon: true,
      title: 'Install App is an Explorer perk',
      body: '<p>Thanks for being a free member! The installable QY70 / QY100 Web Console runs in its own window and works <strong>offline</strong> on Windows, Mac and Linux, with updates arriving automatically.</p>'
        + '<p>It\'s available to <strong>Explorer</strong> members on Patreon. After upgrading, come back and click Install App again.</p>',
      actions: [
        { label: 'Not now' },
        { label: 'Upgrade to Explorer', primary: true, href: JOIN_URL },
      ],
    });
    return;
  }
  if (level === 'unknown') {
    showDialog({
      title: 'Couldn\'t check your membership',
      body: '<p>Install App checks your Patreon membership on qy100.doffu.net, which couldn\'t be reached just now. Check your internet connection and try again.</p>',
      actions: [{ label: 'OK', primary: true }],
    });
    return;
  }
  // guest or logged in without a Patreon membership
  showDialog({
    patreon: true,
    title: 'Install App is an Explorer perk',
    body: '<p>The installable QY70 / QY100 Web Console runs in its own window and works <strong>offline</strong> on Windows, Mac and Linux, with updates arriving automatically.</p>'
      + '<p>It\'s available to <strong>Explorer</strong> members on Patreon.</p>'
      + (membership.patreon !== false
        ? `<p class="install-dialog-verify">Already an Explorer? <a href="${verifyUrl()}">Verify on Patreon</a> and you'll come right back here, ready to install.</p>`
        : ''),
    actions: [
      { label: 'Not now' },
      { label: 'Join on Patreon', primary: true, href: JOIN_URL },
    ],
  });
}

// ---------------------------------------------------------------- dialog

function showDialog({ title, body, actions, patreon = false }) {
  const dialog = $('install-dialog');
  dialog.classList.toggle('patreon-dialog', patreon);
  $('install-dialog-title').textContent = title;
  $('install-dialog-body').innerHTML = body;
  const bar = $('install-dialog-actions');
  bar.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement(a.href ? 'a' : 'button');
    btn.textContent = a.label;
    if (a.primary) btn.className = 'btn-warning';
    if (a.href) {
      btn.href = a.href;
      btn.target = '_blank';
      btn.rel = 'noopener';
      btn.classList.add('dialog-link-button');
    } else {
      btn.type = 'button';
    }
    btn.addEventListener('click', () => dialog.close());
    bar.appendChild(btn);
  }
  if (!dialog.open) dialog.showModal();
  // Focus the main action rather than whatever link comes first in the text.
  (bar.querySelector('.btn-warning') || bar.lastElementChild)?.focus();
}

// ---------------------------------------------------------------- start

showBrowserBanner();
registerServiceWorker();
// In the installed app there's nothing to install, and the person using it
// is already an Explorer supporter (the CSS hides both too).
if (isInstalledApp()) {
  for (const id of ['install-app-btn', 'join-btn']) if ($(id)) $(id).hidden = true;
}
$('install-app-btn')?.addEventListener('click', onInstallClick);
$('install-dialog')?.addEventListener('click', (evt) => { if (evt.target === evt.currentTarget) evt.currentTarget.close(); });
// Check quietly on load, so a returning Explorer's browser already knows the
// app is installable by the time they click (and can show its own icon).
if (browserQualifies()) checkMembership();
