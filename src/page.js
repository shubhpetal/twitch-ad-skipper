/*
 * Twitch Ad Skipper — page script.
 *
 * Runs in the page's MAIN world at document_start, before Twitch's own code
 * (src/rules.js runs just before it and provides the detection rules).
 *
 * How it works
 * ------------
 * Twitch stitches ads straight into the live HLS video playlist (server-side
 * ad insertion), so there is no separate ad request to block. Twitch's video
 * player runs inside a Web Worker and fetches those playlists itself. This
 * script:
 *
 *   1. Wraps window.Worker so every Twitch player worker starts with our
 *      code (workerMain) prepended. That code wraps the worker's fetch().
 *   2. When a media playlist contains an ad, the worker asks this page for a
 *      fresh playback token under a different player type (embed, popout,
 *      ...). Those often come back ad-free, so the player is handed that
 *      ad-free playlist instead.
 *   3. If no ad-free copy can be found, the ad segments are removed from the
 *      playlist, so the stream holds until the break ends instead of
 *      playing the ad.
 *   4. When the break ends, the player is nudged (reloaded or paused and
 *      resumed) so it picks the real stream back up cleanly.
 *
 * Ads are recognised two ways, so a renamed marker alone doesn't break it:
 * by the marker strings in the rules, and by structure (segments that aren't
 * titled "live" appearing in a live stream).
 */
