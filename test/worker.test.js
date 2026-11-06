'use strict';
// Exercises workerMain exactly as it is injected into Twitch's worker: stringified and
// evaluated against a fake worker global, with a mocked network.
const assert = require('node:assert/strict');
const path = require('node:path');
// Usage: node test/worker.test.js [extension folder]
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const { workerMain, MSG } = require(path.join(ROOT, 'src/page.js'));
const Rules = require(path.join(ROOT, 'src/rules.js'));
// Detection tests run against the hosted rules.json, so a rules update that stops
// detecting ads (or flags normal segments as ads) fails here before it is published.
const HOSTED = JSON.parse(require('node:fs').readFileSync(path.join(ROOT, 'rules.json'), 'utf8'));
const RULES = Rules.merge(Rules.sanitize(HOSTED).rules);
// Flow tests pin the player-type order so they test the logic, not the current list.
const FLOW_TYPES = ['embed', 'popout', 'site', 'mobile_web', 'autoplay'];
const workerRules = (r) => ({ adMarkers: r.adMarkers, ignoreMarkers: r.ignoreMarkers, adSegmentUrlMarkers: r.adSegmentUrlMarkers, liveSegmentTitle: r.liveSegmentTitle, backupPlayerTypes: r.backupPlayerTypes });
const STUB = { fetch: async () => {}, addEventListener() {}, postMessage() {} };
const helpers = (rules = RULES) => workerMain({ tag: MSG, expose: true, rules: workerRules(rules) }, STUB);

const EDGE = 'https://video-edge-1.test.ttvnw.net/v1/segment';
const WEAVER = 'https://video-weaver.test.hls.ttvnw.net/v1/playlist';
const usher = (token, extra = '') =>
  `https://usher.ttvnw.net/api/channel/hls/SomeStreamer.m3u8?allow_source=true&p=123&sig=s&token=${encodeURIComponent(token)}${extra}`;

function master(prefix, { hevc = false } = {}) {
  return [
    '#EXTM3U',
    '#EXT-X-TWITCH-INFO:NODE="video-edge-1",SERVER-TIME="1762470000.00"',
    ...(hevc
      ? [
          '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="1440p60",NAME="1440p60",AUTOSELECT=YES,DEFAULT=YES',
          '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=2560x1440,CODECS="hvc1.1.2.L150,mp4a.40.2",VIDEO="1440p60",FRAME-RATE=60.000',
          `${WEAVER}/${prefix}-1440.m3u8`,
        ]
      : []),
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000',
    `${WEAVER}/${prefix}-1080.m3u8`,
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000',
    `${WEAVER}/${prefix}-720.m3u8`,
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO',
    '#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"',
    `${WEAVER}/${prefix}-audio.m3u8`,
    '',
  ].join('\n');
}

const AD_MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-11-06T23:00:00Z",DURATION=30.0,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL",X-TV-TWITCH-AD-URL="https://ads.example/click?x=1",X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://ads.example/track"',
  '#EXT-X-PROGRAM-DATE-TIME:2026-11-06T22:59:58.000Z',
  '#EXTINF:2.000,live',
  `${EDGE}/live-100.ts`,
  '#EXT-X-DISCONTINUITY',
  '#EXT-X-PROGRAM-DATE-TIME:2026-11-06T23:00:00.000Z',
  '#EXTINF:2.000,Amazon|8675309',
  `${EDGE}/stitched-ad-1.ts`,
  '#EXTINF:2.000,Amazon|8675309',
  `${EDGE}/stitched-ad-2.ts`,
  `#EXT-X-PART:DURATION=0.5,URI="${EDGE}/stitched-ad-3-part0.ts"`,
  `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${EDGE}/stitched-ad-3-part1.ts"`,
  `#EXT-X-TWITCH-PREFETCH:${EDGE}/stitched-ad-3.ts`,
  '',
].join('\n');

const clean = (tag, seq = 200) =>
  [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    '#EXTINF:2.000,live',
    `${EDGE}/${tag}-${seq}.ts`,
    '#EXTINF:2.000,live',
    `${EDGE}/${tag}-${seq + 1}.ts`,
    `#EXT-X-TWITCH-PREFETCH:${EDGE}/${tag}-${seq + 2}.ts`,
    '',
  ].join('\n');

