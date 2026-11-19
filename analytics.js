'use strict';
const ANALYTICS_ENDPOINT = 'https://lair-analytics.lair-tools-282.workers.dev';
async function analyticsId() {
  const { lairAnalyticsId } = await chrome.storage.local.get('lairAnalyticsId');
  if (lairAnalyticsId) return lairAnalyticsId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ lairAnalyticsId: id });
  return id;
}
async function trackLair(event) {
  try {
    const id = await analyticsId();
    const payload = { id, event, version: chrome.runtime.getManifest().version, at: Date.now() };
    const { lairQueue = [] } = await chrome.storage.local.get('lairQueue');
    const queue = [...lairQueue, payload].slice(-100);
    await chrome.storage.local.set({ lairQueue: queue });
    await flushLairQueue();
  } catch (_) {}
}
async function flushLairQueue() {
  const { lairQueue = [] } = await chrome.storage.local.get('lairQueue');
  if (!lairQueue.length) return;
  try {
    const r = await fetch(ANALYTICS_ENDPOINT + '/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: lairQueue })
    });
    if (r.ok) await chrome.storage.local.set({ lairQueue: [] });
  } catch (_) {}
}
