# Twitch Ad Skipper

A browser extension that blocks the video ads Twitch puts into live streams.

Twitch doesn't load ads as a separate video. It stitches them straight into the
stream's own playlist, so normal ad blockers have nothing to block. During an ad
break, this extension asks Twitch for the same stream under a different player
type (embed, popout, and so on), which is often served without the ad, and plays
that instead. If no ad-free copy is available, it removes the ad segments, so the
stream pauses until the break ends instead of playing the ad. When the break
ends, it rejoins the normal stream.

A small notice appears on the player while a break is being blocked.

## Install

**Chrome, Edge, Brave, Opera (version 121 or later)**

1. Unzip the folder somewhere permanent. The browser loads it from there, so don't delete it.
2. Open `chrome://extensions` (`edge://extensions` in Edge).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `twitch-ad-skipper` folder.
5. Reload any open Twitch tabs.

**Firefox (version 128 or later)**

1. Open `about:debugging#/runtime/this-firefox` and click **Load Temporary Add-on**.
2. Select `manifest.json` in the folder.
3. Click the extension's icon, then **Always allow on twitch.tv**.

Firefox removes temporary add-ons when it closes. To keep it installed, sign it
as an unlisted add-on on addons.mozilla.org (free).

Don't run this alongside another Twitch ad blocker (TTV LOL, Purple AdBlock,
uBlock's Twitch scripts, and so on). They hook the same player and interfere
with each other. A general blocker like uBlock Origin is fine.

## Keeping up with Twitch: auto-updating rules

Twitch changes how it marks ads every few months. The values that change most
often live in a small **rules file** instead of in the code:

| Field | What it is |
|---|---|
| `adMarkers` | Text in a playlist that means an ad break is in progress |
| `ignoreMarkers` | Ad-related tags that are *not* video ads (display ads beside the player) |
| `adSegmentUrlMarkers` | Text in a segment's address that marks it as an ad |
| `liveSegmentTitle` | The title Twitch gives real stream segments (`live`) |
| `backupPlayerTypes` | Player types to request an ad-free copy under, in order |
| `clientId`, `tokenHash` | Values used to request a playback token |
| `hideSelectors` | Page elements to hide (small display ads) |

**How it updates:** by default the extension downloads this repo's `rules.json`
from
`https://raw.githubusercontent.com/shubhpetal/twitch-ad-skipper/main/rules.json`
every 6 hours and when the browser starts. New rules reach open Twitch tabs
right away, with no reload needed. A scheduled task checks every night whether
Twitch has changed something. When it has, the task opens a pull request with
the updated `rules.json` and notifies you, and merging that pull request
publishes the update (see [MAINTAINING.md](MAINTAINING.md)). You can also edit
the file by hand: change the value, bump `version`, run `npm test`, push.

To use a different rules file, paste its https address into the popup under
**Detection rules** and click **Check now**. Clearing the field switches to
built-in rules only. A rules file only needs the fields it changes, because
missing fields keep their built-in values.

**Safety:** the rules file is data only, never code. Every download is checked
field by field, and a file with anything invalid is rejected whole, so the last
good rules stay in use. A broken or tampered file can stop ad blocking, but it
can't run code in your browser or read your Twitch data.

**What updates itself without the rules file:**

- **Header values and query hash:** the client ID and query hash Twitch's own
  page uses are picked up automatically and take priority.
- **Player type order:** the player type that worked last time is tried first,
  and failing ones are paused for 15 seconds.
- **Renamed markers:** ads are recognised by structure as well as by marker.
  Segments not titled `live` appearing in a live stream count as an ad even if
  Twitch renames every marker.

**What still needs a code update:** a change to how Twitch's player itself works
(for example, if it stopped using a Web Worker or changed the token request).
The popup warns you if the last ad break had no ad-free copy. If that keeps
happening, check the rules first, then the code.

## Settings

- **Block ads:** turn the extension off or on. Takes effect when Twitch is reloaded.
- **Use H.264 streams:** hides the HEVC/AV1 qualities some channels offer (for
  example 1440p). The ad-free copies are H.264, and switching codecs mid-stream
  causes black screens. Turn this off if you'd rather keep the higher qualities
  and accept the occasional black screen during breaks.

## Troubleshooting

- **Brief buffering or a short replay when a break ends:** expected. The player
  reloads to rejoin the normal stream.
- **Lower quality during a break:** the only ad-free copy available was a lower
  quality one. It returns to normal after the break.
- **Stream pauses for the whole break:** no ad-free copy was available, so the
  ad was removed instead of replaced.
- **Ads still play:** make sure no other Twitch ad blocker is installed, reload
  the tab, and click **Check now** in the popup. Console messages are tagged
  `[Ad Skipper]` (open DevTools, then Console, with *Verbose* enabled).

## Privacy

The extension sends nothing anywhere except to Twitch's own servers, which the
player talks to anyway, and to your rules address if you set one. Statistics
stay in the browser.

## Updating the extension itself

Rules update on their own; code changes don't, because unpacked extensions
can't update themselves. When a code fix is merged here, run `git pull` in your
copy (or download the repo again), then click the reload icon on the extension
in `chrome://extensions`.

## Tests

```
npm test               # playlist logic against the current rules.json (Node only)
npm run test:browser   # full run in Chrome against a simulated Twitch (needs Playwright + Chrome)
```

## Files

```
manifest.json      extension manifest (Manifest V3)
rules.json         the published rules file every installed copy downloads
MAINTAINING.md     how rules are kept current, and what the daily check does
maintenance/       last upstream version checked
test/              test suites
src/rules.js       built-in rules and the validator for downloaded rules
src/page.js        runs in the page: wraps Twitch's player worker, handles ad breaks
src/bridge.js      relays settings and rules into the page and stats back out
src/background.js  downloads and validates the rules file on a schedule
src/popup.*        toolbar popup
```