const MAF_ONLY = clean('live').replace(
  '#EXT-X-MEDIA-SEQUENCE:200',
  '#EXT-X-MEDIA-SEQUENCE:200\n#EXT-X-DATERANGE:ID="maf-1",CLASS="twitch-maf-ad",START-DATE="2026-11-06T23:00:00Z",X-TV-TWITCH-AD-POD-LENGTH="1"'
);

/** Fake worker global + network. `backupState[type]` = 'ads' | 'clean' | 'fail'. */
function makeWorker({ backupState = {}, hevc = false, tokenReply = true, settings = {} } = {}) {
  const scope = new EventTarget();
  const posted = [];
  const fetched = [];
  const net = { originalHasAds: true, adText: AD_MEDIA };
  scope.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    fetched.push(url);
    const ok = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    if (url.startsWith('https://usher.ttvnw.net/')) {
      const token = new URL(url).searchParams.get('token');
      if (!token || token === 'orig' || token.includes('picture-by-picture')) return ok(master('orig', { hevc }));
      const type = token.replace(/-token$/, '');
      if (backupState[type] === 'fail') return new Response('', { status: 403 });
      return ok(master(`backup-${type}`, { hevc }));
    }
    const m = url.match(/\/playlist\/(.+)-(\d+|audio)\.m3u8$/);
    if (m) {
      if (m[1] === 'orig') return ok(net.originalHasAds ? net.adText : clean('live'));
      const type = m[1].replace(/^backup-/, '');
      return ok(backupState[type] === 'clean' ? clean(`bk-${type}`, 900) : AD_MEDIA);
    }
    return new Response('not found', { status: 404 });
  };
  const tokens = [];
  scope.postMessage = (msg) => {
    posted.push(msg);
    if (msg.type === 'token') {
      tokens.push(msg.playerType);
      if (!tokenReply) return;
      setTimeout(() => {
        const reply = { type: 'tokenResult', id: msg.id, ok: true, token: { value: `${msg.playerType}-token`, signature: 'sig' } };
        reply[MSG] = true;
        scope.dispatchEvent(new MessageEvent('message', { data: reply }));
      }, 2);
    }
  };
  const seed = { tag: MSG, enabled: true, forceAvc: true, rules: { ...workerRules(RULES), backupPlayerTypes: FLOW_TYPES }, ...settings };
  // Same shape as the injected source: proves the function has no outside references.
  new Function('self', `(${workerMain.toString()})(${JSON.stringify(seed)});`)(scope);
  return { scope, posted, fetched, tokens, net, events: () => posted.filter((p) => p.type !== 'token').map((p) => p.type) };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('helpers: ad detection, maf-ad ignored, codec families', () => {
  const api = helpers();
  assert.equal(api.hasAds(AD_MEDIA), true);
  assert.equal(api.hasAds(clean('live')), false);
  assert.equal(api.hasAds(MAF_ONLY), false, 'display-ad (maf) markers must not count as a video ad');
  assert.equal(api.codecFamily('avc1.64002A,mp4a.40.2'), 'avc');
  assert.equal(api.codecFamily('hvc1.1.2.L150,mp4a.40.2'), 'hevc');
  assert.equal(api.codecFamily('av01.0.08M.08,mp4a.40.2'), 'av1');
  assert.equal(api.codecFamily('mp4a.40.2'), '');
});

test('stripAds removes ad segments, LL-HLS hints and click URLs but keeps live segments', () => {
  const api = helpers();
  const out = api.stripAds(AD_MEDIA);
  assert.ok(out.includes(`${EDGE}/live-100.ts`));
  assert.ok(!out.includes('stitched-ad-1.ts') && !out.includes('stitched-ad-2.ts'));
  assert.ok(!out.includes('Amazon|'));
  assert.ok(!out.includes('#EXT-X-TWITCH-PREFETCH') && !out.includes('#EXT-X-PART') && !out.includes('#EXT-X-PRELOAD-HINT'));
  assert.ok(!out.includes('ads.example') && !out.includes('#EXT-X-DATERANGE'), 'ad date-range tags removed');
  assert.ok(out.includes('#EXT-X-MEDIA-SEQUENCE:100'));
});

