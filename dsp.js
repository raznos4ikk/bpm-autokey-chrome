'use strict';
/*
 * BPM & Key — DSP-ядро. Чистый JavaScript, без зависимостей.
 *   TempoEngine: onset-огибающая -> автокорреляция + гребёнка гармоник -> уточнение по сетке ударов
 *   KeyEngine:   спектральные пики -> HPCP-хрома с учётом гармоник -> профили тональностей (Krumhansl + Temperley)
 */
(function (root) {

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------- FFT (radix-2, in-place) ----------
function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  return function transform(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// =====================================================================
//  ТЕМП
// =====================================================================
const BPM_MIN = 55, BPM_MAX = 215, K_HARM = 4;
const PRIOR_C = 118, PRIOR_S = 0.95; // мягкое предпочтение «человеческого» диапазона темпов

class TempoEngine {
  constructor(sr) {
    this.sr = sr;
    this.N = 1024;
    this.hop = 512;
    this.fe = sr / this.hop;                 // частота кадров огибающей
    this.M = Math.ceil(26 * this.fe);        // более длинное окно снижает колебания оценки
    this.env = new Float32Array(this.M);
    this.fft = makeFFT(this.N);
    this.win = hann(this.N);
    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
    this.hist = new Float32Array(this.N);
    this.stage = new Float32Array(this.hop);

    // 24 лог-полосы между бинами 1 и верхней границей ~12 кГц
    this.nb = 24;
    this.kmax = Math.min(this.N / 2 - 1, Math.floor((Math.min(12000, sr * 0.45) * this.N) / sr));
    this.bandOf = new Int16Array(this.N / 2 + 1).fill(-1);
    this.bandCnt = new Float64Array(this.nb);
    const span = Math.log(this.kmax);
    for (let k = 1; k <= this.kmax; k++) {
      const b = Math.min(this.nb - 1, Math.floor((this.nb * Math.log(k)) / span));
      this.bandOf[k] = b;
      this.bandCnt[b]++;
    }
    this.bandE = new Float64Array(this.nb);
    this.prev = new Float64Array(this.nb);
    this.reset();
  }

  reset() {
    this.env.fill(0);
    this.hist.fill(0);
    this.prev.fill(0);
    this.sn = 0;
    this.count = 0;
    this.history = [];
  }

  push(x) {
    let i = 0;
    const n = x.length;
    while (i < n) {
      const take = Math.min(this.hop - this.sn, n - i);
      this.stage.set(x.subarray(i, i + take), this.sn);
      this.sn += take;
      i += take;
      if (this.sn === this.hop) { this._frame(); this.sn = 0; }
    }
  }

  _frame() {
    const N = this.N, hop = this.hop, re = this.re, im = this.im;
    this.hist.copyWithin(0, hop);
    this.hist.set(this.stage, N - hop);
    for (let i = 0; i < N; i++) { re[i] = this.hist[i] * this.win[i]; im[i] = 0; }
    this.fft(re, im);
    const E = this.bandE;
    E.fill(0);
    for (let k = 1; k <= this.kmax; k++) E[this.bandOf[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    let flux = 0;
    for (let b = 0; b < this.nb; b++) {
      if (this.bandCnt[b] === 0) continue;
      const v = Math.log(1 + 500 * (E[b] / this.bandCnt[b]) * (4 / N));
      const d = v - this.prev[b];
      if (d > 0) flux += d;
      this.prev[b] = v;
    }
    this.env[this.count % this.M] = flux;
    this.count++;
  }

  analyze() {
    const fe = this.fe;
    const n = Math.min(this.count, this.M);
    if (n < Math.round(4 * fe)) return null;

    const x = new Float64Array(n);
    const start = this.count - n;
    for (let i = 0; i < n; i++) x[i] = this.env[(start + i) % this.M];

    // убираем медленный тренд, оставляем только всплески (onset-огибающая)
    const P = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) P[i + 1] = P[i] + x[i];
    const w = Math.max(2, Math.round(0.3 * fe));
    const yr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - w), hi = Math.min(n - 1, i + w);
      const mean = (P[hi + 1] - P[lo]) / (hi - lo + 1);
      const v = x[i] - mean;
      yr[i] = v > 0 ? v : 0;
    }
    let mu = 0;
    for (let i = 0; i < n; i++) mu += yr[i];
    mu /= n;
    const z = new Float64Array(n);
    let e0 = 0;
    for (let i = 0; i < n; i++) { z[i] = yr[i] - mu; e0 += z[i] * z[i]; }
    e0 /= n;
    if (!(e0 > 1e-9)) return null;

    // автокорреляция
    const slowPeriod = (60 / BPM_MIN) * fe;
    const Lmax = Math.min(Math.floor(n * 0.5), Math.ceil(K_HARM * slowPeriod) + 2);
    const r = new Float64Array(Lmax + 2);
    for (let l = 1; l <= Lmax; l++) {
      let s = 0;
      for (let i = l; i < n; i++) s += z[i] * z[i - l];
      r[l] = s / (n - l) / e0;
    }
    const rAt = (l) => { const i = Math.floor(l); const f = l - i; return r[i] * (1 - f) + r[i + 1] * f; };

    // гребёнка гармоник: темп поддерживают лаги L, 2L, 3L, 4L
    const comb = (bpm) => {
      const L = (60 * fe) / bpm;
      let s = 0, c = 0;
      for (let k = 1; k <= K_HARM; k++) {
        const l = k * L;
        if (l > Lmax) break;
        s += rAt(l); c++;
      }
      return c ? s / c : 0;
    };
    const prior = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / PRIOR_C) / PRIOR_S, 2));

    const STEP = 0.1;
    const m = Math.floor((BPM_MAX - BPM_MIN) / STEP) + 1;
    const raw = new Float64Array(m), sc = new Float64Array(m);
    let jb = 0;
    for (let j = 0; j < m; j++) {
      raw[j] = Math.max(0, comb(BPM_MIN + j * STEP));
      sc[j] = raw[j] * prior(BPM_MIN + j * STEP);
      if (sc[j] > sc[jb]) jb = j;
    }
    const b0 = BPM_MIN + jb * STEP;
    const periodicity = raw[jb];
    if (!(sc[jb] > 0)) return null;

    // второй по силе пик, не связанный с первым как ×2/÷2
    let s2 = 0;
    for (let j = 1; j < m - 1; j++) {
      if (!(sc[j] >= sc[j - 1] && sc[j] >= sc[j + 1])) continue;
      const q = Math.abs(Math.log2((BPM_MIN + j * STEP) / b0));
      if (q < 0.07 || Math.abs(q - 1) < 0.07 || Math.abs(q - 0.585) < 0.05) continue;
      if (sc[j] > s2) s2 = sc[j];
    }
    const prom = clamp01((sc[jb] - s2) / sc[jb]);

    // уточнение: подбираем период, при котором сетка ударов лучше всего ложится на огибающую
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = i > 0 ? yr[i - 1] : yr[i], c = i < n - 1 ? yr[i + 1] : yr[i];
      ys[i] = 0.25 * a + 0.5 * yr[i] + 0.25 * c;
    }
    const refined = this._refine(ys, n, b0);

    const st = this._stable(refined);
    const seconds = n / fe;
    const stability = st.count / Math.max(st.total, 1);
    const confPer = clamp01((periodicity - 0.08) / 0.4);
    const conf = clamp01((0.5 * confPer + 0.2 * clamp01(prom / 0.3) + 0.3 * stability) * (0.7 + 0.3 * clamp01(seconds / 12)));

    const value = st.value;
    const alts = [];
    if (value / 2 >= 50) alts.push({ label: 'полутемп', value: value / 2 });
    if (value * 2 <= 220) alts.push({ label: 'двойной', value: value * 2 });
    return { bpm: value, conf, stability, seconds, periodicity, alts, stableCount: st.count };
  }

  _refine(ys, n, b0) {
    const fe = this.fe;
    const lo = b0 * 0.975, step = b0 * 0.0005;
    const m = Math.floor((b0 * 1.025 - lo) / step) + 1;
    const sc = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const P = (60 * fe) / (lo + j * step);
      const phases = Math.ceil(P);
      let best = 0;
      for (let p = 0; p < phases; p++) {
        let s = 0, c = 0;
        for (let pos = p; pos <= n - 1; pos += P) {
          const i = Math.floor(pos), f = pos - i;
          s += ys[i] * (1 - f) + (i + 1 < n ? ys[i + 1] : ys[i]) * f;
          c++;
        }
        if (c > 0) { s /= c; if (s > best) best = s; }
      }
      sc[j] = best;
    }
    // сглаживаем кривую и берём максимум
    let jb = Math.floor(m / 2), vb = -1;
    for (let j = 0; j < m; j++) {
      let s = 0, c = 0;
      for (let d = -2; d <= 2; d++) { const q = j + d; if (q >= 0 && q < m) { s += sc[q]; c++; } }
      s /= c;
      if (s > vb) { vb = s; jb = j; }
    }
    return lo + jb * step;
  }

  // «живая» оценка: берём самый большой кластер из последних оценок
  _stable(b) {
    const h = this.history;
    h.push(b);
    if (h.length > 12) h.shift();
    let bi = h.length - 1, bc = 0;
    for (let j = h.length - 1; j >= 0; j--) {
      let c = 0;
      for (const v of h) if (Math.abs(v / h[j] - 1) < 0.008) c++;
      if (c > bc) { bc = c; bi = j; }
    }
    const members = h.filter((v) => Math.abs(v / h[bi] - 1) < 0.008).sort((a, c) => a - c);
    return { value: members[members.length >> 1], count: bc, total: h.length };
  }
}

