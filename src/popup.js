(function () {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const BUILTIN_VERSION = (globalThis.TASRules && globalThis.TASRules.DEFAULT_RULES.version) || 'built-in';
  const DEFAULT_URL = (globalThis.TASRules && globalThis.TASRules.DEFAULT_RULES_URL) || '';
  // rulesUrl is null until the user changes it, which means "use the default address".
  const effectiveUrl = (s) => (s.rulesUrl === null || s.rulesUrl === undefined ? DEFAULT_URL : s.rulesUrl);
  const DEFAULTS = {
    enabled: true,
    forceAvc: true,
    adBreaks: 0,
    adMs: 0,
    heldBreaks: 0,
    lastBreak: null,
    rulesUrl: null,
    rules: null,
    rulesStatus: null,
  };
  const $ = (id) => document.getElementById(id);
  let urlDirty = false;

  function formatDuration(ms) {
    if ((ms || 0) < 60000) return `${Math.round((ms || 0) / 1000)}s`;
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function ago(ts) {
    if (!ts) return '';
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }

  function renderRules(s) {
    const pill = $('rulesVersion');
    const status = $('rulesStatus');
    const st = s.rulesStatus;
    const active = s.rules && s.rules.version ? s.rules.version : BUILTIN_VERSION;
    pill.textContent = s.rules ? `v${active}` : `v${active} built-in`;
    pill.className = 'pill';
    status.className = 'small';
    if (!effectiveUrl(s)) {
      status.textContent = 'Add the address of a hosted rules.json to keep detection current. It is checked every 6 hours.';
    } else if (!st) {
      status.textContent = 'Not checked yet.';
    } else if (st.state === 'ok') {
      pill.classList.add('ok');
      status.textContent = `Up to date · checked ${ago(st.checkedAt)}${st.updatedAt ? ` · last change ${ago(st.updatedAt)}` : ''}`;
    } else if (st.state === 'error') {
      pill.classList.add('err');
      status.classList.add('err');
      status.textContent = `Last check failed (${ago(st.checkedAt)}): ${st.error}. Still using v${active}.`;
    } else {
      status.textContent = `Using built-in rules · checked ${ago(st.checkedAt)}`;
    }
    if (!urlDirty) $('rulesUrl').value = effectiveUrl(s);
  }

  function renderHealth(s) {
    const el = $('health');
    const lb = s.lastBreak;
    const recent = lb && Date.now() - lb.at < 24 * 3600 * 1000;
    if (s.enabled !== false && recent && !lb.usedBackup) {
      el.textContent =
        'The last ad break had no ad-free copy, so the stream paused until it ended. If this keeps happening, Twitch may have changed something: check for a rules update.';
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function render(s) {
    $('enabled').checked = s.enabled !== false;
    $('forceAvc').checked = s.forceAvc !== false;
    $('forceAvc').disabled = s.enabled === false;
    $('breaks').textContent = Number(s.adBreaks || 0).toLocaleString();
    $('time').textContent = formatDuration(s.adMs);
    const status = $('status');
    status.textContent = s.enabled === false ? 'Off' : 'Active on twitch.tv';
    status.classList.toggle('off', s.enabled === false);
    renderRules(s);
    renderHealth(s);
  }

  function load() {
    return api.storage.local.get(DEFAULTS).then(render);
  }

  function onToggle(key) {
    return (e) => {
      api.storage.local.set({ [key]: e.target.checked }).then(load);
      $('reloadHint').hidden = false;
    };
  }

  $('enabled').addEventListener('change', onToggle('enabled'));
  $('forceAvc').addEventListener('change', onToggle('forceAvc'));

  $('rulesUrl').addEventListener('input', () => {
    urlDirty = true;
  });

  $('rulesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('rulesUrl');
    const value = input.value.trim();
    if (value) {
      let ok = false;
      try {
        ok = new URL(value).protocol === 'https:';
      } catch (err) {
        ok = false;
      }
      if (!ok) {
        $('rulesStatus').className = 'small err';
        $('rulesStatus').textContent = 'Use a full https:// address.';
        return;
      }
    }
    const btn = $('checkNow');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    // Clearing the address goes back to the built-in rules; the default address is stored as null
    // so a future change of default (in a new version) is picked up automatically.
    // (Stored as "unset".)
    if (!value) await api.storage.local.set({ rulesUrl: '', rules: null });
    else if (value === DEFAULT_URL) await api.storage.local.remove('rulesUrl');
    else await api.storage.local.set({ rulesUrl: value });
    urlDirty = false;
    try {
      await api.runtime.sendMessage({ type: 'checkRules' });
    } catch (err) {
      /* background unavailable; status shows the last result */
    }
    btn.disabled = false;
    btn.textContent = 'Check now';
    load();
  });

  $('reset').addEventListener('click', () => {
    api.storage.local.set({ adBreaks: 0, adMs: 0, heldBreaks: 0, lastBreak: null }).then(load);
  });

  $('reload').addEventListener('click', async () => {
    const tabs = await api.tabs.query({ url: ['*://*.twitch.tv/*'] });
    await Promise.all(tabs.map((t) => api.tabs.reload(t.id)));
    $('reloadHint').hidden = true;
    $('reload').textContent = tabs.length ? `Reloaded ${tabs.length} tab${tabs.length === 1 ? '' : 's'}` : 'No Twitch tabs open';
    setTimeout(() => {
      $('reload').textContent = 'Reload Twitch tabs';
    }, 2000);
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') load();
  });

  load();
})();