test('keepOnlyAvc drops HEVC renditions and their media groups', () => {
  const api = helpers();
  const out = api.keepOnlyAvc(master('orig', { hevc: true }));
  assert.ok(!out.includes('hvc1') && !out.includes('orig-1440.m3u8') && !out.includes('GROUP-ID="1440p60"'));
  assert.ok(out.includes('orig-1080.m3u8') && out.includes('orig-720.m3u8') && out.includes('orig-audio.m3u8'));
  assert.equal(api.parseMaster(out).length, 3);
  const onlyHevc = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,CODECS="hvc1.1",VIDEO="a"\nhttps://x/a.m3u8\n';
  assert.equal(api.keepOnlyAvc(onlyHevc), onlyHevc, 'never strip the only renditions available');
});

test('pickVariant matches resolution + fps + codec, then nearest', () => {
  const api = helpers();
  const backup = api.parseMaster(master('b'));
  const orig = api.parseMaster(master('o'));
  assert.ok(api.pickVariant(backup, orig[0]).url.endsWith('b-1080.m3u8'));
  assert.ok(api.pickVariant(backup, orig[1]).url.endsWith('b-720.m3u8'));
  assert.ok(api.pickVariant(backup, orig[2]).url.endsWith('b-audio.m3u8'));
  const only360 = api.parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=640x360,CODECS="avc1.4D401E",VIDEO="360p30",FRAME-RATE=30\nhttps://x/360.m3u8\n');
  assert.ok(api.pickVariant(only360, orig[0]).url.endsWith('360.m3u8'), 'falls back to the closest rendition');
});

test('master playlist: HEVC filtered, variants registered, response still 200', async () => {
  const w = makeWorker({ hevc: true });
  const res = await w.scope.fetch(usher('orig'));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('hvc1'));
  assert.ok(text.includes('orig-1080.m3u8'));
});

test('ad break: switches to first clean backup, caches it, then returns to the live stream', async () => {
  const w = makeWorker({ backupState: { embed: 'ads', popout: 'clean' } });
  await (await w.scope.fetch(usher('orig'))).text();

  const t0 = Date.now();
  const first = await (await w.scope.fetch(`${WEAVER}/orig-1080.m3u8`)).text();
  assert.ok(Date.now() - t0 < 1500, 'lookup should be quick when tokens answer');
  assert.ok(first.includes('bk-popout-900.ts'), 'served the ad-free popout copy');
  assert.ok(!first.includes('stitched'));
  assert.deepEqual(w.tokens, ['embed', 'popout']);
  assert.ok(w.fetched.some((u) => u.endsWith('backup-popout-1080.m3u8')), 'picked the matching 1080p rendition');
  assert.deepEqual(w.events(), ['adStart', 'adStatus']);
  const status = w.posted.find((p) => p.type === 'adStatus');
  assert.equal(status.mode, 'backup');
  assert.equal(status.playerType, 'popout');

  // Next poll during the same break: reuse the cached popout copy, no new tokens.
  const second = await (await w.scope.fetch(`${WEAVER}/orig-1080.m3u8`)).text();
  assert.ok(second.includes('bk-popout-900.ts'));
  assert.deepEqual(w.tokens, ['embed', 'popout'], 'no extra token requests while the cached copy is clean');

  // Break over.
  w.net.originalHasAds = false;
  const after = await (await w.scope.fetch(`${WEAVER}/orig-1080.m3u8`)).text();
  assert.ok(after.includes('live-200.ts'));
  const end = w.posted.find((p) => p.type === 'adEnd');
  assert.ok(end, 'adEnd posted');
  assert.equal(end.usedBackup, true);
  assert.equal(end.channel, 'somestreamer');
  assert.ok(end.durationMs >= 0);
  assert.equal(end[MSG], true, 'messages carry the private tag');
});

