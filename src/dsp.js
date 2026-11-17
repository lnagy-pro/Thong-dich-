// ─── Traitement du son et du texte ───────────────────────────────────────────
// Code pur, sans dépendance au navigateur. Resampler, Segmenter et Agc tournent dans
// l'AudioWorklet (thread audio) : leur source y est recopiée telle quelle, elles
// ne doivent donc rien utiliser qui soit défini en dehors d'elles.

/** Descend le flux du micro (44,1 ou 48 kHz) à 16 kHz : passe-bas 6e ordre à 7 kHz puis interpolation. */
class Resampler {
  constructor(inRate, outRate) {
    this.ratio = inRate / outRate;
    this.t = 0;
    this.prev = 0;
    this.filters = [];
    if (inRate > outRate * 1.01) {
      const fc = outRate * 0.4375;
      const qs = [0.5176, 0.7071, 1.9319];
      for (let i = 0; i < qs.length; i++) {
        const w = 2 * Math.PI * fc / inRate;
        const c = Math.cos(w);
        const a = Math.sin(w) / (2 * qs[i]);
        const a0 = 1 + a;
        this.filters.push({
          b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0,
          a1: -2 * c / a0, a2: (1 - a) / a0,
          x1: 0, x2: 0, y1: 0, y2: 0
        });
      }
    }
  }

  process(input) {
    const n = input.length;
    if (!n) return new Float32Array(0);
    const x = new Float32Array(input);
    for (let f = 0; f < this.filters.length; f++) {
      const s = this.filters[f];
      let x1 = s.x1, x2 = s.x2, y1 = s.y1, y2 = s.y2;
      for (let i = 0; i < n; i++) {
        const v = x[i];
        const y = s.b0 * v + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
        x2 = x1; x1 = v; y2 = y1; y1 = y;
        x[i] = y;
      }
      s.x1 = x1; s.x2 = x2; s.y1 = y1; s.y2 = y2;
    }
    if (this.ratio === 1) return x;
    const out = new Float32Array(Math.ceil((n - this.t) / this.ratio) + 1);
    let k = 0;
    let t = this.t;
    while (t <= n - 1) {
      const i = Math.floor(t);
      const frac = t - i;
      const a = i < 0 ? this.prev : x[i];
      const b = i + 1 < n ? x[i + 1] : a;
      out[k++] = a + (b - a) * frac;
      t += this.ratio;
    }
    this.t = t - n;
    this.prev = x[n - 1];
    return out.subarray(0, k);
  }
}

/**
 * Découpe la parole en phrases (16 kHz mono, trames de 20 ms). Détection par énergie
 * au-dessus d'un bruit de fond adaptatif (15e percentile des 2,5 dernières secondes).
 * Portage exact de SpeechSegmenter.swift.
 */
class Segmenter {
  constructor(tuning) {
    const t = Object.assign({
      endSilence: 0.45,      // silence qui clôt une phrase
      maxSegment: 5.0,       // longueur max d'un extrait pendant un monologue
      cutSearchWindow: 1.5,  // fenêtre où chercher le point le plus calme pour couper
      preRoll: 0.4,          // audio gardé avant le début détecté (première syllabe)
      tailKeep: 0.3,         // fin de phrase gardée (particules finales prononcées bas)
      minVoiced: 0.2,        // parole effective minimale (ignore claquements, klaxons brefs)
      startMarginDB: 8,
      keepMarginDB: 5,
      absoluteFloorDB: -58,
      noiseWindow: 2.5
    }, tuning || {});
    this.t = t;
    this.N = 320;
    this.startFrames = 3;
    this.calibrationFrames = 10;
    const fd = this.N / 16000;
    this.endSilenceFrames = Math.max(1, Math.round(t.endSilence / fd));
    this.maxFrames = Math.max(20, Math.round(t.maxSegment / fd));
    this.cutWindowFrames = Math.min(this.maxFrames - 1, Math.max(1, Math.round(t.cutSearchWindow / fd)));
    this.idleCapacity = Math.max(0, Math.round(t.preRoll / fd)) + this.startFrames;
    this.tailKeepFrames = Math.max(0, Math.round(t.tailKeep / fd));
    this.minVoicedFrames = Math.max(1, Math.round(t.minVoiced / fd));
    this.historySize = Math.max(25, Math.round(t.noiseWindow / fd));

    this.buf = new Float32Array(this.N);
    this.fill = 0;
    this.history = [];
    this.cursor = 0;
    this.noiseFloor = -60;
    this.framesSeen = 0;
    this.idle = [];        // trames hors parole gardées pour le pré-roll : {f, e, v}
    this.speechRun = 0;
    this.inSpeech = false;
    this.cur = [];         // trames de la phrase en cours
    this.silenceRun = 0;
    this.peak = 0;         // niveau max (0…1) depuis la dernière lecture, pour l'interface
  }

