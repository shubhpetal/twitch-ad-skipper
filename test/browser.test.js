'use strict';
// Loads the unpacked extension into real Chrome and runs it against a simulated
// Twitch: a fake player worker built from a blob (like Twitch's), plus mocked
// GQL tokens, usher master playlists and media playlists with an ad break.
// Usage: node test/browser.test.js [extension folder] [screenshot folder]
// PLAYWRIGHT_PATH and CHROME_PATH override where Playwright and Chrome are found.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const SHOTS = path.resolve(process.argv[3] || require('node:os').tmpdir());
const EDGE = 'https://video-edge-1.test.ttvnw.net/v1/segment';
const WEAVER = 'https://video-weaver.test.hls.ttvnw.net/v1/playlist';

const master = (p) =>
  [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="1440p60",NAME="1440p60",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=2560x1440,CODECS="hvc1.1.2.L150,mp4a.40.2",VIDEO="1440p60",FRAME-RATE=60.000',
    `${WEAVER}/${p}-1440.m3u8`,
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000',
    `${WEAVER}/${p}-1080.m3u8`,
    '',
  ].join('\n');
const AD = [
  '#EXTM3U',
  '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-11-06T23:00:00Z",X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"',
  '#EXTINF:2.000,live',
  `${EDGE}/live-100.ts`,
  '#EXTINF:2.000,Amazon|1',
  `${EDGE}/stitched-ad-1.ts`,
  '',
].join('\n');
const clean = (tag) => ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:200', '#EXTINF:2.000,live', `${EDGE}/${tag}-200.ts`, ''].join('\n');