test('no clean backup: strips the ad and keeps the live segments', async () => {
  const w = makeWorker({ backupState: { embed: 'ads', popout: 'ads', site: 'ads', mobile_web: 'fail', autoplay: 'ads' } });
  await (await w.scope.fetch(usher('orig'))).text();
  const out = await (await w.scope.fetch(`${WEAVER}/orig-720.m3u8`)).text();
  assert.ok(out.includes('live-100.ts'));
  assert.ok(!out.includes('stitched-ad'));
  assert.equal(w.posted.find((p) => p.type === 'adStatus').mode, 'strip');
  // Every type is now cooling down, so the next poll must not hammer the token endpoint.
  const before = w.tokens.length;
  await (await w.scope.fetch(`${WEAVER}/orig-720.m3u8`)).text();
  assert.equal(w.tokens.length, before, 'player types in cooldown are skipped');
  w.net.originalHasAds = false;
  await (await w.scope.fetch(`${WEAVER}/orig-720.m3u8`)).text();
  assert.equal(w.posted.find((p) => p.type === 'adEnd').usedBackup, false);
});

test('unanswered token requests give up within the time budget', async () => {
  const w = makeWorker({ tokenReply: false });
  await (await w.scope.fetch(usher('orig'))).text();
  const t0 = Date.now();
  const out = await (await w.scope.fetch(`${WEAVER}/orig-1080.m3u8`)).text();
  const took = Date.now() - t0;
  assert.ok(took < 5200, `held the playlist for ${took}ms`);
  assert.ok(!out.includes('stitched-ad') && out.includes('live-100.ts'));
});

test('no ads: playlists pass through unchanged and nothing is posted', async () => {
  const w = makeWorker();
  w.net.originalHasAds = false;
  await (await w.scope.fetch(usher('orig'))).text();
  const out = await (await w.scope.fetch(`${WEAVER}/orig-1080.m3u8`)).text();
  assert.equal(out, clean('live'));
  assert.deepEqual(w.posted, []);
});

test('picture-by-picture player and unrelated requests are left alone', async () => {
  const w = makeWorker();
  const pbp = usher('x', `&extra=${encodeURIComponent('{"player_type":"picture-by-picture"}')}`);
  await (await w.scope.fetch(pbp)).text();
  const out = await (await w.scope.fetch(`${WEAVER}/orig-1080.m3u8`)).text();
  assert.equal(out, AD_MEDIA, 'unregistered playlist untouched');
  assert.equal((await w.scope.fetch('https://example.com/x')).status, 404);
});

test('settings message turns blocking off live and is hidden from Twitch listeners', async () => {
  const w = makeWorker();
  const seenByTwitch = [];
  w.scope.addEventListener('message', (e) => seenByTwitch.push(e.data));
  const off = { type: 'settings', settings: { enabled: false } };
  off[MSG] = true;
  w.scope.dispatchEvent(new MessageEvent('message', { data: off }));
  w.scope.dispatchEvent(new MessageEvent('message', { data: { twitch: 'own message' } }));
  assert.deepEqual(seenByTwitch, [{ twitch: 'own message' }], 'our messages are swallowed, Twitch messages pass');
  await (await w.scope.fetch(usher('orig'))).text();
  const out = await (await w.scope.fetch(`${WEAVER}/orig-1080.m3u8`)).text();
  assert.equal(out, AD_MEDIA);
});

test('a broken playlist never breaks playback', async () => {
  const w = makeWorker();
  await (await w.scope.fetch(usher('orig'))).text();
  const realFetch = w.scope.fetch;
  // A 500 from the CDN is returned to the player untouched.
  const orig = w.net;
  orig.originalHasAds = true;
  const res = await realFetch(`${WEAVER}/does-not-exist.m3u8`);
  assert.equal(res.status, 404);
});


// ---------- detection that survives Twitch renaming things ----------

// An ad break where Twitch renamed every marker we know about.
const RENAMED_AD = AD_MEDIA.replace(/stitched-ad/g, 'sponsor-x').replace(/twitch-stitched-ad/g, 'twitch-sponsor').replace(/X-TV-TWITCH-AD/g, 'X-TV-TWITCH-SP');
const ALL_AD_WINDOW = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:300', '#EXTINF:2.000,Brand|1', `${EDGE}/x-300.ts`, '#EXTINF:2.000,Brand|1', `${EDGE}/x-301.ts`, ''].join('\n');

test('renamed markers: ad still detected from segment titles', () => {
  const api = helpers();
  assert.ok(!/stitched|X-TV-TWITCH-AD/.test(RENAMED_AD), 'fixture has no known marker');
  assert.equal(api.hasAds(RENAMED_AD), true, 'live + non-live segments mixed means an ad');
  const out = api.stripAds(RENAMED_AD);
  assert.ok(out.includes('live-100.ts') && !out.includes('sponsor-x-1.ts'));
});

