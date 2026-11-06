/*
 * Twitch Ad Skipper — detection rules.
 *
 * The values Twitch changes most often live here as plain data, so they can
 * be updated from a hosted rules.json without shipping new code. This file
 * holds the built-in defaults and the validator every downloaded rules file
 * must pass. Rules are data only: they are never evaluated as code.
 *
 * Loaded by the page script (and removed from window immediately), the
 * background script and the popup.
 */
(function (root) {
  'use strict';

  const SCHEMA = 1;

  // Where updated rules are published. Used until the user sets a different
  // address in the popup (an empty address there means built-in rules only).
  const DEFAULT_RULES_URL = 'https://raw.githubusercontent.com/shubhpetal/twitch-ad-skipper/main/rules.json';

  const DEFAULT_RULES = Object.freeze({
    schema: SCHEMA,
    version: '2026.11.06',
    // Any of these in a media playlist means an ad break is in progress.
    adMarkers: [
      'stitched',
      'X-TV-TWITCH-AD',
      'EXT-X-CUE-OUT',
      'SCTE35-OUT',
      'CLASS="twitch-stitched-ad',
      'CLASS="twitch-ad-',
      'CLASS="twitch-ad"',
      '/adsquared/',
    ],
    // #EXT-X-DATERANGE lines containing these are not video ads (display ads beside the player).
    ignoreMarkers: ['CLASS="twitch-maf-ad"'],
    // Segment URLs containing these are ad segments.
    adSegmentUrlMarkers: ['stitched', '/adsquared/'],
    // Title Twitch gives real stream segments: "#EXTINF:2.000,live".
    liveSegmentTitle: 'live',
    // Player types to request an ad-free copy under, in order of preference.
    backupPlayerTypes: ['embed', 'popout', 'site', 'mobile_web', 'autoplay'],
    clientId: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
    tokenHash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9',
    // Small display ads around the player, hidden with CSS.
    hideSelectors: [
      '[data-test-selector="display-ad"]',
      '[data-test-selector="ad-banner"]',
      '[data-a-target="ads-banner"]',
      '.stream-display-ad__wrapper',
      'iframe[class*="stream-display-ad__iframe"]',
    ],
  });

  const FIELDS = {
    adMarkers: { list: true, min: 1, max: 40, maxLen: 120, re: /^[^\r\n]{3,}$/ },
    ignoreMarkers: { list: true, min: 0, max: 40, maxLen: 120, re: /^[^\r\n]{3,}$/ },
    adSegmentUrlMarkers: { list: true, min: 0, max: 40, maxLen: 120, re: /^[^\r\n]{3,}$/ },
    liveSegmentTitle: { re: /^[\w|.-]{1,40}$/ },
    backupPlayerTypes: { list: true, min: 1, max: 10, maxLen: 40, re: /^[a-z][a-z0-9_-]*$/ },
    clientId: { re: /^[a-z0-9]{20,40}$/ },
    tokenHash: { re: /^[0-9a-f]{64}$/ },
    hideSelectors: { list: true, min: 0, max: 60, maxLen: 200, re: /^[^{}<>@;\\\r\n]+$/ },
  };

  /**
   * Validates a downloaded rules object. Every field is optional (missing ones
   * keep the built-in value), but any field that is present must be valid, or
   * the whole file is rejected, so rules are never half-applied.
   * Returns { rules } or { error }.
   */
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Rules file is not a JSON object' };
    if (typeof raw.schema !== 'number') return { error: 'Rules file has no "schema" number' };
    if (raw.schema > SCHEMA) return { error: `Rules need a newer version of the extension (schema ${raw.schema})` };
    if (raw.schema < 1) return { error: 'Unknown rules schema' };
    const rules = { schema: SCHEMA };
    rules.version = typeof raw.version === 'string' && /^[\w.+-]{1,40}$/.test(raw.version) ? raw.version : 'unversioned';
    for (const key of Object.keys(FIELDS)) {
      if (!(key in raw)) continue;
      const spec = FIELDS[key];
      const value = raw[key];
      if (spec.list) {
        const ok =
          Array.isArray(value) &&
          value.length >= spec.min &&
          value.length <= spec.max &&
          value.every((v) => typeof v === 'string' && v.length <= spec.maxLen && spec.re.test(v));
        if (!ok) return { error: `Invalid "${key}" in rules file` };
        rules[key] = value.slice();
      } else {
        if (typeof value !== 'string' || !spec.re.test(value)) return { error: `Invalid "${key}" in rules file` };
        rules[key] = value;
      }
    }
    return { rules };
  }

  /** Built-in defaults with any (already sanitized) downloaded fields laid over them. */
  function merge(partial) {
    const out = JSON.parse(JSON.stringify(DEFAULT_RULES));
    if (partial && typeof partial === 'object') {
      for (const key of Object.keys(FIELDS)) if (key in partial) out[key] = JSON.parse(JSON.stringify(partial[key]));
      if (typeof partial.version === 'string') out.version = partial.version;
    }
    return out;
  }

  const api = { SCHEMA, DEFAULT_RULES, DEFAULT_RULES_URL, sanitize, merge };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.TASRules = api;
})(globalThis);