  /** Ajoute des échantillons à 16 kHz. Renvoie les phrases terminées (Float32Array). */
  push(input) {
    const out = [];
    let i = 0;
    while (i < input.length) {
      const take = Math.min(this.N - this.fill, input.length - i);
      this.buf.set(input.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === this.N) {
        const seg = this.frame(this.buf.slice());
        this.fill = 0;
        if (seg) out.push(seg);
      }
    }
    return out;
  }

  /** À l'arrêt : rend la phrase en cours, même incomplète. */
  flush() {
    let seg = null;
    if (this.inSpeech) {
      const end = this.cur.length - this.silenceRun + Math.min(this.silenceRun, this.tailKeepFrames);
      seg = this.make(end);
    }
    this.reset();
    this.speechRun = 0;
    this.idle = [];
    this.fill = 0;
    return seg;
  }

  frame(f) {
    let sum = 0;
    for (let k = 0; k < f.length; k++) sum += f[k] * f[k];
    const db = 20 * Math.log10(Math.max(Math.sqrt(sum / f.length), 1e-6));
    // Niveau affiché : écart au bruit de fond, pour qu'une voix lointaine fasse bouger l'anneau.
    const ui = Math.min(1, Math.max(0, (db - this.noiseFloor - 3) / 27));
    if (ui > this.peak) this.peak = ui;
    this.framesSeen++;
    this.pushHistory(db);

    // Calibration : les premières trames estiment le bruit ambiant.
    if (this.framesSeen <= this.calibrationFrames) {
      this.noiseFloor = this.percentile();
      this.pushIdle({ f: f, e: db, v: false });
      return null;
    }

    const t = this.t;
    const isStart = db > Math.max(this.noiseFloor + t.startMarginDB, t.absoluteFloorDB);
    const isKeep = db > Math.max(this.noiseFloor + t.keepMarginDB, t.absoluteFloorDB);
    this.noiseFloor = this.noiseFloor * 0.8 + this.percentile() * 0.2;

    if (!this.inSpeech) {
      this.pushIdle({ f: f, e: db, v: isKeep });
      this.speechRun = isStart ? this.speechRun + 1 : 0;
      if (this.speechRun >= this.startFrames) {
        // Début de parole : la phrase démarre avec le pré-roll.
        this.inSpeech = true;
        this.cur = this.idle;
        this.idle = [];
        this.silenceRun = 0;
        this.speechRun = 0;
      }
      return null;
    }

    this.cur.push({ f: f, e: db, v: isKeep });
    this.silenceRun = isKeep ? 0 : this.silenceRun + 1;

    // Fin de phrase : assez de silence.
    if (this.silenceRun >= this.endSilenceFrames) {
      const total = this.cur.length;
      const end = total - this.silenceRun + Math.min(this.silenceRun, this.tailKeepFrames);
      const seg = this.make(end);
      // Le silence de fin sert de pré-roll à la phrase suivante.
      const keepFrom = Math.max(end, total - this.idleCapacity);
      this.idle = this.cur.slice(keepFrom);
      this.reset();
      return seg;
    }

    // Monologue trop long : coupe au point le plus calme des dernières secondes.
    if (this.cur.length >= this.maxFrames) {
      const total = this.cur.length;
      let cut = total - this.cutWindowFrames;
      for (let k = cut; k < total; k++) {
        if (this.cur[k].e < this.cur[cut].e) cut = k;
      }
      const end = cut + 1;
      const seg = this.make(end);
      this.cur = this.cur.slice(end);
      let run = 0;
      for (let k = this.cur.length - 1; k >= 0 && !this.cur[k].v; k--) run++;
      this.silenceRun = run;
      return seg;
    }
    return null;
  }