// =====================================================================
//  ТОНАЛЬНОСТЬ
// =====================================================================
const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const TP_MAJ = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
const TP_MIN = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0];

const NAMES_MAJ = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const NAMES_MIN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CAMELOT_MAJ = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]; // по тонике (pc)

function keyInfo(tonic, mode) { // mode: 0 = мажор, 1 = минор
  const name = (mode ? NAMES_MIN : NAMES_MAJ)[tonic];
  const sharp = NAMES_SHARP[tonic];
  const num = mode ? CAMELOT_MAJ[(tonic + 3) % 12] : CAMELOT_MAJ[tonic];
  return {
    tonic, mode,
    name: name + (mode ? ' minor' : ' major'),
    short: name + (mode ? 'm' : ''),
    alias: sharp !== name ? sharp + (mode ? ' minor' : ' major') : null,
    camelot: num + (mode ? 'A' : 'B'),
  };
}

function pearson(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < 12; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

const HALF_LIFE = 25; // секунд: как быстро «забывается» старая гармония

class KeyEngine {
  constructor(sr) {
    this.sr = sr;
    this.N = sr > 60000 ? 16384 : 8192;
    this.hop = this.N / 2;
    this.df = sr / this.N;
    this.fft = makeFFT(this.N);
    this.win = hann(this.N);
    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
    this.mag = new Float64Array(this.N / 2 + 2);
    this.hist = new Float32Array(this.N);
    this.stage = new Float32Array(this.hop);
    this.kmin = Math.max(2, Math.ceil(60 / this.df));
    this.kmax = Math.min(this.N / 2 - 2, Math.floor(4000 / this.df));
    this.fl0 = Math.ceil(100 / this.df);
    this.fl1 = Math.floor(3000 / this.df);
    this.fps = sr / this.hop;
    this.lambda = Math.pow(0.5, 1 / (this.fps * HALF_LIFE));
    this.frame = new Float64Array(36);
    this.reset();
  }

  reset() {
    this.hist.fill(0);
    this.sn = 0;
    this.acc = new Float64Array(36);
    this.wsum = 0;
    this.framesSeen = 0;
    this.history = [];
  }

  push(x) {
    let i = 0;
    const n = x.length;
    while (i < n) {
      const take = Math.min(this.hop - this.sn, n - i);
      this.stage.set(x.subarray(i, i + take), this.sn);
      this.sn += take;
      i += take;
      if (this.sn === this.hop) { this._frame(); this.sn = 0; }
    }
  }

  _frame() {
    const N = this.N, hop = this.hop, re = this.re, im = this.im, mag = this.mag;
    this.hist.copyWithin(0, hop);
    this.hist.set(this.stage, N - hop);
    for (let i = 0; i < N; i++) { re[i] = this.hist[i] * this.win[i]; im[i] = 0; }
    this.fft(re, im);
    const top = Math.min(N / 2, this.kmax + 2);
    for (let k = 0; k <= top; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);

    this.acc.forEach((v, i) => { this.acc[i] = v * this.lambda; });
    this.wsum *= this.lambda;
    this.framesSeen++;

    let mx = 0;
    for (let k = this.kmin; k <= this.kmax; k++) if (mag[k] > mx) mx = mag[k];
    if (mx < 1e-3 * (N / 4)) return; // тишина

    // плоскостность спектра: шум и барабаны -> почти плоский, мелодия -> пики
    let sl = 0, sa = 0, cnt = 0;
    for (let k = this.fl0; k <= this.fl1; k++) {
      const p = mag[k] * mag[k] + 1e-18;
      sl += Math.log(p); sa += p; cnt++;
    }
    const flat = cnt ? Math.exp(sl / cnt) / (sa / cnt) : 1;
    const wt = clamp01((0.30 - flat) / 0.25);
    if (wt <= 0) return;

    // спектральные пики
    const thr = mx * 0.06;
    const peaks = [];
    for (let k = this.kmin; k <= this.kmax; k++) {
      const m = mag[k];
      if (m > thr && m > mag[k - 1] && m >= mag[k + 1]) peaks.push(k);
    }
    peaks.sort((a, b) => mag[b] - mag[a]);
    if (peaks.length > 40) peaks.length = 40;

    const fr = this.frame;
    fr.fill(0);
    for (const k of peaks) {
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(mag[k] + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
      const den = a - 2 * b + c;
      const p = den < 0 ? 0.5 * (a - c) / den : 0;
      const f = (k + Math.max(-0.5, Math.min(0.5, p))) * this.df;
      const amp = Math.sqrt(mag[k] / mx);
      const fw = f < 130 ? 0.6 : f > 2500 ? 0.7 : 1;
      let hw = 1;
      for (let h = 1; h <= 4; h++, hw *= 0.6) {
        const f0 = f / h;
        if (f0 < 50) break;
        const midi = 69 + 12 * Math.log2(f0 / 440);
        const pcf = ((midi % 12) + 12) % 12;
        fr[Math.round(pcf * 3) % 36] += amp * fw * hw;
      }
    }
    let s = 0;
    for (let i = 0; i < 36; i++) s += fr[i];
    if (!(s > 0)) return;
    for (let i = 0; i < 36; i++) this.acc[i] += (wt * fr[i]) / s;
    this.wsum += wt;
  }

  _chroma12() {
    const h = this.acc;
    let bo = 0, best = -1;
    for (let o = -1; o <= 1; o++) {
      let s = 0;
      for (let c = 0; c < 12; c++) s += h[(3 * c + o + 36) % 36];
      if (s > best) { best = s; bo = o; }
    }
    const out = new Float64Array(12);
    for (let c = 0; c < 12; c++) {
      out[c] = h[(3 * c + bo - 1 + 36) % 36] + h[(3 * c + bo + 36) % 36] + h[(3 * c + bo + 1 + 36) % 36];
    }
    return out;
  }

  analyze() {
    const seconds = this.framesSeen / this.fps;
    if (this.wsum < 20) return { status: 'waiting', seconds };
    const ch = this._chroma12();
    let mxc = 0;
    for (let i = 0; i < 12; i++) if (ch[i] > mxc) mxc = ch[i];
    if (!(mxc > 0)) return { status: 'waiting', seconds };
    let distinct = 0;
    for (let i = 0; i < 12; i++) if (ch[i] >= 0.3 * mxc) distinct++;

    // корреляция с 24 профилями (среднее по двум наборам профилей)
    const scores = [];
    const rot = new Float64Array(12), rot2 = new Float64Array(12);
    for (let mode = 0; mode < 2; mode++) {
      const ks = mode ? KS_MIN : KS_MAJ, tp = mode ? TP_MIN : TP_MAJ;
      for (let t = 0; t < 12; t++) {
        for (let pc = 0; pc < 12; pc++) { rot[pc] = ks[(pc - t + 12) % 12]; rot2[pc] = tp[(pc - t + 12) % 12]; }
        scores.push({ tonic: t, mode, r: 0.5 * (pearson(ch, rot) + pearson(ch, rot2)) });
      }
    }
    const sorted = scores.slice().sort((a, b) => b.r - a.r);
    // параллельные мажор/минор почти неразличимы по нотам: при близких оценках выбираем ту, чья тоника звучит сильнее
    if (sorted[0].mode !== sorted[1].mode && sorted[0].r - sorted[1].r < 0.06) {
      const mn = sorted[0].mode ? sorted[0] : sorted[1].mode ? sorted[1] : null;
      const mj = sorted[0].mode ? sorted[1] : sorted[0];
      if (mn && (mn.tonic - mj.tonic + 12) % 12 === 9 && ch[mn.tonic] > ch[mj.tonic] * 1.1 && sorted[0] !== mn) {
        sorted[0] = mn; sorted[1] = mj;
      } else if (mn && (mn.tonic - mj.tonic + 12) % 12 === 9 && ch[mj.tonic] > ch[mn.tonic] * 1.1 && sorted[0] !== mj) {
        sorted[0] = mj; sorted[1] = mn;
      }
    }
    const latest = sorted[0];

    // «живая» оценка: самая частая тональность среди последних шести
    const id = latest.tonic + 12 * latest.mode;
    this.history.push(id);
    if (this.history.length > 6) this.history.shift();
    const counts = {};
    let finalId = id, fc = 0;
    for (let j = this.history.length - 1; j >= 0; j--) {
      const v = this.history[j];
      counts[v] = (counts[v] || 0) + 1;
      if (counts[v] > fc) { fc = counts[v]; finalId = v; }
    }
    const final = scores.find((s) => s.tonic + 12 * s.mode === finalId);
    const other = sorted.find((s) => s.tonic + 12 * s.mode !== finalId);
    const stability = fc / this.history.length;

    const confA = clamp01((final.r - 0.5) / 0.35);
    const confB = clamp01((final.r - other.r) / 0.08);
    const evidence = clamp01(this.wsum / 60);
    const conf = clamp01((0.65 * confA + 0.35 * confB) * (0.5 + 0.5 * stability) * (0.6 + 0.4 * evidence));

    if (distinct < 3 || final.r < 0.45 || conf < 0.33) {
      return { status: 'weak', seconds, conf: 0, r: final.r };
    }
    return {
      status: 'ok', seconds, conf, stability, r: final.r,
      key: keyInfo(final.tonic, final.mode),
      alt: keyInfo(other.tonic, other.mode),
    };
  }
}

const api = { TempoEngine, KeyEngine, keyInfo };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.BKDSP = api;

})(typeof self !== 'undefined' ? self : this);
