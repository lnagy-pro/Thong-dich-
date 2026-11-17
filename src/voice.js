// ─── Reconnaissance des voix ─────────────────────────────────────────────────
// Chaque phrase captée donne une « empreinte vocale » (CAM++, calculée sur l'iPhone dans
// un worker). Les empreintes proches sont regroupées : une voix = une couleur.
// Fbank est recopiée dans le worker : elle ne doit rien utiliser de défini ailleurs.

/** Bancs de filtres mel 80 bandes, compatibles Kaldi (25 ms / 10 ms, fenêtre de Povey). */
class Fbank {
  constructor() {
    this.len = 400;
    this.shift = 160;
    this.nfft = 512;
    this.bins = 80;
    const win = new Float64Array(this.len);
    for (let i = 0; i < this.len; i++) win[i] = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.len - 1)), 0.85);
    this.win = win;
    // Filtres triangulaires sur l'échelle mel de Kaldi, de 20 Hz à 7 600 Hz.
    const mel = (f) => 1127 * Math.log(1 + f / 700);
    const lo = mel(20), hi = mel(16000 / 2 - 400), delta = (hi - lo) / (this.bins + 1);
    const half = this.nfft / 2, width = 16000 / this.nfft;
    this.banks = [];
    for (let b = 0; b < this.bins; b++) {
      const left = lo + b * delta, center = left + delta, right = center + delta;
      const w = [];
      let first = -1;
      for (let k = 0; k < half; k++) {
        const m = mel(width * k);
        if (m > left && m < right) {
          if (first < 0) first = k;
          w.push(m <= center ? (m - left) / (center - left) : (right - m) / (right - center));
        }
      }
      this.banks.push({ first, w: Float64Array.from(w) });
    }
    // Tables de la FFT 512 points.
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / this.nfft); this.sin[i] = Math.sin(2 * Math.PI * i / this.nfft); }
    this.rev = new Uint16Array(this.nfft);
    const bits = Math.log2(this.nfft);
    for (let i = 0; i < this.nfft; i++) {
      let r = 0;
      for (let j = 0; j < bits; j++) r = (r << 1) | ((i >> j) & 1);
      this.rev[i] = r;
    }
  }

  /** Log-mel bruts, Float32Array de T × 80 (10 ms par trame). */
  compute(x) {
    const n = x.length;
    if (n < this.len) return { data: new Float32Array(0), frames: 0 };
    const frames = 1 + Math.floor((n - this.len) / this.shift);
    const out = new Float32Array(frames * this.bins);
    const re = new Float64Array(this.nfft), im = new Float64Array(this.nfft);
    const frame = new Float64Array(this.len);
    const power = new Float64Array(this.nfft / 2 + 1);
    for (let f = 0; f < frames; f++) {
      const off = f * this.shift;
      let dc = 0;
      for (let i = 0; i < this.len; i++) { frame[i] = x[off + i]; dc += frame[i]; }
      dc /= this.len;
      for (let i = 0; i < this.len; i++) frame[i] -= dc;
      for (let i = this.len - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
      frame[0] -= 0.97 * frame[0];
      re.fill(0); im.fill(0);
      for (let i = 0; i < this.len; i++) re[this.rev[i]] = frame[i] * this.win[i];
      for (let size = 2; size <= this.nfft; size <<= 1) {
        const halfSize = size >> 1, step = this.nfft / size;
        for (let start = 0; start < this.nfft; start += size) {
          for (let j = 0; j < halfSize; j++) {
            const c = this.cos[j * step], s = -this.sin[j * step];
            const a = start + j, b = a + halfSize;
            const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
      for (let k = 0; k <= this.nfft / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
      for (let b = 0; b < this.bins; b++) {
        const bank = this.banks[b];
        let e = 0;
        for (let k = 0; k < bank.w.length; k++) e += bank.w[k] * power[bank.first + k];
        out[f * this.bins + b] = Math.log(Math.max(e, 1.1920929e-7));
      }
    }
    return { data: out, frames };
  }

  /**
   * Découpe un extrait en fenêtres de 1,5 s (pas de 0,75 s), moyenne retirée dans chaque
   * fenêtre, prêtes à passer ensemble dans le modèle : {data, n, frames, spans:[[début, fin] en s]}.
   * Les fenêtres presque silencieuses sont écartées.
   */
  windows(x) {
    const { data, frames } = this.compute(x);
    if (frames < 50) return { data: new Float32Array(0), n: 0, frames: 0, spans: [] };
    const W = Math.min(150, frames), hop = 75, B = this.bins;
    const starts = [];
    for (let s = 0; s + W <= frames; s += hop) starts.push(s);
    if (starts[starts.length - 1] + W < frames) starts.push(frames - W);
    // Énergie de chaque fenêtre (moyenne des log-mel) pour écarter les passages sans voix.
    const level = starts.map((s) => {
      let sum = 0;
      for (let f = s; f < s + W; f++) for (let b = 0; b < B; b++) sum += data[f * B + b];
      return sum / (W * B);
    });
    const top = Math.max.apply(null, level);
    const keep = starts.filter((s, i) => level[i] > top - 3);
    const out = new Float32Array(keep.length * W * B);
    const mean = new Float64Array(B);
    keep.forEach((s, i) => {
      mean.fill(0);
      for (let f = s; f < s + W; f++) for (let b = 0; b < B; b++) mean[b] += data[f * B + b];
      for (let b = 0; b < B; b++) mean[b] /= W;
      for (let f = 0; f < W; f++) for (let b = 0; b < B; b++) out[(i * W + f) * B + b] = data[(s + f) * B + b] - mean[b];
    });
    return { data: out, n: keep.length, frames: W, spans: keep.map((s) => [s / 100, (s + W) / 100]) };
  }
}

/** Garde la partie parlée d'un extrait (coupe le silence au début et à la fin). */
function voicedPart(x) {
  const hop = 160, n = Math.floor(x.length / hop);
  if (n < 3) return x;
  const db = new Float64Array(n);
  let max = -200;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) s += x[k] * x[k];
    db[i] = 10 * Math.log10(s / hop + 1e-12);
    if (db[i] > max) max = db[i];
  }
  let a = 0, b = n - 1;
  while (a < n && db[a] < max - 35) a++;
  while (b > a && db[b] < max - 35) b--;
  const from = Math.max(0, (a - 10) * hop), to = Math.min(x.length, (b + 11) * hop);
  return x.subarray(from, to);
}

/**
 * Regroupement en ligne : chaque fenêtre de 1,5 s rejoint la voix la plus proche si elle
 * lui ressemble assez. Une nouvelle voix naît quand au moins deux fenêtres se ressemblent
 * entre elles sans ressembler à aucune voix connue (une fenêtre isolée reste sans couleur).
 * Les voix devenues trop proches sont fusionnées.
 */
class VoiceClusters {
  constructor(options) {
    this.o = Object.assign({ join: 0.4, margin: 0.35, pair: 0.45, merge: 0.55, max: 6 }, options || {});
    this.list = [];
    this.pending = [];   // fenêtres orphelines récentes, candidates à une nouvelle voix
    this.nextId = 1;
  }

  static dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  static normalize(v) {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
  }

  best(e) {
    let best = null, score = -1;
    for (const c of this.list) {
      const s = VoiceClusters.dot(e, c.centroid);
      if (s > score) { score = s; best = c; }
    }
    return { best, score };
  }

  /**
   * Seuil d'une voix : plus ses fenêtres se ressemblent entre elles (voix nette, peu de
   * bruit), plus il faut lui ressembler pour la rejoindre. |somme| / nombre = similarité
   * moyenne des fenêtres à leur centre.
   */
  threshold(c) {
    if (c.weight < 3) return this.o.join;
    let n = 0;
    for (let i = 0; i < c.sum.length; i++) n += c.sum[i] * c.sum[i];
    return Math.max(this.o.join, Math.sqrt(n) / c.weight - this.o.margin);
  }

  /** Une voix par fenêtre (identifiant ou null), dans l'ordre des fenêtres. */
  assign(embeddings) {
    const ids = [];
    const fresh = [];
    for (const raw of embeddings) {
      const e = VoiceClusters.normalize(raw);
      const { best, score } = this.best(e);
      if (best && score >= this.threshold(best)) {
        this.add(best, e);
        ids.push(best.id);
      } else {
        ids.push(null);
        fresh.push({ e, index: ids.length - 1 });
      }
    }
    // Fenêtres orphelines : une nouvelle voix si deux d'entre elles se ressemblent.
    const pool = this.pending.concat(fresh.map((f) => ({ e: f.e, index: f.index, current: true })));
    for (let i = 0; i < pool.length && this.list.length < this.o.max; i++) {
      if (pool[i].used) continue;
      const group = [pool[i]];
      for (let j = i + 1; j < pool.length; j++) {
        if (!pool[j].used && VoiceClusters.dot(pool[i].e, pool[j].e) >= this.o.pair) group.push(pool[j]);
      }
      if (group.length < 2) continue;
      const c = { id: this.nextId++, sum: new Float32Array(pool[i].e.length), weight: 0, centroid: pool[i].e };
      for (const g of group) {
        this.add(c, g.e);
        g.used = true;
        if (g.current) ids[g.index] = c.id;
      }
      this.list.push(c);
    }
    // Les orphelines restantes attendent (les 8 plus récentes).
    this.pending = pool.filter((p) => !p.used).map((p) => ({ e: p.e })).slice(-8);
    return ids;
  }

  add(c, e) {
    for (let i = 0; i < e.length; i++) c.sum[i] += e[i];
    c.weight++;
    c.centroid = VoiceClusters.normalize(c.sum);
  }

  /** Fusionne les voix devenues trop proches. Renvoie {ancien id: id gardé}. */
  mergeClose() {
    const merged = {};
    for (;;) {
      let pair = null, score = this.o.merge;
      for (let i = 0; i < this.list.length; i++) {
        for (let j = i + 1; j < this.list.length; j++) {
          const s = VoiceClusters.dot(this.list[i].centroid, this.list[j].centroid);
          if (s > score) { score = s; pair = [this.list[i], this.list[j]]; }
        }
      }
      if (!pair) break;
      const [keep, drop] = pair[0].id < pair[1].id ? pair : [pair[1], pair[0]];
      for (let i = 0; i < keep.sum.length; i++) keep.sum[i] += drop.sum[i];
      keep.weight += drop.weight;
      keep.centroid = VoiceClusters.normalize(keep.sum);
      this.list = this.list.filter((c) => c !== drop);
      merged[drop.id] = keep.id;
      for (const k of Object.keys(merged)) if (merged[k] === drop.id) merged[k] = keep.id;
    }
    return merged;
  }

  reset() {
    this.list = [];
    this.pending = [];
    this.nextId = 1;
  }
}

/** Suite des voix d'une phrase : [A, A, null, B, B] → [A, B]. */
function voiceRuns(ids) {
  const runs = [];
  for (const id of ids) if (id !== null && runs[runs.length - 1] !== id) runs.push(id);
  return runs;
}

if (typeof module !== 'undefined') {
  module.exports = { Fbank, voicedPart, VoiceClusters, voiceRuns };
}