  make(count) {
    const n = Math.min(Math.max(count, 0), this.cur.length);
    let voiced = 0;
    for (let k = 0; k < n; k++) if (this.cur[k].v) voiced++;
    if (voiced < this.minVoicedFrames) return null;
    const out = new Float32Array(n * this.N);
    for (let k = 0; k < n; k++) out.set(this.cur[k].f, k * this.N);
    return out;
  }

  reset() {
    this.inSpeech = false;
    this.cur = [];
    this.silenceRun = 0;
  }

  pushIdle(fr) {
    this.idle.push(fr);
    const excess = this.idle.length - this.idleCapacity;
    if (excess > 0) this.idle.splice(0, excess);
  }

  pushHistory(db) {
    if (this.history.length < this.historySize) {
      this.history.push(db);
    } else {
      this.history[this.cursor] = db;
      this.cursor = (this.cursor + 1) % this.historySize;
    }
  }

  /** Bruit de fond = 15e percentile des niveaux récents. */
  percentile() {
    if (!this.history.length) return -60;
    const s = this.history.slice().sort(function (a, b) { return a - b; });
    const v = s[Math.floor(s.length * 15 / 100)];
    return Math.min(Math.max(v, -85), -25);
  }
}

/**
 * Gain automatique guidé par la parole, pour l'écoute continue (16 kHz, trames de 20 ms).
 * Le micro est pris brut, sans traitement d'iOS : une voix à deux ou trois mètres arrive
 * 20 à 30 dB plus bas qu'une voix collée au micro, trop bas pour que Gemini l'entende.
 * On mesure le niveau de la parole seule (trames nettement au-dessus du bruit de fond) et on
 * la ramène vers un niveau constant. Le gain ne suit que la parole et reste figé pendant les
 * silences, pour ne pas faire monter le bruit ; il baisse tout de suite sur une voix forte,
 * et un limiteur doux absorbe les attaques. Un passe-haut coupe le grondement sous ~75 Hz
 * (moteurs, vent, téléphone manipulé), qui fausserait la mesure.
 */
class Agc {
  constructor(options) {
    const o = Object.assign({
      target: -22,      // dBFS visé pour le haut de la parole (trames de 20 ms)
      maxGain: 30,      // dB au plus : voix à deux ou trois mètres
      minGain: -6,      // dB : baisse aussi une voix criée tout près du micro
      startGain: 12,    // dB avant la première parole
      rise: 0.5,        // dB par trame au moins quand le gain monte…
      riseFrac: 0.15,   // …ou cette part de l'écart : une voix lointaine est remontée en ~0,5 s
      fall: 2,          // dB par trame quand il baisse (100 dB/s)
      up: 0.25,         // suivi d'une voix plus forte (part de l'écart rattrapée par trame)
      down: 0.08,       // suivi d'une voix plus faible
      hot: -10,         // trame plus forte que ça après gain : baisse immédiate
      margin: 6,        // dB au-dessus du bruit de fond pour compter comme parole
      floor: -66,       // dBFS : en dessous, jamais de la parole
      noiseWindow: 2.5  // s : fenêtre du bruit de fond
    }, options || {});
    this.o = o;
    this.N = 320;
    this.sum = 0;
    this.n = 0;
    this.x1 = 0;
    this.y1 = 0;
    this.history = [];
    this.historySize = Math.max(25, Math.round(o.noiseWindow * 16000 / this.N));
    this.cursor = 0;
    this.level = o.target - o.startGain;   // haut de la parole, avant gain (dBFS)
    this.gainDb = o.startGain;
    this.g = Math.pow(10, o.startGain / 20);   // gain appliqué, en rampe vers gainDb
    this.step = 0;
    this.limited = 0;   // échantillons passés par le limiteur
  }

