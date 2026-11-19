'use strict';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg });

let tab = null;
let current = null;      // последний результат от анализатора
let octave = 1;          // ручной выбор: ×1, ×2 или ×0.5 к найденному темпу
let lastMsgAt = 0;
let running = false;
let copyTimer = null;

const RESTRICTED = /^(chrome|edge|about|devtools|view-source|chrome-extension|chrome-search):/i;
const STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

// ---------- вспомогательное ----------
function setStatus(text, kind) {
  $('statusText').textContent = text;
  $('dot').className = 'dot' + (kind ? ' ' + kind : '');
}

function showError(text) {
  running = false;
  $('errorText').textContent = text;
  $('errorBox').hidden = false;
  $('pulse').classList.remove('live');
  setStatus('Анализ не запущен', 'bad');
  $('panel').hidden = true;
  $('copy').disabled = true;
  $('stop').disabled = true;
  $('reset').textContent = 'Повторить';
}

function clearError() {
  $('errorBox').hidden = true;
  $('panel').hidden = false;
  $('stop').disabled = false;
  $('reset').textContent = 'Заново';
}

function confWord(c) {
  return c >= 0.75 ? 'высокая' : c >= 0.5 ? 'средняя' : 'низкая';
}

function friendlyError(raw) {
  const m = String(raw || '');
  if (/cannot be captured|activeTab|not been invoked/i.test(m)) {
    return 'Chrome не даёт снять звук с этой страницы. Откройте вкладку, где играет бит (например, YouTube), и нажмите на значок расширения ещё раз.';
  }
  if (/active stream|already/i.test(m)) {
    return 'Звук этой вкладки уже захвачен другим расширением или окном. Закройте их и нажмите «Повторить».';
  }
  if (/Permission|NotAllowed|denied/i.test(m)) {
    return 'Chrome не разрешил доступ к звуку вкладки. Нажмите «Повторить» прямо после клика по значку расширения.';
  }
  return 'Не удалось получить звук вкладки: ' + m;
}

function camelotColor(code) {
  const n = parseInt(code, 10) || 1;
  return 'hsl(' + ((n - 1) * 30 + 150) % 360 + ', 90%, 66%)';
}

// ---------- отрисовка ----------
function render(data) {
  current = data;
  if (!data) return;
  lastMsgAt = Date.now();

  // состояние звука
  if (data.silent) setStatus('Нет звука. Включите воспроизведение на вкладке.', 'warn');
  else if (data.bpm && data.bpm.steady) setStatus('Результат стабилен. Продолжаю уточнять.', 'live');
  else setStatus('Слушаю вкладку. Результат предварительный.', 'live');


  renderBpm(data);
  renderKey(data);
}

function renderBpm(data) {
  const b = data.bpm;
  const chips = $('chips');
  chips.textContent = '';
  if (!b) {
    $('bpm').textContent = '—';
    $('bpm').classList.add('empty');
    $('bpmNote').textContent = data.heard < 4 ? 'Собираю звук, нужно около 4 секунд…' : 'Жду ритм…';
    $('bpmBar').style.width = '0%';
    $('bpmConf').textContent = 'Уверенность: —';
    $('pulse').classList.remove('live');
    return;
  }
  $('bpm').classList.remove('empty');
  const value = b.value * octave;
  const rounded = Math.round(value);
  $('bpm').textContent = String(rounded);
  const off = Math.abs(value - rounded);
  $('bpmNote').textContent = off > 0.15 ? 'Точнее: ' + value.toFixed(1) : (b.steady ? '' : 'Предварительно');

  // другие варианты: в 2 раза медленнее или быстрее
  [b.value / 2, b.value, b.value * 2].forEach((v) => {
    if (Math.abs(v - value) < 0.5 || v < 50 || v > 220) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('aria-label', 'Показать темп ' + Math.round(v) + ' BPM');
    btn.innerHTML = '<b>' + Math.round(v) + '</b> ' + (v < value ? 'полутемп' : 'двойной');
    btn.addEventListener('click', () => {
      octave = v / b.value;
      chrome.storage.session.set({ ['oct:' + tab.id]: octave });
      render(current);
    });
    chips.appendChild(btn);
  });

  $('bpmBar').style.width = Math.round(b.conf * 100) + '%';
  $('bpmConf').textContent = 'Уверенность: ' + confWord(b.conf);
  const pulse = $('pulse');
  pulse.style.setProperty('--beat', (60 / value).toFixed(3) + 's');
  pulse.classList.add('live');
}

