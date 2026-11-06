/*
 * Twitch Ad Skipper — bridge (content script, isolated world).
 *
 * page.js runs in the page's own JavaScript world and has no access to the
 * extension APIs, so this script carries settings and downloaded rules to it,
 * and ad statistics back to extension storage.
 */
(function () {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const SETTINGS_KEY = '__tas_settings';
  const RULES_KEY = '__tas_rules';
  const DEFAULTS = { enabled: true, forceAvc: true, rules: null };

  function push(s) {
    const settings = { enabled: s.enabled !== false, forceAvc: s.forceAvc !== false };
    const rules = s.rules && typeof s.rules === 'object' ? s.rules : null; // already validated by background.js
    // Cached so page.js can read them synchronously at the very start of the next page load.
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      if (rules) localStorage.setItem(RULES_KEY, JSON.stringify(rules));
      else localStorage.removeItem(RULES_KEY);
    } catch (err) {
      /* storage blocked */
    }
    window.postMessage({ source: 'tas-bridge', type: 'settings', settings, rules }, location.origin);
  }

  const refresh = () => api.storage.local.get(DEFAULTS).then(push, () => {});
  refresh();

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.enabled || changes.forceAvc || changes.rules)) refresh();
  });

  // Stats updates are serialized so two quick ad breaks can't overwrite each other.
  let queue = Promise.resolve();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'tas-page' || e.data.type !== 'adBlocked') return;
    const ms = Number(e.data.durationMs);
    const durationMs = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 10 * 60 * 1000) : 0;
    const usedBackup = e.data.usedBackup === true;
    queue = queue
      .then(() => api.storage.local.get({ adBreaks: 0, adMs: 0, heldBreaks: 0 }))
      .then((s) =>
        api.storage.local.set({
          adBreaks: (s.adBreaks || 0) + 1,
          adMs: (s.adMs || 0) + durationMs,
          // Breaks where no ad-free copy was found and the stream had to hold.
          // A sudden rise here is the first sign Twitch changed something.
          heldBreaks: (s.heldBreaks || 0) + (usedBackup ? 0 : 1),
          lastBreak: { at: Date.now(), durationMs, usedBackup },
        })
      )
      .catch(() => {});
  });
})();
