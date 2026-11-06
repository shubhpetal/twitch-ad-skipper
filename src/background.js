/*
 * Twitch Ad Skipper — background: keeps the detection rules up to date.
 *
 * Every 6 hours (and at browser start, and on demand from the popup) it
 * downloads rules.json from the address set in the popup, validates it with
 * TASRules.sanitize and stores it. bridge.js then hands the new rules to
 * every open Twitch tab, where they take effect without a reload.
 *
 * A file that fails validation is ignored and the last good rules stay in use.
 */
/* global TASRules */
if (typeof importScripts === 'function' && typeof TASRules === 'undefined') {
  importScripts('rules.js'); // Chrome service worker; Firefox loads it via background.scripts
}

const api = globalThis.browser || globalThis.chrome;
const ALARM = 'tas-rules-update';
const PERIOD_MINUTES = 6 * 60;
const MAX_BYTES = 64 * 1024;

function validUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.href : null;
  } catch (err) {
    return null;
  }
}

let running = null;

function checkRules() {
  // Collapse overlapping checks (startup + alarm + popup button) into one.
  if (!running) running = doCheck().finally(() => (running = null));
  return running;
}

async function doCheck() {
  // rulesUrl is unset until the user sets one in the popup; '' means "built-in rules only".
  const { rulesUrl, rules: current } = await api.storage.local.get({ rulesUrl: null, rules: null });
  const url = validUrl(rulesUrl === null || rulesUrl === undefined ? TASRules.DEFAULT_RULES_URL : rulesUrl);
  if (!url) {
    await api.storage.local.set({ rulesStatus: { state: 'builtin', checkedAt: Date.now() } });
    return;
  }
  const previousVersion = current && current.version;
  try {
    const bust = `${url.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 60000)}`;
    const res = await fetch(url + bust, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`Server answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('Rules file is too large');
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error('Rules file is not valid JSON');
    }
    const { rules, error } = TASRules.sanitize(raw);
    if (error) throw new Error(error);
    const changed = JSON.stringify(rules) !== JSON.stringify(current);
    const update = { rulesStatus: { state: 'ok', version: rules.version, checkedAt: Date.now(), source: url } };
    if (changed) {
      update.rules = rules;
      update.rulesStatus.updatedAt = Date.now();
    }
    await api.storage.local.set(update);
  } catch (err) {
    await api.storage.local.set({
      rulesStatus: {
        state: 'error',
        error: String((err && err.message) || err),
        version: previousVersion || null,
        checkedAt: Date.now(),
        source: url,
      },
    });
  }
}

async function ensureAlarm() {
  const existing = await api.alarms.get(ALARM);
  if (!existing) api.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
}

api.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  checkRules();
});

api.runtime.onStartup.addListener(() => {
  ensureAlarm();
  checkRules();
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) checkRules();
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only the extension's own pages (the popup) may ask for a check.
  const fromExtensionPage = sender.id === api.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(api.runtime.getURL(''));
  if (!msg || msg.type !== 'checkRules' || !fromExtensionPage) return false;
  checkRules().then(
    () => sendResponse({ ok: true }),
    () => sendResponse({ ok: false })
  );
  return true;
});