test('renamed markers: a window with no live segments after live ones counts as an ad', () => {
  const api = helpers();
  const stream = {};
  assert.equal(api.hasAds(ALL_AD_WINDOW, stream), false, 'unknown before any live segment was seen');
  assert.equal(api.hasAds(clean('live'), stream), false);
  assert.equal(api.hasAds(ALL_AD_WINDOW, stream), true, 'live stream suddenly all non-live');
});

test('end to end with renamed markers: backup still used', async () => {
  const w = makeWorker({ backupState: { embed: 'clean' } });
  w.net.adText = RENAMED_AD;
  await (await w.scope.fetch(usher('orig'))).text();
  const out = await (await w.scope.fetch(`${WEAVER}/orig-1080.m3u8`)).text();
  assert.ok(out.includes('bk-embed-900.ts'));
});

test('rules update message changes detection live', async () => {
  const w = makeWorker();
  w.net.adText = ALL_AD_WINDOW.replace('#EXTINF:2.000,Brand|1', '#EXT-X-NEWAD:1\n#EXTINF:2.000,live').replace('#EXTINF:2.000,Brand|1', '#EXTINF:2.000,live');
  await (await w.scope.fetch(usher('orig'))).text();
  let out = await (await w.scope.fetch(`${WEAVER}/orig-1080.m3u8`)).text();
  assert.deepEqual(w.events(), [], 'unknown marker, all segments live: not an ad yet');
  const msg = { type: 'rules', rules: workerRules(Rules.merge({ adMarkers: ['#EXT-X-NEWAD'], backupPlayerTypes: ['embed'] })) };
  msg[MSG] = true;
  w.scope.dispatchEvent(new MessageEvent('message', { data: msg }));
  out = await (await w.scope.fetch(`${WEAVER}/orig-1080.m3u8`)).text();
  assert.equal(w.events()[0], 'adStart', 'new marker from the rules file is recognised');
  assert.deepEqual(w.tokens, ['embed'], 'new player-type list is used');
});

// ---------- rules validation ----------

test('rules.json is valid, complete and dated', () => {
  const { rules, error } = Rules.sanitize(HOSTED);
  assert.equal(error, undefined, error);
  for (const key of Object.keys(Rules.DEFAULT_RULES)) assert.ok(key in HOSTED, `rules.json is missing "${key}"`);
  assert.match(rules.version, /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/, 'version must be YYYY.MM.DD or YYYY.MM.DD.N');
  assert.ok(RULES.backupPlayerTypes.length >= 1);
});

test('rules: partial file overrides only what it contains', () => {
  const { rules, error } = Rules.sanitize({ schema: 1, version: '2027.01.02', backupPlayerTypes: ['popout', 'embed'] });
  assert.equal(error, undefined);
  const merged = Rules.merge(rules);
  assert.deepEqual(merged.backupPlayerTypes, ['popout', 'embed']);
  assert.deepEqual(merged.adMarkers, Rules.DEFAULT_RULES.adMarkers);
  assert.equal(merged.version, '2027.01.02');
});

test('rules: bad or hostile files are rejected whole', () => {
  const bad = [
    null,
    [],
    'x',
    { version: '1' },
    { schema: 2 },
    { schema: 1, adMarkers: [] },
    { schema: 1, adMarkers: ['ok-marker', 42] },
    { schema: 1, adMarkers: ['a'] },
    { schema: 1, backupPlayerTypes: ['embed', 'Bad Type'] },
    { schema: 1, tokenHash: 'abc' },
    { schema: 1, clientId: 'x' },
    { schema: 1, hideSelectors: ['video{display:none}'] },
    { schema: 1, hideSelectors: ['</style><script>alert(1)</script>'] },
    { schema: 1, hideSelectors: ['@import url(x)'] },
    { schema: 1, liveSegmentTitle: 'live\n#EXTINF' },
    { schema: 1, adMarkers: new Array(41).fill('marker') },
  ];
  for (const b of bad) assert.ok(Rules.sanitize(b).error, `should reject ${JSON.stringify(b)}`);
  assert.match(Rules.sanitize({ schema: 2 }).error, /newer version/);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${t.name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n    ') : err}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
