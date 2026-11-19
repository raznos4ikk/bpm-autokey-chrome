importScripts('analytics.js');
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Анализ звука вкладки: определение BPM и тональности',
  });
}

// Сразу после создания документа он может ещё не слушать сообщения — поэтому несколько попыток.
async function toOffscreen(msg, tries = 10) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
      if (r !== undefined) return r;
    } catch (e) { lastErr = e; }
    await sleep(120);
  }
  throw lastErr || new Error('Модуль анализа не отвечает');
}

async function getCap() {
  const { cap } = await chrome.storage.session.get('cap');
  return cap || null;
}

async function getStatus() {
  let cap = await getCap();
  if (cap && !(await hasOffscreen())) {
    await chrome.storage.session.remove(['cap', 'last']);
    cap = null;
  }
  const { last } = await chrome.storage.session.get('last');
  return { cap, last: last || null };
}

async function startCapture({ tabId, streamId, title }) {
  await ensureOffscreen();
  const r = await toOffscreen({ type: 'start', tabId, streamId });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Не удалось запустить захват' };
  await chrome.storage.session.set({ cap: { tabId, title: title || '' } });
  trackLair('analysis_started');
  await chrome.storage.session.remove('last');
  return { ok: true };
}

async function stopCapture() {
  if (await hasOffscreen()) {
    try { await toOffscreen({ type: 'stop' }, 2); } catch (e) { /* документ всё равно закроем */ }
    try { await chrome.offscreen.closeDocument(); } catch (e) {}
  }
  await chrome.storage.session.remove(['cap', 'last']);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  // свежий результат от анализатора: запоминаем, чтобы popup мог показать его сразу при открытии
  if (msg.from === 'offscreen') {
    if (msg.type === 'result') chrome.storage.session.set({ last: { tabId: msg.tabId, data: msg.data, at: Date.now() } });
    if (msg.type === 'ended') chrome.storage.session.remove(['cap', 'last']);
    return false;
  }

  if (msg.target !== 'background') return false;
  (async () => {
    try {
      if (msg.type === 'status') sendResponse(await getStatus());
      else if (msg.type === 'start') sendResponse(await startCapture(msg));
      else if (msg.type === 'stop') sendResponse(await stopCapture());
      else if (msg.type === 'reset') {
        const r = await toOffscreen({ type: 'reset' }, 2);
        await chrome.storage.session.remove('last');
        sendResponse(r);
      } else sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

// Вкладку закрыли — останавливаем захват
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const cap = await getCap();
  if (cap && cap.tabId === tabId) await stopCapture();
});

// Welcome action: open the creator's SoundCloud track once after a fresh install.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    trackLair('install');
    chrome.tabs.create({ url: chrome.runtime.getURL('player.html') });
  }
});

chrome.runtime.onStartup.addListener(() => { trackLair('startup'); flushLairQueue(); });
chrome.alarms.create('lair-analytics-flush', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'lair-analytics-flush') flushLairQueue(); });