function renderKey(data) {
  const k = data.key;
  const camelot = $('camelot');
  if (!k || k.status !== 'ok') {
    $('key').textContent = '—';
    $('key').classList.add('empty');
    camelot.hidden = true;
    $('keyBar').style.width = '0%';
    $('keyConf').textContent = 'Уверенность: —';
    $('keyNote').textContent =
      k && k.status === 'weak'
        ? 'Тональность неясна: мелодии пока нет или она неоднозначна.'
        : 'Жду мелодию. На одних барабанах тональность не определить.';
    return;
  }
  $('key').textContent = k.name;
  $('key').classList.remove('empty');
  camelot.hidden = false;
  camelot.textContent = k.camelot;
  camelot.style.setProperty('--c', camelotColor(k.camelot));
  camelot.setAttribute('aria-label', 'Camelot ' + k.camelot);
  const alias = k.alias ? 'То же, что ' + k.alias + '. ' : '';
  $('keyNote').textContent = alias + 'Вторая версия: ' + k.alt.name + ' (' + k.alt.camelot + ')';
  $('keyBar').style.width = Math.round(k.conf * 100) + '%';
  $('keyConf').textContent = 'Уверенность: ' + confWord(k.conf) + (k.steady ? '' : ', пока предварительно');
}

// ---------- запуск и остановка ----------
async function startCapture() {
  clearError();
  running = true;
  $('copy').disabled = false;
  $('stop').textContent = 'Стоп';
  setStatus('Подключаюсь к звуку вкладки…');
  try {
    await send({ type: 'stop' }); // освобождаем предыдущий захват (если был на другой вкладке)
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await send({ type: 'start', tabId: tab.id, streamId, title: tab.title || '' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'нет ответа от фонового модуля');
    lastMsgAt = Date.now();
    setStatus('Слушаю вкладку…', 'live');
  } catch (e) {
    showError(friendlyError(e && e.message));
  }
}

async function stopCapture() {
  await send({ type: 'stop' });
  running = false;
  $('pulse').classList.remove('live');
  setStatus('Остановлено. Звук вкладки играет как обычно.');
  $('stop').textContent = 'Слушать';
}

async function copyResult() {
  if (!current || !current.bpm) return;
  const parts = [Math.round(current.bpm.value * octave) + ' BPM'];
  if (current.key && current.key.status === 'ok') parts.push(current.key.name + ' (' + current.key.camelot + ')');
  const text = parts.join(', ');
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  $('copy').textContent = 'Скопировано';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { $('copy').textContent = 'Копировать'; }, 1600);
}

// ---------- события ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.from !== 'offscreen' || !tab) return;
  if (msg.tabId !== undefined && msg.tabId !== tab.id) return;
  if (msg.type === 'result' && running) render(msg.data);
  if (msg.type === 'ended') { running = false; setStatus('Захват остановлен (вкладку закрыли или звук отключён).', 'warn'); }
});

$('copy').addEventListener('click', copyResult);

$('reset').addEventListener('click', async () => {
  if (!$('errorBox').hidden || !running) { await startCapture(); return; }
  await send({ type: 'reset' });
  current = null;
  octave = 1;
  chrome.storage.session.remove('oct:' + tab.id);
  render({ heard: 0, level: 0, silent: false, bpm: null, key: { status: 'waiting' } });
  setStatus('Анализ начат заново. Слушаю…', 'live');
});

$('stop').addEventListener('click', async () => {
  if (running) await stopCapture();
  else await startCapture();
});

// Если анализатор замолчал, показываем это, а не делаем вид, что всё работает
setInterval(() => {
  if (running && lastMsgAt && Date.now() - lastMsgAt > 4000) {
    showError('Анализ остановился. Нажмите «Повторить».');
  }
}, 1000);

// ---------- старт ----------
(async function init() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
    if (!tab || tab.id === undefined) { showError('Не удалось определить текущую вкладку.'); return; }
    $('tabTitle').textContent = tab.title || tab.url || 'Текущая вкладка';
    if ((tab.url && (RESTRICTED.test(tab.url) || STORE.test(tab.url)))) {
      showError('Chrome не даёт снять звук со служебных страниц. Откройте вкладку, где играет бит (например, YouTube), и нажмите на значок ещё раз.');
      return;
    }
    const saved = await chrome.storage.session.get('oct:' + tab.id);
    octave = saved['oct:' + tab.id] || 1;

    const st = await send({ type: 'status' });
    if (st && st.cap && st.cap.tabId === tab.id) {
      running = true;
      lastMsgAt = Date.now();
      setStatus('Слушаю вкладку…', 'live');
      if (st.last && st.last.tabId === tab.id) render(st.last.data);
      else render({ heard: 0, level: 0, silent: false, bpm: null, key: { status: 'waiting' } });
    } else {
      render({ heard: 0, level: 0, silent: false, bpm: null, key: { status: 'waiting' } });
      await startCapture();
    }
  } catch (e) {
    showError(friendlyError(e && e.message));
  }
})();