(function () {
  'use strict';

  const MSG = '__tasMsg'; // marks our own postMessage traffic to/from workers
  const SETTINGS_KEY = '__tas_settings'; // localStorage caches written by bridge.js
  const RULES_KEY = '__tas_rules';
  const DEFAULT_SETTINGS = { enabled: true, forceAvc: true };
  const TOKEN_QUERY =
    'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {' +
    ' streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename }' +
    ' videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';

  /* ======================================================================
   * Worker side. This function is converted to a string and prepended to
   * Twitch's worker source, so it must be fully self-contained: no
   * references to anything outside its own body.
   * ==================================================================== */
  function workerMain(seed, scope) {
    const g = scope || self;
    const TAG = seed.tag;
    const realFetch = g.fetch.bind(g);
    const cfg = { enabled: seed.enabled !== false, forceAvc: seed.forceAvc !== false };
    const LOOKUP_BUDGET_MS = 4500; // never hold a playlist request longer than this
    const REQUEST_TIMEOUT_MS = 3000;
    const BACKUP_CACHE_MS = 5 * 60 * 1000;
    const PLAYER_TYPE_COOLDOWN_MS = 15000;
    const USHER_RE = /^https:\/\/usher\.ttvnw\.net\/api\/(?:v2\/)?channel\/hls\/[^/?#]+\.m3u8/;

    const streamsByChannel = new Map(); // channel -> stream state
    const variantsByUrl = new Map(); // media playlist URL -> { stream, variant }
    const pendingTokens = new Map(); // request id -> resolver
    let nextRequestId = 1;

    /* ---------- rules ---------- */

    function compileRules(r) {
      r = r || {};
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const anyOf = (list) =>
        Array.isArray(list) && list.length ? new RegExp(list.filter((s) => typeof s === 'string' && s).map(esc).join('|')) : null;
      return {
        ad: anyOf(r.adMarkers) || /stitched/,
        ignore: Array.isArray(r.ignoreMarkers) ? r.ignoreMarkers.filter((s) => typeof s === 'string' && s) : [],
        segUrl: anyOf(r.adSegmentUrlMarkers),
        live: ',' + (typeof r.liveSegmentTitle === 'string' && r.liveSegmentTitle ? r.liveSegmentTitle : 'live'),
        playerTypes: Array.isArray(r.backupPlayerTypes) && r.backupPlayerTypes.length ? r.backupPlayerTypes.slice() : ['embed'],
      };
    }
    let R = compileRules(seed.rules);

    /* ---------- playlist helpers ---------- */

    function parseAttrs(str) {
      const out = {};
      const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
      let m;
      while ((m = re.exec(str))) out[m[1]] = m[2].replace(/^"|"$/g, '');
      return out;
    }

    function codecFamily(codecs) {
      const list = String(codecs || '').split(',').map((c) => c.trim().toLowerCase());
      for (const c of list) {
        if (c.startsWith('avc')) return 'avc';
        if (c.startsWith('hev') || c.startsWith('hvc')) return 'hevc';
        if (c.startsWith('av01')) return 'av1';
      }
      return ''; // audio-only or unknown
    }

    function nextUriIndex(lines, from) {
      for (let j = from; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l && !l.startsWith('#')) return j;
      }
      return -1;
    }

    function parseMaster(text) {
      const lines = String(text).split(/\r?\n/);
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        const j = nextUriIndex(lines, i + 1);
        if (j < 0) break;
        const a = parseAttrs(lines[i].slice('#EXT-X-STREAM-INF:'.length));
        const wh = String(a.RESOLUTION || '').split('x').map(Number);
        variants.push({
          url: lines[j].trim(),
          resolution: a.RESOLUTION || '',
          pixels: wh.length === 2 && wh[0] && wh[1] ? wh[0] * wh[1] : 0,
          fps: Number(a['FRAME-RATE']) || 0,
          family: codecFamily(a.CODECS),
          group: a.VIDEO || '',
        });
        i = j;
      }
      return variants;
    }

    // Drop HEVC / AV1 renditions when H.264 ones exist. Backup streams are
    // H.264, and switching codecs mid-stream is what causes black screens.
    function keepOnlyAvc(text) {
      const lines = String(text).split(/\r?\n/);
      const drop = new Set();
      const droppedGroups = new Set();
      const keptGroups = new Set();
      let hasAvc = false;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        const j = nextUriIndex(lines, i + 1);
        const a = parseAttrs(lines[i].slice('#EXT-X-STREAM-INF:'.length));
        const fam = codecFamily(a.CODECS);
        if (fam === 'avc') hasAvc = true;
        if (fam === 'hevc' || fam === 'av1') {
          drop.add(i);
          if (j >= 0) drop.add(j);
          if (a.VIDEO) droppedGroups.add(a.VIDEO);
        } else if (a.VIDEO) {
          keptGroups.add(a.VIDEO);
        }
        if (j > i) i = j;
      }
      if (!hasAvc || drop.size === 0) return text;
      return lines
        .filter((line, i) => {
          if (drop.has(i)) return false;
          if (line.startsWith('#EXT-X-MEDIA:')) {
            const gid = parseAttrs(line.slice('#EXT-X-MEDIA:'.length))['GROUP-ID'];
            if (gid && droppedGroups.has(gid) && !keptGroups.has(gid)) return false;
          }
          return true;
        })
        .join('\n');
    }

    // Date ranges for the small display ads beside the player are not video ads.
    function isIgnored(line) {
      return line.startsWith('#EXT-X-DATERANGE:') && R.ignore.some((m) => line.includes(m));
    }

    function scan(text) {
      const lines = String(text).split(/\r?\n/);
      let marked = false;
      let live = 0;
      let other = 0;
      for (const line of lines) {
        if (isIgnored(line)) continue;
        if (!marked && R.ad.test(line)) marked = true;
        if (line.startsWith('#EXTINF')) {
          if (line.includes(R.live)) live++;
          else other++;
        }
      }
      return { marked, live, other };
    }

    // `stream` is passed for the stream's own playlist (not backups), so a
    // window that suddenly has no live segments at all also counts.
    function hasAds(text, stream) {
      const s = scan(text);
      if (stream && s.live) stream.sawLive = true;
      if (s.marked) return true;
      if (s.live && s.other) return true; // ad segments mixed in with the stream
      return !!(stream && stream.sawLive && !s.live && s.other); // whole window replaced
    }

    function isAdSegment(extinf, uri) {
      return !extinf.includes(R.live) || !!(R.segUrl && R.segUrl.test(uri || ''));
    }

    // Remove ad segments and the ad's date-range tags (which drive Twitch's
    // "Ad 1 of 2" overlay). Low-latency hints go too during the break,
    // otherwise the player can prefetch an ad segment from them.
    function stripAds(text) {
      const lines = String(text).split(/\r?\n/);
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXTINF')) {
          const j = nextUriIndex(lines, i + 1);
          if (j >= 0 && isAdSegment(line, lines[j])) {
            i = j; // skip the segment and its URI
            continue;
          }
        }
        if (line.startsWith('#EXT-X-DATERANGE:') && !isIgnored(line) && R.ad.test(line)) continue;
        if (
          line.startsWith('#EXT-X-TWITCH-PREFETCH:') ||
          line.startsWith('#EXT-X-PART:') ||
          line.startsWith('#EXT-X-PRELOAD-HINT:')
        ) {
          continue;
        }
        out.push(line);
      }
      return out.join('\n');
    }

    function pickVariant(candidates, target) {
      if (!candidates.length) return null;
      if (!target.pixels) {
        return candidates.find((c) => c.group && c.group === target.group) || candidates.find((c) => !c.pixels) || null;
      }
      const video = candidates.filter((c) => c.pixels);
      const exact = video.find(
        (c) => c.resolution === target.resolution && c.family === target.family && Math.round(c.fps) === Math.round(target.fps)
      );
      if (exact) return exact;
      const pool = video.some((c) => c.family === target.family) ? video.filter((c) => c.family === target.family) : video;
      let best = null;
      for (const c of pool) {
        const score = Math.abs(c.pixels - target.pixels) * 1000 + Math.abs(c.fps - target.fps);
        if (!best || score < best.score) best = { c, score };
      }
      return best ? best.c : null;
    }

    /* ---------- messaging with the page ---------- */

    function post(type, data) {
      const msg = Object.assign({}, data || {}, { type });
      msg[TAG] = true;
      g.postMessage(msg);
    }

    g.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d[TAG] !== true) return;
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      if (d.type === 'settings' && d.settings) {
        if (typeof d.settings.enabled === 'boolean') cfg.enabled = d.settings.enabled;
        if (typeof d.settings.forceAvc === 'boolean') cfg.forceAvc = d.settings.forceAvc;
      } else if (d.type === 'rules' && d.rules) {
        R = compileRules(d.rules);
      } else if (d.type === 'tokenResult') {
        const resolve = pendingTokens.get(d.id);
        if (resolve) {
          pendingTokens.delete(d.id);
          resolve(d.ok && d.token ? d.token : null);
        }
      }
    });

    function requestToken(channel, playerType, timeoutMs) {
      return new Promise((resolve) => {
        const id = nextRequestId++;
        const timer = setTimeout(() => {
          pendingTokens.delete(id);
          resolve(null);
        }, timeoutMs);
        pendingTokens.set(id, (token) => {
          clearTimeout(timer);
          resolve(token);
        });
        post('token', { id, channel, playerType });
      });
    }

    async function fetchText(url, timeoutMs) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        const res = await realFetch(url, ctrl ? { signal: ctrl.signal } : undefined);
        return res.ok ? await res.text() : null;
      } catch (err) {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    function playlistResponse(text, res) {
      return new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/vnd.apple.mpegurl' },
      });
    }

    /* ---------- finding an ad-free copy ---------- */

    async function fetchBackupMaster(stream, playerType, deadline) {
      const left = () => Math.max(1, deadline - Date.now());
      const token = await requestToken(stream.channel, playerType, Math.min(REQUEST_TIMEOUT_MS, left()));
      if (!token || Date.now() >= deadline) return null;
      const u = new URL(stream.usherBase + stream.usherSearch);
      u.searchParams.set('sig', token.signature);
      u.searchParams.set('token', token.value);
      let text = await fetchText(u.href, Math.min(REQUEST_TIMEOUT_MS, left()));
      if (text && cfg.forceAvc) text = keepOnlyAvc(text);
      return text;
    }

    async function lookupBackup(stream, variant) {
      const deadline = Date.now() + LOOKUP_BUDGET_MS;
      const types = R.playerTypes.slice();
      // Try whichever player type worked last time first.
      if (stream.lastGoodType && types.includes(stream.lastGoodType)) {
        types.splice(types.indexOf(stream.lastGoodType), 1);
        types.unshift(stream.lastGoodType);
      }
      for (const type of types) {
        if (Date.now() >= deadline) break;
        if ((stream.cooldown[type] || 0) > Date.now()) continue;
        for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
          let entry = stream.backups[type];
          const fresh = !entry || Date.now() - entry.at > BACKUP_CACHE_MS;
          if (fresh) {
            const master = await fetchBackupMaster(stream, type, deadline);
            if (!master) {
              // Token or playlist refused: don't ask again on every 2-second poll.
              stream.cooldown[type] = Date.now() + PLAYER_TYPE_COOLDOWN_MS;
              break;
            }
            entry = stream.backups[type] = { variants: parseMaster(master), at: Date.now() };
          }
          const match = pickVariant(entry.variants, variant);
          const text = match ? await fetchText(match.url, Math.min(REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now()))) : null;
          if (text && text.includes('#EXTINF') && !hasAds(text)) {
            stream.lastGoodType = type;
            return { playerType: type, text };
          }
          delete stream.backups[type];
          if (fresh) {
            stream.cooldown[type] = Date.now() + PLAYER_TYPE_COOLDOWN_MS;
            break;
          }
          // A cached copy went stale or picked up ads: retry once with a fresh token.
        }
      }
      return null;
    }

    function findBackup(stream, variant) {
      // One lookup at a time per rendition, shared by overlapping playlist polls.
      if (!stream.lookups[variant.url]) {
        stream.lookups[variant.url] = lookupBackup(stream, variant).finally(() => {
          delete stream.lookups[variant.url];
        });
      }
      return stream.lookups[variant.url];
    }

    /* ---------- playlist processing ---------- */

    async function processMedia(stream, variant, text) {
      if (!hasAds(text, stream)) {
        if (stream.inAd) {
          stream.inAd = false;
          post('adEnd', {
            channel: stream.channel,
            durationMs: Date.now() - stream.adStartedAt,
            usedBackup: stream.usedBackup,
          });
          stream.mode = null;
          stream.usedBackup = false;
        }
        return text;
      }
      if (!stream.inAd) {
        stream.inAd = true;
        stream.adStartedAt = Date.now();
        stream.usedBackup = false;
        stream.mode = null;
        post('adStart', { channel: stream.channel, midroll: /"midroll"/i.test(text) });
      }
      const backup = await findBackup(stream, variant);
      const mode = backup ? 'backup' : 'strip';
      if (backup) stream.usedBackup = true;
      if (mode !== stream.mode || (backup && backup.playerType !== stream.playerType)) {
        stream.mode = mode;
        stream.playerType = backup ? backup.playerType : null;
        post('adStatus', { channel: stream.channel, mode, playerType: stream.playerType });
      }
      return backup ? backup.text : stripAds(text);
    }

    async function onMaster(url, input, init) {
      const res = await realFetch(input, init);
      if (!res.ok) return res;
      let text = await res.text();
      try {
        const u = new URL(url);
        const channel = decodeURIComponent(u.pathname.split('/').pop().replace(/\.m3u8$/, '')).toLowerCase();
        if (cfg.forceAvc) text = keepOnlyAvc(text);
        const prev = streamsByChannel.get(channel);
        if (prev) for (const v of prev.variants) variantsByUrl.delete(v.url);
        const stream = {
          channel,
          usherBase: u.origin + u.pathname,
          usherSearch: u.search,
          variants: parseMaster(text),
          backups: prev ? prev.backups : {},
          cooldown: {},
          lookups: {},
          lastGoodType: prev ? prev.lastGoodType : null,
          sawLive: prev ? prev.sawLive : false,
          inAd: prev ? prev.inAd : false,
          adStartedAt: prev ? prev.adStartedAt : 0,
          usedBackup: prev ? prev.usedBackup : false,
          mode: null,
          playerType: null,
        };
        streamsByChannel.set(channel, stream);
        for (const v of stream.variants) variantsByUrl.set(v.url, { stream, variant: v });
      } catch (err) {
        // Leave the playlist untouched if anything unexpected shows up.
      }
      return playlistResponse(text, res);
    }

    async function onMedia(key, input, init) {
      const res = await realFetch(input, init);
      if (!res.ok) return res;
      const text = await res.text();
      const entry = variantsByUrl.get(key);
      let out = text;
      if (entry && cfg.enabled) {
        try {
          out = await processMedia(entry.stream, entry.variant, text);
        } catch (err) {
          out = text;
        }
      }
      return playlistResponse(out, res);
    }

    g.fetch = function (input, init) {
      if (!cfg.enabled) return realFetch(input, init);
      let url = '';
      try {
        url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
      } catch (err) {
        url = '';
      }
      url = url.trim();
      if (USHER_RE.test(url)) {
        let decoded = url;
        try {
          decoded = decodeURIComponent(url);
        } catch (err) {
          /* keep raw */
        }
        // Leave Twitch's small picture-by-picture player alone.
        if (!decoded.includes('picture-by-picture')) return onMaster(url, input, init);
      } else if (variantsByUrl.has(url)) {
        return onMedia(url, input, init);
      }
      return realFetch(input, init);
    };

    if (seed.expose) {
      return { parseMaster, keepOnlyAvc, hasAds, stripAds, pickVariant, codecFamily, cfg, streamsByChannel };
    }
    return undefined;
  }

  /* ---------- test hook (Node only) ---------- */
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { workerMain, MSG };
    return;
  }

  if (typeof window === 'undefined') return;
  // rules.js ran just before this file in the same world; take it off window.
  const Rules = window.TASRules;
  try {
    delete window.TASRules;
  } catch (err) {
    /* ignore */
  }
  if (window.__tasInstalled || !Rules) return;
  window.__tasInstalled = true;

  /* ======================================================================
   * Page side
   * ==================================================================== */

  function readCache(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch (err) {
      return null;
    }
  }

  const settings = Object.assign({}, DEFAULT_SETTINGS);
  const cachedSettings = readCache(SETTINGS_KEY);
  if (cachedSettings && typeof cachedSettings === 'object') {
    if (typeof cachedSettings.enabled === 'boolean') settings.enabled = cachedSettings.enabled;
    if (typeof cachedSettings.forceAvc === 'boolean') settings.forceAvc = cachedSettings.forceAvc;
  }
  // Turned off: leave Twitch completely untouched until the tab is reloaded.
  if (!settings.enabled) return;

  function resolveRules(partial) {
    const checked = partial ? Rules.sanitize(partial) : null;
    return Rules.merge(checked && checked.rules ? checked.rules : null);
  }
  let rules = resolveRules(readCache(RULES_KEY));

  function workerRules(r) {
    return {
      adMarkers: r.adMarkers,
      ignoreMarkers: r.ignoreMarkers,
      adSegmentUrlMarkers: r.adSegmentUrlMarkers,
      liveSegmentTitle: r.liveSegmentTitle,
      backupPlayerTypes: r.backupPlayerTypes,
    };
  }

  const log = (...args) => console.debug('%c[Ad Skipper]', 'color:#9146FF;font-weight:600', ...args);
  const realFetch = window.fetch;
  // Values seen on Twitch's own requests win over the rules file: they are current by definition.
  const seen = { clientId: null, deviceId: null, auth: null, integrity: null, version: null, session: null, hash: null };
  const workers = new Set();

  /* ---------- watch Twitch's own GQL calls for the headers we need ---------- */

  function readHeader(headers, name) {
    if (!headers) return null;
    try {
      if (typeof headers.get === 'function') return headers.get(name);
      const lower = name.toLowerCase();
      if (Array.isArray(headers)) {
        const hit = headers.find((h) => Array.isArray(h) && String(h[0]).toLowerCase() === lower);
        return hit ? hit[1] : null;
      }
      for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k];
    } catch (err) {
      /* ignore */
    }
    return null;
  }

  function sniffGql(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
    if (!url.startsWith('https://gql.twitch.tv/')) return;
    const headers = (init && init.headers) || (input instanceof Request ? input.headers : null);
    const take = (field, value) => {
      if (typeof value === 'string' && value) seen[field] = value;
    };
    const clientId = readHeader(headers, 'Client-ID');
    if (typeof clientId === 'string' && /^[a-z0-9]{20,40}$/.test(clientId)) seen.clientId = clientId;
    take('deviceId', readHeader(headers, 'X-Device-Id') || readHeader(headers, 'Device-ID'));
    take('auth', readHeader(headers, 'Authorization'));
    take('integrity', readHeader(headers, 'Client-Integrity'));
    take('version', readHeader(headers, 'Client-Version'));
    take('session', readHeader(headers, 'Client-Session-Id'));
    const body = init && typeof init.body === 'string' ? init.body : null;
    if (body && body.includes('PlaybackAccessToken')) {
      const parsed = JSON.parse(body);
      for (const op of Array.isArray(parsed) ? parsed : [parsed]) {
        const hash = op && op.operationName === 'PlaybackAccessToken' && op.extensions && op.extensions.persistedQuery && op.extensions.persistedQuery.sha256Hash;
        if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) seen.hash = hash;
      }
    }
  }

  window.fetch = function (input, init) {
    try {
      sniffGql(input, init);
    } catch (err) {
      /* never interfere with Twitch's request */
    }
    return realFetch.apply(this, arguments);
  };

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function fetchToken(channel, playerType) {
    const variables = {
      isLive: true,
      login: channel,
      isVod: false,
      vodID: '',
      playerType,
      platform: playerType === 'autoplay' ? 'android' : 'web',
    };
    const headers = { 'Client-ID': seen.clientId || rules.clientId };
    const deviceId = seen.deviceId || cookie('unique_id');
    if (deviceId) headers['X-Device-Id'] = deviceId;
    if (seen.auth) headers.Authorization = seen.auth;
    if (seen.integrity) headers['Client-Integrity'] = seen.integrity;
    if (seen.version) headers['Client-Version'] = seen.version;
    if (seen.session) headers['Client-Session-Id'] = seen.session;

    const send = async (body) => {
      const res = await realFetch.call(window, 'https://gql.twitch.tv/gql', { method: 'POST', headers, body: JSON.stringify(body) });
      return res.ok ? res.json() : null;
    };
    let json = await send({
      operationName: 'PlaybackAccessToken',
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: seen.hash || rules.tokenHash } },
    });
    // If Twitch retired the stored query hash, fall back to sending the full query.
    const notFound = json && Array.isArray(json.errors) && json.errors.some((e) => /PersistedQueryNotFound/i.test(e && e.message));
    if (notFound) json = await send({ operationName: 'PlaybackAccessToken_Template', query: TOKEN_QUERY, variables });
    const t = json && json.data && json.data.streamPlaybackAccessToken;
    return t && t.value && t.signature ? { value: t.value, signature: t.signature } : null;
  }

  /* ---------- player control (reaches into Twitch's React tree) ---------- */

  function findPlayer() {
    const root = document.querySelector('#root');
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
    const legacy = root._reactRootContainer && root._reactRootContainer._internalRoot;
    const start = key ? root[key] : legacy && legacy.current;
    if (!start) return null;
    let player = null;
    let state = null;
    const stack = [start];
    for (let n = 0; stack.length && n < 100000 && !(player && state); n++) {
      const node = stack.pop();
      const sn = node.stateNode;
      if (sn && typeof sn === 'object') {
        if (!player && sn.setPlayerActive && sn.props && sn.props.mediaPlayerInstance) player = sn.props.mediaPlayerInstance;
        if (!state && typeof sn.setSrc === 'function' && typeof sn.setInitialPlaybackSettings === 'function') state = sn;
      }
      if (node.sibling) stack.push(node.sibling);
      if (node.child) stack.push(node.child);
    }
    if (player && player.playerInstance) player = player.playerInstance;
    return { player, state };
  }

  function isPaused(player) {
    try {
      return (typeof player.isPaused === 'function' && player.isPaused()) || (player.core && player.core.paused);
    } catch (err) {
      return false;
    }
  }

  // After a break, the player has to rejoin the real stream.
  function resyncPlayer(reload) {
    try {
      const found = findPlayer();
      if (found && found.player) {
        if (isPaused(found.player)) return;
        if (reload && found.state) {
          log('Reloading player after ad break');
          found.state.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
          if (typeof found.player.play === 'function') found.player.play();
        } else {
          found.player.pause();
          found.player.play();
        }
        return;
      }
      const video = document.querySelector('video');
      if (video && !video.paused) {
        video.pause();
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (err) {
      log('Could not resync player', err);
    }
  }

  /* ---------- on-player notice ---------- */

  function setNotice(text) {
    const id = 'tas-notice';
    let el = document.getElementById(id);
    if (!text) {
      if (el) el.remove();
      return;
    }
    const host = document.querySelector('.video-player__container') || document.querySelector('.video-player') || document.querySelector('[data-a-target="video-player"]');
    if (!host) return;
    if (!el || el.parentElement !== host) {
      if (el) el.remove();
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('role', 'status');
      el.style.cssText = [
        'position:absolute', 'top:12px', 'left:12px', 'z-index:2000', 'pointer-events:none',
        'max-width:calc(100% - 24px)', 'padding:6px 10px 6px 9px', 'border-left:3px solid #9146FF',
        'border-radius:4px', 'background:rgba(14,14,16,.82)', 'color:#efeff1',
        'font:600 12px/1.35 Inter,Roobert,system-ui,sans-serif', 'letter-spacing:.01em',
      ].join(';');
      host.appendChild(el);
    }
    el.textContent = text;
  }

  /* ---------- hide the small display ads around the player ---------- */

  const style = document.createElement('style');
  style.id = 'tas-cosmetic';
  function applyCosmetic() {
    const valid = (rules.hideSelectors || []).filter((sel) => {
      try {
        document.createDocumentFragment().querySelector(sel);
        return true;
      } catch (err) {
        return false;
      }
    });
    style.textContent = valid.length ? `${valid.join(',')}{display:none!important}` : '';
  }
  applyCosmetic();
  (document.head || document.documentElement).appendChild(style);

  /* ---------- talking to the extension (bridge.js) ---------- */

  function report(type, data) {
    window.postMessage(Object.assign({ source: 'tas-page', type }, data), location.origin);
  }

  function broadcast(msg) {
    msg[MSG] = true;
    for (const w of workers) {
      try {
        w.postMessage(msg);
      } catch (err) {
        workers.delete(w);
      }
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'tas-bridge' || e.data.type !== 'settings') return;
    const s = e.data.settings || {};
    if (typeof s.enabled === 'boolean') settings.enabled = s.enabled;
    if (typeof s.forceAvc === 'boolean') settings.forceAvc = s.forceAvc;
    broadcast({ type: 'settings', settings: { enabled: settings.enabled, forceAvc: settings.forceAvc } });
    if (!settings.enabled) setNotice(null);
    if ('rules' in e.data) {
      const next = resolveRules(e.data.rules);
      if (JSON.stringify(next) !== JSON.stringify(rules)) {
        rules = next;
        log(`Using detection rules ${rules.version}`);
        applyCosmetic();
        broadcast({ type: 'rules', rules: workerRules(rules) });
      }
    }
  });

  function onWorkerMessage(worker, d) {
    if (d.type === 'token') {
      fetchToken(String(d.channel || ''), String(d.playerType || ''))
        .catch(() => null)
        .then((token) => {
          const reply = { type: 'tokenResult', id: d.id, ok: !!token, token };
          reply[MSG] = true;
          try {
            worker.postMessage(reply);
          } catch (err) {
            /* worker gone */
          }
        });
    } else if (d.type === 'adStart') {
      log(`Ad break on ${d.channel}${d.midroll ? ' (midroll)' : ''}, looking for an ad-free copy`);
      setNotice('Ad blocked · finding an ad-free stream…');
    } else if (d.type === 'adStatus') {
      log(d.mode === 'backup' ? `Showing ad-free copy (${d.playerType})` : 'No ad-free copy yet, holding until the break ends');
      setNotice(d.mode === 'backup' ? 'Ad blocked · showing an ad-free copy of the stream' : 'Ad blocked · stream resumes when the break ends');
    } else if (d.type === 'adEnd') {
      log(`Ad break over after ${Math.round(d.durationMs / 1000)}s`);
      setNotice(null);
      report('adBlocked', { durationMs: Number(d.durationMs) || 0, usedBackup: !!d.usedBackup });
      resyncPlayer(!!d.usedBackup);
    }
  }

  /* ---------- wrap window.Worker ---------- */

  function isTwitchWorkerUrl(href) {
    try {
      const u = new URL(href);
      const host = u.hostname || new URL(u.pathname).hostname; // blob:https://www.twitch.tv/<id>
      return /(^|\.)twitch\.tv$/.test(host) || /(^|\.)ttvnw\.net$/.test(host) || /(^|\.)twitchcdn\.net$/.test(host);
    } catch (err) {
      return false;
    }
  }

  function readSync(href) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', href, false);
      xhr.overrideMimeType('text/javascript');
      xhr.send();
      return xhr.status === 200 || xhr.status === 0 ? xhr.responseText : null;
    } catch (err) {
      return null;
    }
  }

  const NativeWorker = window.Worker;
  if (typeof NativeWorker !== 'function') return;

  class Worker extends NativeWorker {
    constructor(url, options) {
      let href = null;
      try {
        href = new URL(url, location.href).href;
      } catch (err) {
        href = null;
      }
      if (!href || !isTwitchWorkerUrl(href) || (options && options.type === 'module')) {
        super(url, options);
        return;
      }
      const original = href.startsWith('blob:') ? readSync(href) : null;
      const loader = original != null ? original : `importScripts(${JSON.stringify(href)});`;
      const seed = { tag: MSG, enabled: settings.enabled, forceAvc: settings.forceAvc, rules: workerRules(rules) };
      const source = `(${workerMain.toString()})(${JSON.stringify(seed)});\n${loader}`;
      super(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), options);
      this.addEventListener('message', (e) => {
        const d = e.data;
        if (d && d[MSG] === true) {
          e.stopImmediatePropagation();
          onWorkerMessage(this, d);
        }
      });
      workers.add(this);
      const terminate = this.terminate;
      this.terminate = function () {
        workers.delete(this);
        return terminate.apply(this, arguments);
      };
    }
  }

  let currentWorker = Worker;
  Object.defineProperty(window, 'Worker', {
    configurable: true,
    enumerable: false,
    get: () => currentWorker,
    set: (value) => {
      // Accept wrappers built on top of ours (other scripts), never a bare replacement.
      if (typeof value === 'function' && (value === Worker || value.prototype instanceof Worker)) currentWorker = value;
    },
  });

  log(`Active (rules ${rules.version})`);
})();