  /** Filtre et amplifie sur place ; renvoie le même tableau. */
  process(x) {
    for (let i = 0; i < x.length; i++) {
      const v = x[i] - this.x1 + 0.97 * this.y1;
      this.x1 = x[i];
      this.y1 = v;
      this.sum += v * v;
      let y = v * this.g;
      this.g += this.step;
      const a = y < 0 ? -y : y;
      if (a > 0.9) {
        y = (y < 0 ? -1 : 1) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
        this.limited++;
      }
      x[i] = y;
      if (++this.n === this.N) this.frame();
    }
    return x;
  }

  frame() {
    const o = this.o;
    const db = 10 * Math.log10(Math.max(this.sum / this.N, 1e-12));
    this.sum = 0;
    this.n = 0;
    if (this.history.length < this.historySize) this.history.push(db);
    else {
      this.history[this.cursor] = db;
      this.cursor = (this.cursor + 1) % this.historySize;
    }
    const sorted = this.history.slice().sort(function (a, b) { return a - b; });
    const noise = sorted[Math.floor(sorted.length * 15 / 100)];
    // Parole : suit vite une voix plus forte, lentement une voix plus faible.
    if (this.history.length >= 10 && db > Math.max(noise + o.margin, o.floor)) {
      this.level += (db > this.level ? o.up : o.down) * (db - this.level);
    }
    const goal = Math.min(o.maxGain, Math.max(o.minGain, o.target - this.level));
    const climb = Math.max(o.rise, o.riseFrac * (goal - this.gainDb));
    let gain = goal > this.gainDb ? Math.min(goal, this.gainDb + climb) : Math.max(goal, this.gainDb - o.fall);
    if (db + gain > o.hot) gain = Math.max(o.minGain, o.hot - db);
    this.gainDb = gain;
    this.step = (Math.pow(10, gain / 20) - this.g) / this.N;
  }
}

/** WAV PCM 16 bits mono. Remonte les voix lointaines (gain plafonné à ×16). */
function encodeWAV(samples, rate) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  const gain = peak > 0.0005 ? Math.min(0.89 / peak, 16) : 1;
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const text = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Vide ou seulement de la ponctuation (« - », « […] », « … »). */
function isBlank(text) {
  return /^[\s\-–—.…\[\]()?]*$/.test(text || '');
}

/** Aucune parole : vide, ponctuation, ou seulement des bruits notés entre crochets ou parenthèses ([vỗ tay], (cười)…). */
function isNoiseOnly(text) {
  return isBlank(String(text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' '));
}

/** Lit « VI: … / FR: … / TON: … », y compris une réponse partielle pendant le streaming. */
function parseResponse(raw) {
  const label = (name, line) => {
    if (line.length < name.length || line.slice(0, name.length).toUpperCase() !== name) return null;
    const rest = line.slice(name.length).replace(/^ +/, '');
    if (rest[0] !== ':' && rest[0] !== '：') return null;
    return rest.slice(1).trim();
  };
  let field = null;
  const vi = [], fr = [];
  let tone = '';
  for (const rawLine of String(raw || '').split(/\r\n|[\n\r\u2028\u2029\u0085\v\f]/)) {
    const line = rawLine.split('**').join('').trim();
    let value;
    if ((value = label('VI', line)) !== null) { field = 'vi'; vi.push(value); }
    else if ((value = label('FR', line)) !== null) { field = 'fr'; fr.push(value); }
    else if ((value = label('TON', line)) !== null) { field = 'ton'; tone += value; }
    else if (line) {
      if (field === 'vi') vi.push(line);
      else if (field === 'fr') fr.push(line);
    }
  }
  const join = (parts) => parts.filter(Boolean).join(' ').trim();
  const digit = tone.match(/\d/);
  const value = digit ? Number(digit[0]) : NaN;
  return { vi: join(vi), fr: join(fr), tone: value >= 0 && value <= 3 ? value : null };
}

if (typeof module !== 'undefined') {
  module.exports = { Resampler, Segmenter, Agc, encodeWAV, toBase64, isBlank, isNoiseOnly, parseResponse };
}