// What the fake Twitch page does: one GQL call (so the extension can learn the
// headers), then a player worker created from a blob URL that polls playlists.
const PAGE = `<!doctype html><html><head><title>Fake Twitch</title></head><body>
<div id="root"><div class="video-player" style="position:relative;width:640px;height:360px;background:#000"></div></div>
<script>
window.__fromWorker = [];
fetch('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'X-Device-Id': 'dev123', 'Client-Version': 'v-test', 'Authorization': 'OAuth secret' },
  body: JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { login: 'teststreamer', playerType: 'site' }, extensions: { persistedQuery: { version: 1, sha256Hash: '${'a'.repeat(64)}' } } }) });
const src = \`
  let mediaUrl = null;
  self.addEventListener('message', async (e) => {
    if (e.data && e.data.cmd === 'poll') {
      const t = await (await fetch(mediaUrl)).text();
      postMessage({ kind: 'media', text: t });
    }
  });
  (async () => {
    const m = await (await fetch('https://usher.ttvnw.net/api/channel/hls/teststreamer.m3u8?allow_source=true&sig=x&token=orig')).text();
    mediaUrl = m.split('\\\\n').find((l) => l.startsWith('https://'));
    postMessage({ kind: 'master', text: m, mediaUrl });
  })();
\`;
const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
const w = new Worker(url);
URL.revokeObjectURL(url); // Twitch revokes too; our wrapper must not depend on it afterwards
w.onmessage = (e) => window.__fromWorker.push(e.data);
window.__poll = () => w.postMessage({ cmd: 'poll' });
window.__workerIsNative = Worker.toString().includes('[native code]');
</script></body></html>`;

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-'));
  const context = await chromium.launchPersistentContext(userDir, {
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(true);
      console.log(`  ✓ ${name}`);
    } catch (err) {
      results.push(false);
      console.log(`  ✗ ${name}\n    ${String(err && err.message).split('\n').slice(0, 4).join('\n    ')}`);
    }
  };

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = sw.url().split('/')[2];

  // ---- mocked Twitch network ----
  const net = { origPolls: 0, adPolls: 2, tokens: [], gqlHeaders: null, gqlBodies: [], rulesBody: null };
  await context.route('https://www.twitch.tv/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  await context.route('https://gql.twitch.tv/gql', async (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.variables && body.variables.playerType && body.variables.playerType !== 'site') {
      net.tokens.push(body.variables.playerType);
      net.gqlHeaders = r.request().headers();
      net.gqlBodies.push(body);
    }
    const type = body.variables && body.variables.playerType;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { streamPlaybackAccessToken: { value: `${type}-token`, signature: 'sig' } } }) });
  });
  await context.route('https://usher.ttvnw.net/**', (r) => {
    const token = new URL(r.request().url()).searchParams.get('token');
    const prefix = token === 'orig' ? 'orig' : `backup-${token.replace(/-token$/, '')}`;
    return r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: master(prefix) });
  });
  await context.route(`${WEAVER}/**`, (r) => {
    const name = r.request().url().split('/').pop();
    let body;
    if (name.startsWith('orig')) body = net.origPolls++ < net.adPolls ? AD : clean('live');
    else if (name.startsWith('backup-embed')) body = AD; // embed still has the ad
    else body = clean(`bk-${name.split('-')[1]}`); // popout is clean
    return r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body });
  });
  await context.route('https://raw.githubusercontent.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(EXT, 'rules.json'), 'utf8') })
  );
  await context.route('https://rules.example.test/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: net.rulesBody })
  );

  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  page.on('pageerror', (e) => consoleLines.push('PAGEERROR ' + e.message));
  await page.goto('https://www.twitch.tv/teststreamer');
  await page.waitForFunction(() => window.__fromWorker.some((m) => m.kind === 'master'), null, { timeout: 10000 });
  const poll = async () => {
    const n = await page.evaluate(() => window.__fromWorker.length);
    await page.evaluate(() => window.__poll());
    await page.waitForFunction((k) => window.__fromWorker.length > k, n, { timeout: 10000 });
    return page.evaluate(() => window.__fromWorker[window.__fromWorker.length - 1]);
  };

  await check('extension is injected and the worker is wrapped', async () => {
    assert.equal(await page.evaluate(() => typeof window.TASRules), 'undefined', 'rules global removed from page');
    assert.equal(await page.evaluate(() => window.__workerIsNative), false);
    assert.ok(consoleLines.some((l) => l.includes('[Ad Skipper]') && l.includes('Active')), consoleLines.join('\n'));
  });

  await check('master playlist reaches the player with HEVC renditions removed', async () => {
    const m = await page.evaluate(() => window.__fromWorker.find((x) => x.kind === 'master'));
    assert.ok(!m.text.includes('hvc1') && m.text.includes('orig-1080.m3u8'));
    assert.ok(m.mediaUrl.endsWith('orig-1080.m3u8'));
  });

  await check('ad break: player receives an ad-free copy, never the ad', async () => {
    const first = await poll();
    assert.ok(first.text.includes('bk-popout-200.ts'), first.text);
    assert.ok(!first.text.includes('stitched'));
    assert.deepEqual(net.tokens, ['embed', 'popout'], 'embed had the ad, popout was clean');
    const second = await poll();
    assert.ok(second.text.includes('bk-popout-200.ts'));
  });

  await check('token requests reuse Twitch\'s own headers and query hash', async () => {
    assert.equal(net.gqlHeaders['client-id'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
    assert.equal(net.gqlHeaders['x-device-id'], 'dev123');
    assert.equal(net.gqlHeaders['client-version'], 'v-test');
    assert.equal(net.gqlHeaders['authorization'], 'OAuth secret');
    assert.equal(net.gqlBodies[0].extensions.persistedQuery.sha256Hash, 'a'.repeat(64), 'hash learned from the page wins');
  });

  await check('on-player notice is shown during the break', async () => {
    const text = await page.textContent('#tas-notice');
    assert.match(text, /ad-free copy/);
    await page.screenshot({ path: path.join(SHOTS, 'notice.png'), clip: { x: 0, y: 0, width: 660, height: 380 } });
  });

  await check("Twitch's own worker listener never sees the extension's messages", async () => {
    const leaked = await page.evaluate(() => window.__fromWorker.filter((m) => m && m.__tasMsg));
    assert.deepEqual(leaked, []);
  });

  await check('break ends: real stream returns, notice clears, stats saved', async () => {
    const after = await poll();
    assert.ok(after.text.includes('live-200.ts'), after.text);
    await page.waitForFunction(() => !document.getElementById('tas-notice'), null, { timeout: 5000 });
    let stats;
    for (let i = 0; i < 20; i++) {
      stats = await sw.evaluate(() => chrome.storage.local.get(['adBreaks', 'adMs', 'heldBreaks', 'lastBreak']));
      if (stats.adBreaks) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(stats.adBreaks, 1);
    assert.equal(stats.heldBreaks, 0);
    assert.equal(stats.lastBreak.usedBackup, true);
  });

  await check('rules auto-update: downloaded, validated, pushed to the open tab live', async () => {
    net.rulesBody = JSON.stringify({ schema: 1, version: '2026.12.01', backupPlayerTypes: ['popout'], hideSelectors: ['.promo-thing'] });
    await sw.evaluate(() => chrome.storage.local.set({ rulesUrl: 'https://rules.example.test/rules.json' }));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup.html`);
    await popup.waitForFunction(() => document.getElementById('rulesUrl').value.startsWith('https://'));
    await popup.click('#checkNow');
    try {
      await popup.waitForFunction(() => document.getElementById('rulesVersion').textContent.includes('2026.12.01'), null, { timeout: 8000 });
    } catch (e) {
      console.log('DEBUG popup:', await popup.textContent('#rulesVersion'), '|', await popup.textContent('#rulesStatus'), '| input=', await popup.inputValue('#rulesUrl'));
      console.log('DEBUG storage:', JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(['rules', 'rulesStatus', 'rulesUrl']))));
      console.log('DEBUG sws:', context.serviceWorkers().map((w) => w.url()));
      throw e;
    }
    const status = await popup.textContent('#rulesStatus');
    assert.match(status, /Up to date/);
    await page.waitForFunction(() => document.getElementById('tas-cosmetic').textContent.includes('.promo-thing'), null, { timeout: 5000 });
    // New ad break uses the downloaded player-type list (popout only).
    net.origPolls = 0;
    net.tokens.length = 0;
    const r = await poll();
    assert.ok(r.text.includes('bk-popout-200.ts'));
    assert.ok(!net.tokens.includes('embed'), `tokens: ${net.tokens}`);
    await poll();
    await poll();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.screenshot({ path: path.join(SHOTS, 'popup.png'), fullPage: true });
    await popup.close();
  });

  await check('a broken rules file is rejected and the last good rules stay', async () => {
    net.rulesBody = JSON.stringify({ schema: 1, hideSelectors: ['body{display:none}'] });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup.html`);
    await popup.waitForFunction(() => document.getElementById('rulesUrl').value.startsWith('https://'));
    await popup.click('#checkNow');
    await popup.waitForFunction(() => /failed/.test(document.getElementById('rulesStatus').textContent), null, { timeout: 8000 });
    const s = await sw.evaluate(() => chrome.storage.local.get(['rules', 'rulesStatus']));
    assert.equal(s.rules.version, '2026.12.01');
    assert.match(s.rulesStatus.error, /hideSelectors/);
    await popup.screenshot({ path: path.join(SHOTS, 'popup-error.png'), fullPage: true });
    await popup.close();
  });

  await check('turning it off leaves Twitch untouched after reload', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
    await page.waitForTimeout(300);
    net.origPolls = 0;
    await page.reload();
    await page.waitForFunction(() => window.__fromWorker.some((m) => m.kind === 'master'), null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.__workerIsNative), true, 'Worker not wrapped when disabled');
    const r = await poll();
    assert.ok(r.text.includes('stitched'), 'ad passes through when disabled');
    await sw.evaluate(() => chrome.storage.local.set({ enabled: true }));
  });

  const errors = consoleLines.filter((l) => /PAGEERROR|Uncaught/.test(l));
  await check('no page errors', async () => assert.deepEqual(errors, []));

  await context.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
