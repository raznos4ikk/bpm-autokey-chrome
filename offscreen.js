'use strict';
/*
 * Живёт в offscreen-документе: popup закрывается при потере фокуса, а анализ должен продолжаться.
 * Захватывает звук вкладки, пропускает его в динамики без изменений и скармливает анализаторам.
 */
const SILENCE_RMS = 0.0004;     // ниже этого уровня считаем тишиной (около -68 дБ)
const RESET_AFTER_SILENCE = 6;  // после такой паузы (сек) начинаем анализ заново — скорее всего это новый трек

let ctx = null, stream = null, source = null, node = null;
let tempo = null, key = null, tabId = null, timer = null;
let heard = 0, silentSec = 0, didReset = false, level = 0, tick = 0;
let lastBpm = null, lastKey = null;

function broadcast(msg) {
  try { chrome.runtime.sendMessage({ from: 'offscreen', ...msg }).catch(() => {}); } catch (e) { /* получателей нет */ }
}

function resetEngines() {
  if (tempo) tempo.reset();
  if (key) key.reset();
  heard = 0;
  lastBpm = null;
  lastKey = null;
}

async function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  try { if (node) { node.port.onmessage = null; node.disconnect(); } } catch (e) {}
  try { if (source) source.disconnect(); } catch (e) {}
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { if (ctx) await ctx.close(); } catch (e) {}
  ctx = stream = source = node = null;
  tempo = key = null;
  tabId = null;
}

async function start({ streamId, tabId: id }) {
  await stop();
  tabId = id;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('worklet.js');
  source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  tempo = new BKDSP.TempoEngine(ctx.sampleRate);
  key = new BKDSP.KeyEngine(ctx.sampleRate);
  resetEngines();
  silentSec = 0; didReset = false; level = 0; tick = 0;

  node.port.onmessage = onAudio;
  source.connect(ctx.destination); // звук вкладки продолжает играть как обычно
  source.connect(node);
  node.connect(ctx.destination);   // выход ворклета пустой, нужен только чтобы граф работал
  if (ctx.state !== 'running') await ctx.resume();

  const track = stream.getAudioTracks()[0];
  if (track) {
    track.addEventListener('ended', () => {
      broadcast({ type: 'ended', tabId: id });
      stop();
    });
  }
  timer = setInterval(onTick, 500);
}

function onAudio(e) {
  const x = e.data;
  if (!tempo || !x) return;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const rms = Math.sqrt(s / x.length);
  const dur = x.length / ctx.sampleRate;
  const lv = rms > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 60)) : 0;
  level = lv > level ? lv : level * 0.9 + lv * 0.1;

  if (rms < SILENCE_RMS) {
    silentSec += dur;
    if (silentSec > RESET_AFTER_SILENCE && !didReset) { resetEngines(); didReset = true; }
    return;
  }
  silentSec = 0;
  didReset = false;
  heard += dur;
  tempo.push(x);
  key.push(x);
}

function onTick() {
  if (!tempo) return;
  tick++;
  try {
    if (tick % 2 === 0 && heard > 0) { // полный анализ раз в секунду
      lastBpm = tempo.analyze() || lastBpm;
      lastKey = key.analyze();
    }
  } catch (err) {
    console.error('analysis error', err);
  }

  const data = {
    heard: Math.round(heard * 10) / 10,
    level,
    silent: silentSec > 1.2,
    bpm: null,
    key: lastKey ? { status: lastKey.status } : { status: 'waiting' },
  };
  if (lastBpm) {
    data.bpm = {
      value: lastBpm.bpm,
      conf: lastBpm.conf,
      alts: lastBpm.alts,
      steady: lastBpm.stableCount >= 4 && heard >= 10,
    };
  }
  if (lastKey && lastKey.status === 'ok') {
    data.key = {
      status: 'ok',
      name: lastKey.key.name,
      short: lastKey.key.short,
      alias: lastKey.key.alias,
      camelot: lastKey.key.camelot,
      mode: lastKey.key.mode,
      conf: lastKey.conf,
      alt: { name: lastKey.alt.name, camelot: lastKey.alt.camelot },
      steady: lastKey.stability >= 0.66 && heard >= 10,
    };
  }
  broadcast({ type: 'result', tabId, data });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  (async () => {
    try {
      if (msg.type === 'start') { await start(msg); sendResponse({ ok: true }); }
      else if (msg.type === 'stop') { await stop(); sendResponse({ ok: true }); }
      else if (msg.type === 'reset') { resetEngines(); sendResponse({ ok: true }); }
      else sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) {
      await stop();
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});
