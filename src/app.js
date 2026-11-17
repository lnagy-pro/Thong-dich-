// ─── Thông Dịch : interprète vietnamien (Centre) → français ──────────────────
// L'écoute et la traduction sont indépendantes : le découpage en phrases tourne sur
// le thread audio (AudioWorklet) et chaque phrase part aussitôt vers Gemini, en
// parallèle des précédentes. Rien n'est perdu pendant qu'une traduction est en cours.

const PROMPT = __PROMPT__;

const MODELS = [
  { id: 'gemini-3.5-flash-lite', title: 'Ultra-rapide', sub: 'Gemini 3.5 Flash-Lite · latence minimale', thinking: 'minimal' },
  { id: 'gemini-3.6-flash', title: 'Équilibré', sub: 'Gemini 3.6 Flash · rapide et fiable (recommandé)', thinking: 'minimal' },
  { id: 'gemini-3.8-flash', title: 'Précis', sub: 'Gemini 3.8 Flash · plus fin sur les accents, un peu plus lent', thinking: 'low' }
];
const DEFAULT_MODEL = 'gemini-3.6-flash';
const API = 'https://generativelanguage.googleapis.com/v1beta';
const FORCE_SCRIPT_PROCESSOR = /[?&]audio=script\b/.test(location.search);

// ─── Réglages (gardés dans ce navigateur seulement) ──────────────────────────
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('td.' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('td.' + key, JSON.stringify(value)); } catch (e) { /* stockage indisponible */ }
  }
};

const S = {
  apiKey: store.get('apiKey', ''),
  model: store.get('model', DEFAULT_MODEL),
  priority: store.get('priority', true),
  showVi: store.get('showVi', true),
  cut: store.get('cut', 'complete'),
  engine: store.get('engine', 'live'),
  micId: store.get('micId', ''),
  micLabel: store.get('micLabel', ''),
  voices: store.get('voices', true)
};
if (!MODELS.some((m) => m.id === S.model)) S.model = DEFAULT_MODEL;
function save(key, value) { S[key] = value; store.set(key, value); }

function userText(context) {
  if (!context.length) return "Transcris et traduis l'extrait audio suivant.";
  const recent = context.map((c) => 'VI: ' + c.vi + '\nFR: ' + c.fr).join('\n');
  return 'Contexte récent (pour comprendre de quoi on parle, ne pas retraduire) :\n' + recent +
    "\n\nTranscris et traduis l'extrait audio suivant.";
}

// ─── Client Gemini ───────────────────────────────────────────────────────────
// Un seul appel par phrase : l'audio part avec la consigne, Gemini renvoie en streaming
// la transcription puis la traduction. Si l'API refuse un paramètre optionnel, on passe
// à une configuration plus simple (une seule fois, avant le premier succès).
const CONFIGS = [
  { api: 'interactions', tier: true, safety: true, thinking: true, label: 'Interactions API' },
  { api: 'interactions', tier: false, safety: true, thinking: true, label: 'Interactions API (sans mode prioritaire)' },
  { api: 'interactions', tier: false, safety: false, thinking: true, label: 'Interactions API (simplifiée)' },
  { api: 'generate', tier: false, safety: true, thinking: true, label: 'generateContent' },
  { api: 'generate', tier: false, safety: false, thinking: false, label: 'generateContent (simplifiée)' }
];
let cfgIndex = 0;
const tech = { note: '', mode: '', rate: 0, gain: null, ttfb: null, total: null, probe: null };

class GemError extends Error {
  constructor(kind, message, status) {
    super(message || kind);
    this.kind = kind;       // http | stream | empty | network | timeout
    this.status = status || 0;
  }
}

function currentModel() { return MODELS.find((m) => m.id === S.model) || MODELS[1]; }

function buildRequest(cfg, opts) {
  const m = currentModel();
  if (cfg.api === 'interactions') {
    const body = {
      model: m.id,
      input: [{ type: 'text', text: opts.text }],
      generation_config: { max_output_tokens: opts.maxTokens },
      store: false,
      stream: true
    };
    if (opts.system) body.system_instruction = opts.system;
    if (opts.audio) body.input.push({ type: 'audio', data: opts.audio, mime_type: 'audio/wav' });
    if (cfg.thinking) body.generation_config.thinking_level = m.thinking;
    // Une dispute contient insultes et menaces : elles doivent être traduites, pas filtrées.
    if (cfg.safety) body.safety_settings = ['harassment', 'hate_speech', 'sexually_explicit', 'dangerous_content'].map((type) => ({ type, threshold: 'off' }));
    if (cfg.tier && S.priority) body.service_tier = 'priority';
    return { url: API + '/interactions', body };
  }
  const parts = [{ text: opts.text }];
  if (opts.audio) parts.push({ inlineData: { mimeType: 'audio/wav', data: opts.audio } });
  const body = { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: opts.maxTokens } };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  if (cfg.thinking) body.generationConfig.thinkingConfig = { thinkingLevel: m.thinking };
  if (cfg.safety) {
    body.safetySettings = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
      .map((category) => ({ category, threshold: 'OFF' }));
  }
  return { url: API + '/models/' + m.id + ':streamGenerateContent?alt=sse', body };
}

function errorText(raw) {
  try {
    const json = JSON.parse(raw);
    const obj = Array.isArray(json) ? json[0] : json;
    if (obj && obj.error && obj.error.message) return obj.error.message;
    if (obj && obj.message) return obj.message;
  } catch (e) { /* pas du JSON */ }
  return String(raw || '').slice(0, 300);
}

/** Texte apporté par un événement SSE, quel que soit le format (Interactions ou generateContent). */
function eventText(o, sseName) {
  const type = o.event_type || sseName || '';
  if (type === 'error' || (o.error && !o.candidates)) {
    throw new GemError('stream', (o.error && o.error.message) || 'erreur inconnue');
  }
  if (type === 'interaction.completed' || type === 'interaction.complete') {
    if (o.interaction && o.interaction.status === 'failed') throw new GemError('stream', 'échec de la génération');
    return '';
  }
  const texts = (items) => (Array.isArray(items) ? items : [])
    .filter((i) => i && i.type === 'text' && typeof i.text === 'string').map((i) => i.text).join('');
  if (type === 'step.start') return o.step && o.step.type !== 'thought' ? texts(o.step.content) : '';
  if (type === 'content.start') return o.content ? texts([o.content]) : '';
  if (o.delta) return o.delta.type === 'text' && typeof o.delta.text === 'string' ? o.delta.text : '';
  if (o.candidates) {
    const c = o.candidates[0];
    const parts = c && c.content && c.content.parts;
    return Array.isArray(parts) ? parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('') : '';
  }
  if (o.promptFeedback && o.promptFeedback.blockReason) {
    throw new GemError('stream', 'contenu bloqué (' + o.promptFeedback.blockReason + ')');
  }
  return '';
}

async function streamOnce(cfg, opts) {
  const req = buildRequest(cfg, opts);
  const ctl = new AbortController();
  let timedOut = false;
  let idleTimer = 0;
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = true; ctl.abort(); }, 20000);
  };
  const hardTimer = setTimeout(() => { timedOut = true; ctl.abort(); }, 60000);
  arm();
  let text = '';
  try {
    let res;
    try {
      res = await fetch(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.apiKey },
        body: JSON.stringify(req.body),
        signal: ctl.signal,
        cache: 'no-store'
      });
    } catch (e) {
      throw new GemError(timedOut ? 'timeout' : 'network', e && e.message);
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new GemError('http', errorText(raw), res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let eventName = '';
    let data = [];
    const dispatch = () => {
      if (!data.length) { eventName = ''; return; }
      const payload = data.join('\n');
      const name = eventName;
      data = [];
      eventName = '';
      if (payload === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(payload); } catch (e) { return; }
      const added = eventText(obj, name);
      if (added) {
        text += added;
        if (opts.onText) opts.onText(text);
      }
    };
    const line = (l) => {
      if (l.endsWith('\r')) l = l.slice(0, -1);
      if (l === '') { dispatch(); return; }
      if (l[0] === ':') return;
      const colon = l.indexOf(':');
      const field = colon < 0 ? l : l.slice(0, colon);
      let value = colon < 0 ? '' : l.slice(colon + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') data.push(value);
    };
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) {
        throw new GemError(timedOut ? 'timeout' : 'network', e && e.message);
      }
      if (chunk.done) break;
      arm();
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode();
    if (buf) line(buf);
    dispatch();
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  }
  if (!text) throw new GemError('empty', 'Réponse vide de Gemini.');
  return text;
}

function isKeyError(err) {
  return err && err.kind === 'http' &&
    (err.status === 401 || err.status === 403 || (err.status === 400 && /api.?key/i.test(err.message)));
}

function isTransient(err) {
  if (!err) return false;
  if (err.kind === 'http') return err.status === 408 || err.status === 429 || err.status >= 500;
  return err.kind === 'stream' || err.kind === 'empty' || err.kind === 'network' || err.kind === 'timeout';
}

/** Paramètre refusé par l'API (et pas un problème de clé, de modèle ou d'audio déjà validé). */
function shouldSimplify(err, cfg, withAudio) {
  if (!err || err.kind !== 'http' || isKeyError(err)) return false;
  if (err.status === 404) return cfg.api === 'interactions' && err.message.indexOf(S.model) < 0;
  if (err.status !== 400) return false;
  return withAudio ? !cfg.audioProven : !cfg.proven;
}

function errorMessage(err) {
  if (!err) return 'Erreur inconnue.';
  switch (err.kind) {
    case 'network':
      return navigator.onLine === false
        ? "Pas de connexion. L'audio est gardé et repartira dès que le réseau revient."
        : 'Réseau : impossible de joindre Gemini.';
    case 'timeout': return 'Délai dépassé (réseau lent).';
    case 'stream': return 'Gemini : ' + err.message;
    case 'empty': return 'Réponse vide de Gemini.';
    case 'http':
      if (/referer|referrer/i.test(err.message)) return "Cette clé n'accepte pas les appels depuis ce site : ajoutez l'adresse de la page dans ses restrictions (Google Cloud).";
      if (isKeyError(err)) return err.status === 400 ? 'Clé API invalide : vérifiez-la dans les réglages.' : 'Clé API refusée : vérifiez-la dans les réglages.';
      if (err.status === 404) return 'Modèle introuvable : choisissez-en un autre dans les réglages.';
      if (err.status === 429) return 'Quota Gemini atteint. Activez la facturation sur le projet de la clé (Google AI Studio).';
      if (err.status >= 500) return 'Gemini est momentanément indisponible.';
      return 'Erreur Gemini ' + err.status + ' : ' + err.message;
    default: return String(err.message || err);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Configuration suivante qui change vraiment la requête (sans mode prioritaire, la 1re et la 2e sont identiques). */
function nextConfig(index) {
  const same = (a, b) => a.api === b.api && a.safety === b.safety && a.thinking === b.thinking && (a.tier && S.priority) === (b.tier && S.priority);
  let next = index + 1;
  while (next < CONFIGS.length - 1 && same(CONFIGS[next], CONFIGS[index])) next++;
  return next;
}

/** Appel complet : simplification automatique et nouvelles tentatives sur les erreurs passagères. */
async function gemini(opts) {
  let attempt = 0;
  let simplifications = 0;
  for (;;) {
    const index = cfgIndex;
    const cfg = CONFIGS[index];
    attempt++;
    try {
      const text = await streamOnce(cfg, opts);
      cfg.proven = true;
      if (opts.audio) cfg.audioProven = true;
      return text;
    } catch (err) {
      if (shouldSimplify(err, cfg, !!opts.audio) && simplifications < CONFIGS.length) {
        if (index === cfgIndex && cfgIndex < CONFIGS.length - 1) {
          cfgIndex = err.status === 404 ? CONFIGS.findIndex((c) => c.api === 'generate') : nextConfig(cfgIndex);
          tech.note = 'Paramètre refusé (' + err.status + ' : ' + err.message.slice(0, 120) + ')';
        }
        if (index !== cfgIndex) {
          simplifications++;
          attempt--;
          continue;
        }
      }
      if (attempt >= 3 || !isTransient(err)) throw err;
      await sleep(err.status === 429 ? 1500 * attempt : 400 * attempt);
    }
  }
}

/** Requête minuscule (texte seul) : vérifie la clé et les paramètres, et ouvre la connexion à l'avance. */
async function probe() {
  const t0 = performance.now();
  try {
    await gemini({ text: 'Réponds uniquement : OK', maxTokens: 256 });
    return { ok: true, ms: performance.now() - t0 };
  } catch (err) {
    if (err.kind === 'empty') return { ok: true, ms: performance.now() - t0 };
    return { ok: false, err };
  }
}

function warmUp() {
  if (!S.apiKey) return;
  probe().then((r) => {
    tech.probe = r;
    if (!r.ok && (isKeyError(r.err) || (r.err.kind === 'http' && (r.err.status === 404 || r.err.status === 429)))) {
      showBanner(errorMessage(r.err));
    }
    if (!sheet.hidden) renderTech();
  });
}

// ─── Interface ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const app = $('app');
const feed = $('feed');
const linesEl = $('lines');
const emptyEl = $('empty');
const micBtn = $('micBtn');
const hint = $('hint');
const statusText = $('statusText');
const dot = $('dot');
const clearBtn = $('clearBtn');
const livePill = $('livePill');
const banner = $('banner');
const sheet = $('sheet');

const lines = [];
let lineSeq = 0;
let listening = false;
let starting = false;
let inFlight = 0;
let follow = true;
let micName = '';
let micBusy = false;

function showBanner(text) {
  $('bannerText').textContent = text;
  banner.hidden = false;
}
function hideBanner() { banner.hidden = true; }
$('bannerClose').addEventListener('click', hideBanner);

function updateStatus() {
  let text;
  if (listening) {
    text = (micBusy ? 'Micro occupé' : (micName || 'Micro')) +
      (engine === 'live' && live.on && live.state !== 'connected' ? (live.state === 'reconnecting' ? ' · reconnexion…' : ' · connexion…') : '') +
      (inFlight ? ' · ' + inFlight + ' en cours' : '');
  } else {
    text = starting ? 'Démarrage…' : 'En pause';
  }
  statusText.textContent = text;
  dot.classList.toggle('on', listening && !micBusy);
  micBtn.classList.toggle('on', listening);
  micBtn.setAttribute('aria-label', listening ? "Arrêter l'écoute" : 'Écouter');
  micBtn.setAttribute('aria-pressed', listening ? 'true' : 'false');
  hint.textContent = listening ? 'En écoute · toucher pour arrêter' : (starting ? 'Démarrage du micro…' : 'Toucher pour écouter');
  clearBtn.disabled = !linesEl.children.length;
  emptyEl.hidden = linesEl.children.length > 0;
}

function setLevel(v) {
  micBtn.style.setProperty('--lvl', listening ? v.toFixed(3) : '0');
}

// Lignes : rendu groupé à chaque image, seuls les nœuds modifiés sont touchés.
const dirty = new Set();
let rafId = 0;
function render(line) {
  dirty.add(line);
  if (!rafId) rafId = requestAnimationFrame(flushRender);
}
function flushRender() {
  rafId = 0;
  dirty.forEach(paint);
  dirty.clear();
  if (follow) toBottom();
}

function mountLine(line) {
  const el = document.createElement('article');
  const fr = document.createElement('p');
  fr.className = 'fr';
  const vi = document.createElement('p');
  vi.className = 'vi';
  vi.lang = 'vi';
  const err = document.createElement('div');
  err.className = 'err';
  const errText = document.createElement('p');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'retry';
  retry.textContent = 'Réessayer';
  retry.addEventListener('click', () => retryLine(line));
  err.append(errText, retry);
  el.append(fr, vi, err);
  line.el = el;
  line.parts = { fr, vi, err, errText };
  linesEl.appendChild(el);
  paint(line);
  updateStatus();
  if (follow) toBottom();
}

function paint(line) {
  if (!line.el) return;
  const p = line.parts;
  line.el.className = 'line is-' + line.status;
  const failed = line.status === 'failed';
  p.err.hidden = !failed;
  p.fr.hidden = failed;
  if (failed) p.errText.textContent = line.error;
  const labels = S.voices && line.voiceIds ? voiceRuns(line.voiceIds).map(voiceLabel) : [];
  if (labels.length) {
    const n = labels.length;
    line.el.style.setProperty('--stripe', n === 1 ? 'var(--v' + labels[0].color + ')'
      : 'linear-gradient(' + labels.map((l, i) => 'var(--v' + l.color + ') ' + (i * 100 / n) + '% ' + ((i + 1) * 100 / n) + '%').join(', ') + ')');
  } else {
    line.el.style.removeProperty('--stripe');
  }
  if (line.fr) {
    renderFrench(p.fr, line.fr, labels);
    p.fr.classList.remove('wait');
  } else if (!failed) {
    p.fr.textContent = '';
    for (const l of labels) p.fr.append(voiceChip(l));
    p.fr.append('Traduction');
    p.fr.classList.add('wait');
  }
  const showVi = S.showVi && !isBlank(line.vi);
  p.vi.hidden = !showVi;
  if (showVi) p.vi.textContent = line.vi;
}

function addNote(text) {
  const note = document.createElement('p');
  note.className = 'note-line';
  note.textContent = text;
  linesEl.appendChild(note);
  updateStatus();
  if (follow) toBottom();
}

function toBottom() { feed.scrollTop = feed.scrollHeight; }

feed.addEventListener('scroll', () => {
  const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 60;
  if (atBottom !== follow) {
    follow = atBottom;
    livePill.hidden = follow;
  }
}, { passive: true });

livePill.addEventListener('click', () => {
  follow = true;
  livePill.hidden = true;
  feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
});

// Effacer : un deuxième appui confirme (dans les 3 secondes).
let clearArmed = 0;
clearBtn.addEventListener('click', () => {
  if (clearArmed) {
    clearTimeout(clearArmed);
    clearArmed = 0;
    clearBtn.classList.remove('armed');
    clearAll();
    return;
  }
  clearBtn.classList.add('armed');
  clearArmed = setTimeout(() => { clearArmed = 0; clearBtn.classList.remove('armed'); }, 3000);
});

function clearAll() {
  for (const line of lines) { line.dead = true; line.el = null; }
  lines.length = 0;
  voiceReset();
  live.lastLine = null;
  liveHideInterim();
  linesEl.textContent = '';
  follow = true;
  livePill.hidden = true;
  updateStatus();
}

// ─── Traduction ──────────────────────────────────────────────────────────────
function enqueue(samples) {
  const line = {
    id: ++lineSeq,
    createdAt: Date.now(),
    audio: toBase64(encodeWAV(samples, 16000)),
    vi: '', fr: '',
    status: 'waiting', error: '', autoRetry: false, voiceIds: null
  };
  lines.push(line);
  mountLine(line);
  translate(line);
  voiceEmbed(line, samples);
}

function recentContext(line) {
  const index = lines.indexOf(line);
  const cutoff = line.createdAt - 120000;
  const out = [];
  for (let k = index - 1; k >= 0 && out.length < 4; k--) {
    const prev = lines[k];
    if (prev.createdAt < cutoff) break;
    if (prev.status === 'done' && prev.fr) out.unshift({ vi: prev.vi, fr: prev.fr });
  }
  return out;
}

async function translate(line) {
  if (!line.audio || line.dead) return;
  if (!S.apiKey) {
    Object.assign(line, { status: 'failed', error: 'Ajoutez votre clé API Gemini dans les réglages.', autoRetry: false });
    render(line);
    return;
  }
  Object.assign(line, { status: 'waiting', error: '', autoRetry: false, vi: '', fr: '' });
  render(line);
  inFlight++;
  updateStatus();
  const t0 = performance.now();
  let first = 0;
  try {
    const raw = await gemini({
      system: PROMPT,
      text: userText(recentContext(line)),
      audio: line.audio,
      maxTokens: 1024,
      onText: (text) => {
        if (!first) first = performance.now();
        if (line.dead) return;
        const parsed = parseResponse(text);
        line.vi = parsed.vi;
        line.fr = parsed.fr;
        line.status = 'streaming';
        render(line);
      }
    });
    tech.ttfb = first ? first - t0 : null;
    tech.total = performance.now() - t0;
    finishLine(line, raw);
    retryFailed();
  } catch (err) {
    if (!line.dead) {
      // Clé refusée : l'audio est gardé et repartira dès qu'une clé valide sera enregistrée.
      Object.assign(line, { status: 'failed', error: errorMessage(err), autoRetry: isTransient(err) || isKeyError(err) });
      render(line);
    }
    if (isKeyError(err)) showBanner(errorMessage(err));
  } finally {
    inFlight--;
    updateStatus();
  }
}

function finishLine(line, raw) {
  if (line.dead) return;
  const parsed = parseResponse(raw);
  if (isNoiseOnly(parsed.vi) && isNoiseOnly(parsed.fr)) {
    // Bruit, rires, applaudissements, musique, silence : la ligne disparaît.
    removeLine(line);
    return;
  }
  Object.assign(line, {
    vi: parsed.vi,
    fr: parsed.fr || '(pas de traduction)',
    status: 'done',
    audio: null
  });
  render(line);
}

function removeLine(line) {
  line.dead = true;
  const i = lines.indexOf(line);
  if (i >= 0) lines.splice(i, 1);
  if (line.el) line.el.remove();
  line.el = null;
  updateStatus();
}

function retryLine(line) {
  if (line.status !== 'failed') return;
  if (line.kind === 'live') translateText(line);
  else translate(line);
}

/** Le réseau est revenu : on relance les phrases perdues pendant la coupure. */
function retryFailed() {
  for (const line of lines) {
    if (line.status === 'failed' && line.autoRetry && (line.kind === 'live' || line.audio)) retryLine(line);
  }
}
window.addEventListener('online', retryFailed);

// ─── Voix : une couleur par personne ─────────────────────────────────────────
// L'empreinte vocale de chaque phrase est calculée sur l'appareil (CAM++, ONNX Runtime Web,
// dans un worker) pendant que Gemini traduit. Rien de plus n'est envoyé sur le réseau.
// ONNX Runtime Web : copie publiée à côté de la page (dossier ort/) si elle existe, sinon jsDelivr.
const ORT_DIRS = [new URL('ort/', location.href).href, 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/'];
const VOICE_MODEL = 'voix.onnx';
const VOICE_WORKER = [
  Fbank.toString(),
  voicedPart.toString(),
  `const fb = new Fbank();
let ort = null;
let ready = null;
async function runtime(dirs) {
  let last = null;
  for (const dir of dirs) {
    try {
      const m = await import(dir + 'ort.wasm.min.mjs');
      m.env.wasm.wasmPaths = dir;
      m.env.wasm.numThreads = 1;
      return m;
    } catch (e) { last = e; }
  }
  throw new Error('moteur ONNX introuvable (' + ((last && last.message) || last) + ')');
}
async function load(url, dirs) {
  ort = await runtime(dirs);
  let res = null;
  try {
    const cache = await caches.open('td-voix-1');
    res = await cache.match(url);
    if (!res) {
      const fresh = await fetch(url);
      if (!fresh.ok) throw new Error('modèle introuvable (' + fresh.status + ')');
      await cache.put(url, fresh.clone()).catch(() => {});
      res = fresh;
    }
  } catch (e) {
    if (e && /introuvable/.test(e.message)) throw e;
    res = await fetch(url);
    if (!res.ok) throw new Error('modèle introuvable (' + res.status + ')');
  }
  const buf = await res.arrayBuffer();
  const session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return { session, size: buf.byteLength };
}
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    ready = load(m.url, m.ort);
    ready.then((r) => postMessage({ type: 'ready', size: r.size }), (err) => postMessage({ type: 'error', message: String((err && err.message) || err) }));
    return;
  }
  if (m.type === 'embed') {
    const list = [];
    const t0 = performance.now();
    try {
      const { session } = await ready;
      const w = fb.windows(voicedPart(m.samples));
      if (w.n) {
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', w.data, [w.n, w.frames, 80]) });
        const all = out[session.outputNames[0]].data, d = all.length / w.n;
        for (let i = 0; i < w.n; i++) list.push(all.slice(i * d, (i + 1) * d));
      }
    } catch (err) { /* modèle indisponible : la phrase reste sans couleur */ }
    postMessage({ type: 'embeddings', id: m.id, list, ms: performance.now() - t0 });
  }
};`
].join('\n');

const voice = { worker: null, state: 'off', error: '', size: 0, ms: 0, seq: 0, waiting: new Map(), clusters: new VoiceClusters(), labels: new Map() };

function voiceStart() {
  if (!S.voices || voice.worker || typeof Worker === 'undefined') return;
  try {
    const url = URL.createObjectURL(new Blob([VOICE_WORKER], { type: 'text/javascript' }));
    voice.worker = new Worker(url, { type: 'module' });
    voice.worker.onmessage = (e) => voiceMessage(e.data);
    voice.worker.onerror = (e) => { voice.state = 'error'; voice.error = (e && e.message) || 'le calcul des voix a échoué'; if (!sheet.hidden) renderTech(); };
    voice.state = 'loading';
    voice.worker.postMessage({ type: 'init', url: new URL(VOICE_MODEL, location.href).href, ort: ORT_DIRS });
  } catch (e) {
    voice.state = 'error';
    voice.error = String((e && e.message) || e);
  }
}

function voiceStop() {
  if (voice.worker) voice.worker.terminate();
  voice.worker = null;
  voice.state = 'off';
  voice.waiting.clear();
}

function voiceEmbed(line, samples) {
  if (!S.voices || !voice.worker || voice.state === 'error') return;
  const id = ++voice.seq;
  voice.waiting.set(id, line);
  voice.worker.postMessage({ type: 'embed', id, samples }, [samples.buffer]);
}

function voiceMessage(m) {
  if (m.type === 'ready') {
    voice.state = 'ready';
    voice.size = m.size;
  } else if (m.type === 'error') {
    voice.state = 'error';
    voice.error = m.message;
  } else if (m.type === 'embeddings') {
    voice.ms = m.ms;
    const line = voice.waiting.get(m.id);
    voice.waiting.delete(m.id);
    if (!line || line.dead || !m.list.length) return;
    line.voiceIds = voice.clusters.assign(m.list);
    const merged = voice.clusters.mergeClose();
    if (Object.keys(merged).length) {
      for (const other of lines) {
        if (!other.voiceIds) continue;
        other.voiceIds = other.voiceIds.map((id) => (id !== null && merged[id] ? merged[id] : id));
        render(other);
      }
    }
    render(line);
  }
  if (!sheet.hidden) renderTech();
}

function voiceReset() {
  voice.clusters.reset();
  voice.labels.clear();
  voice.waiting.clear();
}

/** Lettre et couleur d'une voix, dans l'ordre d'apparition (A, B, C…). */
function voiceLabel(id) {
  if (!voice.labels.has(id)) {
    const n = voice.labels.size;
    voice.labels.set(id, { letter: String.fromCharCode(65 + (n % 26)), color: (n % 6) + 1 });
  }
  return voice.labels.get(id);
}

function voiceChip(label) {
  const chip = document.createElement('span');
  chip.className = 'who v' + label.color;
  chip.textContent = label.letter;
  chip.setAttribute('aria-label', 'Voix ' + label.letter);
  return chip;
}

/** Traduction avec la lettre de chaque voix ; « / » sépare les répliques quand Gemini en entend plusieurs. */
function renderFrench(el, text, labels) {
  el.textContent = '';
  const turns = text.split(/\s+\/\s+/);
  if (labels.length > 1 && turns.length === labels.length) {
    turns.forEach((turn, i) => {
      const row = document.createElement('span');
      row.className = 'turn';
      row.append(voiceChip(labels[i]), frenchSpacing(turn));
      el.append(row);
    });
    return;
  }
  for (const l of labels) el.append(voiceChip(l));
  el.append(frenchSpacing(text));
}

// ─── Écoute continue : Gemini 3.5 Transcribe Live ────────────────────────────
// Le micro part en continu (PCM 16 kHz, morceaux de 100 ms) vers un modèle fait pour la
// transcription. Il renvoie le vietnamien au fil de la parole, puis une transcription finale
// à chaque pause, avec sa langue et ses horodatages. Chaque phrase finale est traduite en
// texte seul. Une session dure au plus 10 minutes : la suivante s'ouvre avant, sans coupure.
const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const LIVE_MODEL = 'models/gemini-3.5-transcribe-live';
const LIVE_ROTATE_MS = 9 * 60 * 1000;
const RATE = 16000;

const TRANSLATE_PROMPT = `Tu es traducteur vietnamien → français. On te donne la transcription automatique de ce qui vient d'être dit autour d'une personne qui ne parle pas vietnamien : accent du Sud (Saigon), du Centre ou du Nord, souvent une conversation à plusieurs, avec du bruit. La transcription peut contenir des erreurs.

Ta seule tâche : traduire la phrase en français, fidèlement. Tu ne juges pas, tu n'interprètes ni les intentions ni les émotions, tu ne commentes pas.

- Même sens, même niveau de langue, ni plus ni moins. Français courant et naturel, sans mot à mot.
- N'ajoute ni émotion, ni intensité, ni exclamation, ni juron absents du texte.
- Mot sans doute mal transcrit : prends le sens le plus vraisemblable d'après la phrase et le contexte, suivi de (?). Passage qui n'a aucun sens : traduis ce qui est sûr et mets […] pour le reste. N'invente rien.
- Phrases de plusieurs personnes mêlées : traduis séparément chaque morceau compréhensible, séparés par « / », sans les fondre en une seule phrase.
- Phrase incomplète : traduis le fragment tel quel, sans le compléter.
- Particules finales (nè, nha, hen, mà, hả, ơi, hỉ, tề, nghe…) : marques ordinaires de l'oral, sans agacement ni agressivité. Tao/mày (tau/mi au Centre) : « je » et « tu » familiers, sans hostilité. Anh, chị, em, cô, chú, bác, ông, bà : tu ou vous selon la relation ; ổng, bả, ảnh, chỉ, nó, hắn : il ou elle.
- Insulte ou menace dite avec des mots explicites : traduis-la telle quelle, sans l'adoucir ni l'amplifier.
- Chiffres, sommes, heures, lieux, noms : exacts. À l'oral, les milliers sont souvent sous-entendus (« hai trăm » = 200 000 đ, « năm chục » = 50 000 đ) ; argot : « xị » ou « lít » = 100 000 đ, « củ » = 1 000 000 đ.
- Sud : hông, hổng = không ; dzậy = vậy ; dzô = vào ; dìa = về ; nè = này ; hồi sáng = sáng nay ; hồi nãy = lúc nãy ; mắc = đắt ; xài = dùng ; kêu = gọi ; tụi = bọn ; bển = bên đó ; « cái quần (què) » = rejet moqueur (« mon œil », « n'importe quoi »).
- Centre : mô = đâu, tê = kia, ni = này, nớ = đó, răng = sao, rứa = vậy, chi = gì, chừ = bây giờ, mần = làm, nỏ = không, ưng = thích, hắn = nó, mạ = mẹ, o = cô, mệ = bà, nác = nước, trốc = đầu, chộ = thấy.
- Le contexte précédent sert à comprendre de quoi on parle : ne le retraduis pas.
- Texte en anglais ou en français, ou sans parole réelle : réponds uniquement -

Réponds uniquement par la traduction française, sur une ligne, sans guillemets ni étiquette.`;

let engine = 'clips';
const live = {
  on: false, current: null, next: null, sessions: new Set(), queue: [], ring: [], pos: 0,
  worked: false, retries: 0, state: 'off', error: '', lastLine: null, interimTimer: 0, rotateTimer: 0, seq: 0
};

/** Lettres propres au vietnamien (absentes du français et de l'anglais). */
const VIET_ONLY = /[áảãạăằắẳẵặấầẩẫậđẻẽẹếềểễệìíỉĩịòóỏõọốồổỗộơờớởỡợúủũụưừứửữựỳýỷỹỵ]/i;
function isForeignSpeech(text, code) {
  if (code) {
    if (/^vi/i.test(code)) return false;
    if (/^(en|fr)/i.test(code)) return true;
  }
  return !VIET_ONLY.test(text);
}

function durationSeconds(d) {
  if (d === undefined || d === null) return null;
  if (typeof d === 'number') return d;
  if (typeof d === 'string') { const v = parseFloat(d); return Number.isFinite(v) ? v : null; }
  if (typeof d === 'object') { const v = Number(d.seconds || 0) + Number(d.nanos || 0) / 1e9; return Number.isFinite(v) ? v : null; }
  return null;
}

function liveStart() {
  for (const old of live.sessions) { old.closing = true; try { old.ws.close(); } catch (e) { /* déjà fermée */ } }
  Object.assign(live, { on: true, current: null, next: null, queue: [], ring: [], pos: 0, worked: false, retries: 0, state: 'connecting', error: '', lastLine: null });
  live.sessions = new Set();
  liveOpen('current');
}

function liveOpen(role) {
  const session = { id: ++live.seq, ws: null, ready: false, base: null, closing: false, setupTimer: 0 };
  live.sessions.add(session);
  if (role === 'next') live.next = session; else live.current = session;
  let ws;
  try {
    ws = new WebSocket(LIVE_URL + '?key=' + encodeURIComponent(S.apiKey));
  } catch (e) {
    setTimeout(() => liveClosed(session, { code: 0, reason: 'connexion impossible' }), 0);
    return session;
  }
  session.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({
      setup: {
        model: LIVE_MODEL,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: ['vi-VN', 'en-US'] }
      }
    }));
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') liveMessage(session, e.data);
    else if (e.data && typeof e.data.text === 'function') e.data.text().then((t) => liveMessage(session, t));
    else if (e.data instanceof ArrayBuffer) liveMessage(session, new TextDecoder().decode(e.data));
  };
  ws.onerror = () => { /* la fermeture suit et donne la raison */ };
  ws.onclose = (e) => liveClosed(session, e);
  session.setupTimer = setTimeout(() => {
    if (!session.ready) { try { ws.close(4000, 'pas de réponse du serveur'); } catch (e) { /* déjà fermée */ } }
  }, 8000);
  return session;
}

function liveMessage(session, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (msg.setupComplete) {
    session.ready = true;
    clearTimeout(session.setupTimer);
    Object.assign(live, { worked: true, retries: 0, state: 'connected', error: '' });
    if (session === live.next) {
      const old = live.current;
      live.current = session;
      live.next = null;
      if (old) liveEnd(old);
    }
    if (session === live.current) {
      liveFlushQueue();
      clearTimeout(live.rotateTimer);
      live.rotateTimer = setTimeout(liveRotate, LIVE_ROTATE_MS);
    }
    updateStatus();
    if (!sheet.hidden) renderTech();
    return;
  }
  if (msg.goAway) {
    if (session === live.current) liveRotate();
    return;
  }
  const c = msg.serverContent;
  if (!c) return;
  if (c.interimInputTranscription && c.interimInputTranscription.text) liveInterim(c.interimInputTranscription.text);
  if (c.inputTranscription && c.inputTranscription.text) liveFinal(session, c.inputTranscription);
}

/** Morceau de 100 ms venu du micro. */
function liveSend(chunk) {
  live.ring.push(chunk);
  if (live.ring.length > 900) live.ring.shift();   // 90 s gardées pour la reconnaissance des voix
  live.pos = chunk.end;
  if (!live.on) return;
  const s = live.current;
  if (s && s.ready && s.ws && s.ws.readyState === 1) liveWrite(s, chunk);
  else {
    live.queue.push(chunk);
    if (live.queue.length > 300) live.queue.shift();   // 30 s au plus pendant une reconnexion
  }
}

function liveWrite(session, chunk) {
  if (session.base === null) session.base = chunk.end - chunk.data.length;
  session.ws.send(JSON.stringify({
    realtimeInput: { audio: { data: toBase64(new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)), mimeType: 'audio/pcm;rate=16000' } }
  }));
}

function liveFlushQueue() {
  const s = live.current;
  if (!s || !s.ready || !s.ws || s.ws.readyState !== 1) return;
  while (live.queue.length) liveWrite(s, live.queue.shift());
}

/** Relève avant la limite de 10 minutes (ou à l'annonce du serveur). */
function liveRotate() {
  if (!live.on || live.next) return;
  liveOpen('next');
}

/** Fin propre : le serveur finalise la phrase en cours, puis la session se ferme. */
function liveEnd(session) {
  if (session.closing) return;
  session.closing = true;
  try { if (session.ws && session.ws.readyState === 1) session.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch (e) { /* fermée */ }
  setTimeout(() => { try { session.ws.close(1000, 'fin'); } catch (e) { /* fermée */ } }, 3000);
}

function liveClosed(session, e) {
  clearTimeout(session.setupTimer);
  live.sessions.delete(session);
  if (session.closing || !live.on) return;
  const reason = (e && e.reason) || ('fermeture ' + ((e && e.code) || '?'));
  if (session === live.next) {
    live.next = null;
    setTimeout(liveRotate, 5000);
    return;
  }
  if (session !== live.current) return;
  live.current = null;
  // Refusé dès l'ouverture (modèle indisponible, clé…) : retour au mode par extraits.
  if (!session.ready && !live.worked) { liveFallback(reason); return; }
  if (++live.retries > 4) { liveFallback(reason); return; }
  Object.assign(live, { state: 'reconnecting', error: reason });
  updateStatus();
  setTimeout(() => { if (live.on && !live.current) liveOpen('current'); }, Math.min(4000, 250 * Math.pow(2, live.retries)));
}

/** Au retour au premier plan : rouvrir si iOS a coupé la connexion. */
function liveEnsure() {
  if (!live.on) return;
  const s = live.current;
  if (!s || (s.ws && s.ws.readyState > 1)) {
    if (s) { s.closing = true; live.sessions.delete(s); }
    live.current = null;
    liveOpen('current');
  }
}

function liveFallback(reason) {
  live.on = false;
  Object.assign(live, { state: 'error', error: reason });
  for (const s of live.sessions) { s.closing = true; try { s.ws.close(); } catch (e) { /* fermée */ } }
  live.sessions = new Set();
  live.current = null;
  live.next = null;
  clearTimeout(live.rotateTimer);
  liveHideInterim();
  engine = 'clips';
  if (cap.node) cap.node.port.postMessage({ type: 'stream', on: false });
  // L'audio pas encore transcrit passe par le découpage habituel : rien n'est perdu.
  const pending = live.queue.splice(0);
  if (pending.length) {
    const seg = new Segmenter(currentTuning());
    for (const c of pending) {
      const f = new Float32Array(c.data.length);
      for (let i = 0; i < f.length; i++) f[i] = c.data[i] / 32768;
      for (const out of seg.push(f)) enqueue(out);
    }
    const last = seg.flush();
    if (last) enqueue(last);
  }
  showBanner('Écoute continue indisponible (' + reason + "). L'app traduit par extraits, comme avant.");
  updateStatus();
}

async function liveStop() {
  live.on = false;
  clearTimeout(live.rotateTimer);
  liveHideInterim();
  const s = live.current;
  if (s && s.ready && s.ws && s.ws.readyState === 1) {
    liveEnd(s);
    await sleep(1500);   // laisse arriver la dernière phrase
  }
  for (const x of live.sessions) { x.closing = true; try { x.ws.close(1000, 'fin'); } catch (e) { /* fermée */ } }
  live.sessions = new Set();
  live.current = null;
  live.next = null;
  live.state = 'off';
}

function liveInterim(text) {
  const el = $('interim');
  el.textContent = text;
  el.hidden = false;
  emptyEl.hidden = true;
  clearTimeout(live.interimTimer);
  live.interimTimer = setTimeout(liveHideInterim, 4000);
  if (follow) toBottom();
}

function liveHideInterim() {
  clearTimeout(live.interimTimer);
  const el = $('interim');
  el.hidden = true;
  el.textContent = '';
  emptyEl.hidden = linesEl.children.length > 0;
}

function liveFinal(session, tr) {
  const text = String(tr.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  liveHideInterim();
  const now = performance.now();
  const at = (d) => {
    const v = durationSeconds(d);
    return v === null || session.base === null ? null : session.base + Math.round(v * RATE);
  };
  let end = at(tr.endOffset);
  let start = at(tr.startOffset);
  if (end === null) end = live.pos - Math.round(0.6 * RATE);
  if (start === null || start >= end) start = end - Math.round(Math.min(8, Math.max(0.8, text.split(' ').length * 0.25)) * RATE);
  // Une phrase livrée en plusieurs morceaux rapprochés reste une seule ligne.
  const prev = live.lastLine;
  if (prev && !prev.dead && prev.session === session && now - prev.finalAt < 350) {
    prev.vi += ' ' + text;
    prev.finalAt = now;
    prev.span[1] = Math.max(prev.span[1], end);
    render(prev);
    translateText(prev);
    return;
  }
  if (isForeignSpeech(text, tr.languageCode)) return;   // anglais ou français : rien à traduire
  const line = {
    id: ++lineSeq, kind: 'live', session, createdAt: Date.now(), finalAt: now,
    vi: text, fr: '', status: 'waiting', error: '', autoRetry: false, voiceIds: null, span: [start, end]
  };
  live.lastLine = line;
  lines.push(line);
  mountLine(line);
  translateText(line);
  liveVoice(line);
}

/** Audio d'une phrase, retrouvé dans les 90 dernières secondes, pour la couleur de la voix. */
function liveVoice(line) {
  if (!S.voices || !voice.worker || voice.state === 'error') return;
  const a = Math.max(0, line.span[0] - Math.round(0.15 * RATE));
  const b = Math.min(live.pos, line.span[1] + Math.round(0.15 * RATE));
  if (b - a < 0.6 * RATE) return;
  const out = new Float32Array(Math.min(b - a, 12 * RATE));
  let filled = 0;
  for (const c of live.ring) {
    const cs = c.end - c.data.length;
    if (c.end <= a || cs >= b) continue;
    for (let i = Math.max(a, cs); i < Math.min(b, c.end) && i - a < out.length; i++) { out[i - a] = c.data[i - cs] / 32768; filled++; }
  }
  if (filled >= 0.6 * RATE) voiceEmbed(line, out);
}

function cleanFrench(text) {
  return String(text || '').replace(/\s*\n+\s*/g, ' ').replace(/^\s*FR\s*[:：]\s*/i, '').replace(/^["«“]\s*|\s*["»”]$/g, '').trim();
}

function translateUserText(context, vi) {
  const recent = context.length ? 'Contexte récent (ne pas retraduire) :\n' + context.map((c) => 'VI: ' + c.vi + '\nFR: ' + c.fr).join('\n') + '\n\n' : '';
  return recent + 'Phrase à traduire :\n' + vi;
}

/** Traduction d'une phrase transcrite (texte seul : plus rapide qu'avec l'audio). */
async function translateText(line) {
  if (line.dead) return;
  if (line.translating) { line.again = true; return; }
  if (!S.apiKey) {
    Object.assign(line, { status: 'failed', error: 'Ajoutez votre clé API Gemini dans les réglages.', autoRetry: false });
    render(line);
    return;
  }
  line.translating = true;
  line.again = false;
  Object.assign(line, { status: 'waiting', error: '', autoRetry: false, fr: '' });
  render(line);
  inFlight++;
  updateStatus();
  const vi = line.vi;
  const t0 = performance.now();
  let first = 0;
  try {
    const raw = await gemini({
      system: TRANSLATE_PROMPT,
      text: translateUserText(recentContext(line), vi),
      maxTokens: 512,
      onText: (text) => {
        if (!first) first = performance.now();
        if (line.dead || line.vi !== vi) return;
        line.fr = cleanFrench(text);
        line.status = 'streaming';
        render(line);
      }
    });
    tech.ttfb = first ? first - t0 : null;
    tech.total = performance.now() - t0;
    if (!line.dead && line.vi === vi && !line.again) {
      const fr = cleanFrench(raw);
      if (fr === '-' || isNoiseOnly(fr)) removeLine(line);
      else { Object.assign(line, { fr, status: 'done' }); render(line); }
    }
    retryFailed();
  } catch (err) {
    if (!line.dead) {
      Object.assign(line, { status: 'failed', error: errorMessage(err), autoRetry: isTransient(err) || isKeyError(err) });
      render(line);
    }
    if (isKeyError(err)) showBanner(errorMessage(err));
  } finally {
    line.translating = false;
    inFlight--;
    updateStatus();
    if (line.again && !line.dead) translateText(line);
  }
}

// ─── Micro ───────────────────────────────────────────────────────────────────
const WORKLET_SOURCE = [
  Resampler.toString(),
  Segmenter.toString(),
  Agc.toString(),
  `class TDCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.rs = new Resampler(sampleRate, 16000);
    this.seg = new Segmenter(o.tuning);
    this.agc = new Agc();
    this.count = 0;
    this.every = Math.round(sampleRate * 0.05);
    this.stream = !!o.stream;
    this.pcm = new Int16Array(1600);
    this.fill = 0;
    this.pos = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'stream') { this.stream = !!m.on; return; }
      if (m.type === 'flush' || m.type === 'tune') {
        const s = this.seg.flush();
        if (s) this.port.postMessage({ type: 'segment', samples: s }, [s.buffer]);
        if (m.type === 'tune') this.seg = new Segmenter(m.tuning);
        else this.port.postMessage({ type: 'flushed', id: m.id });
      }
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const down = this.rs.process(input[0]);
      // Le découpage mesure le son brut ; le gain automatique ne touche que le flux envoyé.
      const segs = this.seg.push(down);
      if (this.stream) {
        this.agc.process(down);
        for (let i = 0; i < down.length; i++) {
          const v = down[i] > 1 ? 1 : down[i] < -1 ? -1 : down[i];
          this.pcm[this.fill++] = v < 0 ? v * 32768 : v * 32767;
          if (this.fill === 1600) {
            this.port.postMessage({ type: 'pcm', data: this.pcm, end: this.pos + i + 1 }, [this.pcm.buffer]);
            this.pcm = new Int16Array(1600);
            this.fill = 0;
          }
        }
      }
      this.pos += down.length;
      if (!this.stream) for (const s of segs) this.port.postMessage({ type: 'segment', samples: s }, [s.buffer]);
      this.count += input[0].length;
      if (this.count >= this.every) {
        this.port.postMessage({ type: 'level', v: this.seg.peak, gain: this.stream ? this.agc.gainDb : null });
        this.seg.peak = 0;
        this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor('td-capture', TDCapture);`
].join('\n');

// Découpage : attendre la fin de la phrase donne à Gemini plus de contexte (moins d'erreurs) ;
// le mode rapide coupe plus tôt, au prix de phrases parfois tronquées.
const CUTS = [
  { id: 'complete', title: 'Phrases complètes', sub: 'Attend 0,7\u00a0s de silence, extraits jusqu\'à 8\u00a0s : plus juste, la traduction arrive un peu plus tard (recommandé)', tuning: { endSilence: 0.7, maxSegment: 8, cutSearchWindow: 2 } },
  { id: 'fast', title: 'Rapide', sub: 'Coupe dès 0,45\u00a0s de silence, extraits jusqu\'à 5\u00a0s : plus réactif, mais phrases parfois coupées', tuning: {} }
];
function currentTuning() {
  return (CUTS.find((c) => c.id === S.cut) || CUTS[0]).tuning;
}
/** Change le découpage pendant l'écoute : la phrase en cours part telle quelle. */
function applyTuning() {
  if (!listening) return;
  if (cap.node) cap.node.port.postMessage({ type: 'tune', tuning: currentTuning() });
  else if (cap.dsp) {
    const s = cap.dsp.flush();
    if (s) enqueue(s);
    cap.dsp = new Segmenter(currentTuning());
  }
}

const cap = { ctx: null, stream: null, src: null, node: null, sp: null, dsp: null, sink: null, url: '', lastAudio: 0, failures: 0 };
const flushWaiters = new Map();
let flushSeq = 0;
let recovering = false;
let hiddenAt = 0;
let heardWhileHidden = false;
let mutedSince = 0;

function onCapture(msg) {
  cap.lastAudio = performance.now();
  if (document.hidden) heardWhileHidden = true;
  if (msg.type === 'level') { setLevel(msg.v); tech.gain = msg.gain; }
  else if (msg.type === 'pcm') liveSend(msg);
  else if (msg.type === 'segment') { if (engine === 'clips') enqueue(msg.samples); }
  else if (msg.type === 'flushed') {
    const done = flushWaiters.get(msg.id);
    flushWaiters.delete(msg.id);
    if (done) done();
  }
}

const getMic = (audio) => navigator.mediaDevices.getUserMedia({ audio, video: false });

async function openStream() {
  const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  let stream = null;
  if (S.micId) {
    try { stream = await getMic(Object.assign({}, base, { deviceId: { exact: S.micId } })); } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
    }
  }
  if (!stream) stream = await getMic(base);
  // Les identifiants de micro changent d'une session à l'autre : on retrouve le choix par son nom.
  const track = stream.getAudioTracks()[0];
  if (S.micLabel && track && track.label !== S.micLabel) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const wanted = devices.find((d) => d.kind === 'audioinput' && d.label === S.micLabel);
      if (wanted) {
        const again = await getMic(Object.assign({}, base, { deviceId: { exact: wanted.deviceId } }));
        stream.getTracks().forEach((t) => t.stop());
        stream = again;
        save('micId', wanted.deviceId);
      }
    } catch (e) { /* on garde le micro par défaut */ }
  }
  return stream;
}

async function buildGraph(ctx) {
  cap.sink = ctx.createGain();
  cap.sink.gain.value = 0;
  cap.sink.connect(ctx.destination);
  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined' && !FORCE_SCRIPT_PROCESSOR) {
    try {
      if (!cap.url) cap.url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(cap.url);
      const node = new AudioWorkletNode(ctx, 'td-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        processorOptions: { tuning: currentTuning(), stream: engine === 'live' }
      });
      node.port.onmessage = (e) => onCapture(e.data);
      node.connect(cap.sink);
      cap.node = node;
      tech.mode = 'AudioWorklet';
    } catch (e) {
      cap.node = null;
    }
  }
  if (!cap.node) {
    // Secours : même traitement, sur le thread principal.
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    const rs = new Resampler(ctx.sampleRate, 16000);
    const agc = new Agc();
    cap.dsp = new Segmenter(currentTuning());
    let pcm = new Int16Array(1600), fill = 0, pos = 0;
    sp.onaudioprocess = (e) => {
      const seg = cap.dsp;
      if (!seg) return;
      const down = rs.process(e.inputBuffer.getChannelData(0));
      const segs = seg.push(down);
      const streaming = engine === 'live';
      if (streaming) {
        agc.process(down);
        for (let i = 0; i < down.length; i++) {
          const v = Math.max(-1, Math.min(1, down[i]));
          pcm[fill++] = v < 0 ? v * 32768 : v * 32767;
          if (fill === 1600) { onCapture({ type: 'pcm', data: pcm, end: pos + i + 1 }); pcm = new Int16Array(1600); fill = 0; }
        }
      }
      pos += down.length;
      for (const s of segs) onCapture({ type: 'segment', samples: s });
      onCapture({ type: 'level', v: seg.peak, gain: streaming ? agc.gainDb : null });
      seg.peak = 0;
    };
    sp.connect(cap.sink);
    cap.sp = sp;
    tech.mode = 'ScriptProcessor';
  }
  tech.rate = ctx.sampleRate;
}

function attachStream(stream) {
  cap.stream = stream;
  cap.src = cap.ctx.createMediaStreamSource(stream);
  cap.src.connect(cap.node || cap.sp);
  const track = stream.getAudioTracks()[0];
  micName = shortMicName(track && track.label);
  mutedSince = track && track.muted ? performance.now() : 0;
  micBusy = false;
  if (track) {
    track.onended = () => { if (listening) recover(); };
    track.onmute = () => { mutedSince = performance.now(); };
    track.onunmute = () => { mutedSince = 0; micBusy = false; updateStatus(); };
  }
}

function shortMicName(label) {
  if (!label) return 'Micro';
  const clean = label.replace(/^(Default|Par défaut)\s*-\s*/i, '').replace(/\s*\([^)]*\)\s*$/, '');
  return clean.length > 30 ? clean.slice(0, 29) + '…' : clean;
}

function micError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return "Le micro est bloqué pour ce site. Autorisez-le (Safari : menu de la page › Réglages du site web › Micro, ou Réglages iOS › Apps › Safari › Micro), puis réessayez.";
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Aucun micro trouvé.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Le micro est utilisé par une autre app (appel en cours ?). Réessayez.';
  return 'Impossible de démarrer le micro : ' + ((e && (e.message || e.name)) || 'erreur inconnue');
}

function flushCapture() {
  return new Promise((resolve) => {
    if (cap.node) {
      const id = ++flushSeq;
      flushWaiters.set(id, resolve);
      cap.node.port.postMessage({ type: 'flush', id });
      setTimeout(() => { if (flushWaiters.delete(id)) resolve(); }, 400);
    } else {
      if (cap.dsp) {
        const s = cap.dsp.flush();
        if (s) enqueue(s);
      }
      resolve();
    }
  });
}

async function startListening() {
  if (listening || starting) return;
  if (!S.apiKey) { openSettings(true); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showBanner(window.isSecureContext ? "Ce navigateur ne donne pas accès au micro." : "Le micro n'est accessible que sur une page sécurisée (https).");
    return;
  }
  starting = true;
  engine = S.engine === 'clips' ? 'clips' : 'live';
  updateStatus();
  lockScreen();   // demandé pendant le toucher : Safari l'accorde plus volontiers
  // L'AudioContext doit naître pendant le toucher (règle de Safari), avant toute attente.
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
  cap.ctx = ctx;
  const resumed = ctx.resume().catch(() => {});
  try {
    const stream = await openStream();
    await resumed;
    await buildGraph(ctx);
    attachStream(stream);
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    ctx.onstatechange = () => { if (listening && !document.hidden && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {}); };
    listening = true;
    cap.lastAudio = performance.now();
    cap.failures = 0;
    hideBanner();
    lockScreen();
    if (engine === 'live') liveStart();
    warmUp();
    voiceStart();
  } catch (e) {
    try { ctx.close(); } catch (x) { /* déjà fermé */ }
    Object.assign(cap, { ctx: null, node: null, sp: null, dsp: null, sink: null, src: null, stream: null });
    unlockScreen();
    showBanner(micError(e));
  } finally {
    starting = false;
    updateStatus();
  }
}

async function stopListening() {
  if (!listening) return;
  listening = false;
  micBusy = false;
  setLevel(0);
  updateStatus();
  unlockScreen();
  if (engine === 'live') await liveStop();
  else await flushCapture().catch(() => {});
  try { if (cap.src) cap.src.disconnect(); } catch (e) { /* déjà déconnecté */ }
  if (cap.stream) cap.stream.getTracks().forEach((t) => t.stop());
  try { if (cap.node) cap.node.port.onmessage = null; } catch (e) { /* rien */ }
  try { if (cap.ctx) await cap.ctx.close(); } catch (e) { /* déjà fermé */ }
  Object.assign(cap, { ctx: null, node: null, sp: null, dsp: null, sink: null, src: null, stream: null });
  updateStatus();
}

/** Le micro s'est arrêté (iOS, autre app, changement de micro) : on le rouvre. */
async function recover() {
  if (recovering || !listening || !cap.ctx) return;
  recovering = true;
  try {
    try { if (cap.src) cap.src.disconnect(); } catch (e) { /* rien */ }
    if (cap.stream) cap.stream.getTracks().forEach((t) => t.stop());
    const stream = await openStream();
    if (!listening || !cap.ctx) { stream.getTracks().forEach((t) => t.stop()); return; }
    attachStream(stream);
    if (cap.ctx.state !== 'running') await cap.ctx.resume().catch(() => {});
    cap.lastAudio = performance.now();
    cap.failures = 0;
    updateStatus();
  } catch (e) {
    cap.failures++;
    if (cap.failures >= 3 || (e && e.name === 'NotAllowedError')) {
      await stopListening();
      showBanner(micError(e));
    }
  } finally {
    recovering = false;
  }
}

// Surveillance : relance le micro s'il ne livre plus rien (interruption iOS, appel, Siri…).
setInterval(() => {
  if (!listening || document.hidden || recovering || !cap.ctx) return;
  if (cap.ctx.state !== 'running') {
    cap.ctx.resume().catch(() => {});
    if (performance.now() - cap.lastAudio > 4000) showBanner("L'écoute est en pause : touchez l'écran pour la reprendre.");
    return;
  }
  const track = cap.stream && cap.stream.getAudioTracks()[0];
  if (track && track.muted && mutedSince) {
    if (!micBusy) { micBusy = true; updateStatus(); }
    if (performance.now() - mutedSince > 4000) { mutedSince = performance.now(); recover(); }
    return;
  }
  if (!track || track.readyState === 'ended' || performance.now() - cap.lastAudio > 3000) recover();
}, 1000);

// Un toucher n'importe où relance l'audio si Safari l'a suspendu.
document.addEventListener('pointerdown', () => {
  if (listening && !wakeLock) lockScreen();
  if (listening && cap.ctx && cap.ctx.state !== 'running') {
    cap.ctx.resume().then(() => { if (cap.ctx && cap.ctx.state === 'running') hideBanner(); }).catch(() => {});
  }
}, true);

document.addEventListener('visibilitychange', () => {
  if (!listening) return;
  if (document.hidden) {
    hiddenAt = Date.now();
    heardWhileHidden = false;
    flushCapture();
    return;
  }
  lockScreen();
  if (cap.ctx && cap.ctx.state !== 'running') cap.ctx.resume().catch(() => {});
  cap.lastAudio = performance.now();
  if (engine === 'live') liveEnsure();
  if (hiddenAt) {
    const gap = (Date.now() - hiddenAt) / 1000;
    hiddenAt = 0;
    // Sur iPhone le micro s'arrête quand la page passe en arrière-plan ; ailleurs il continue.
    if (gap >= 2 && !heardWhileHidden) addNote('Écoute coupée pendant ' + formatGap(gap) + ' (écran verrouillé ou autre app)');
    warmUp();
  }
});

function formatGap(sec) {
  if (sec < 60) return Math.round(sec) + '\u00a0s';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m + '\u00a0min' + (s ? ' ' + s + '\u00a0s' : '');
}

/** Typographie française : espace insécable avant ? ! : ; » et après «, pour qu'aucun signe ne reste seul en début de ligne. */
function frenchSpacing(text) {
  return text.replace(/ ([?!:;»])/g, '\u00a0$1').replace(/« /g, '«\u00a0');
}

// Écran toujours allumé pendant l'écoute (Safari arrête le micro quand l'écran se verrouille).
let wakeLock = null;
async function lockScreen() {
  if (!('wakeLock' in navigator) || wakeLock || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { wakeLock = null; }
}
function unlockScreen() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* déjà libéré */ }
  wakeLock = null;
}

micBtn.addEventListener('click', () => {
  if (listening) stopListening();
  else startListening();
});

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !sheet.hidden || e.target.closest('input, select, textarea, button, a')) return;
  e.preventDefault();
  micBtn.click();
});

// ─── Réglages ────────────────────────────────────────────────────────────────
const keyInput = $('keyInput');
const keyStatus = $('keyStatus');

function openSettings(welcome) {
  $('welcome').hidden = !welcome;
  keyInput.value = S.apiKey;
  setKeyStatus('', '');
  renderModels();
  renderEngines();
  renderCuts();
  $('priorityToggle').checked = S.priority;
  $('viToggle').checked = S.showVi;
  $('voicesToggle').checked = S.voices;
  fillMics();
  renderTech();
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
  if (welcome) setTimeout(() => keyInput.focus(), 60);
}

function closeSettings() {
  const key = keyInput.value.trim();
  if (key && key !== S.apiKey) saveKey(key, false);
  sheet.hidden = true;
  document.body.classList.remove('sheet-open');
}

$('settingsBtn').addEventListener('click', () => openSettings(false));
$('sheetDone').addEventListener('click', closeSettings);
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSettings(); });

function setKeyStatus(text, kind) {
  keyStatus.textContent = text;
  keyStatus.className = 'key-status' + (kind ? ' ' + kind : '');
}

function resetConfigs() {
  cfgIndex = 0;
  tech.note = '';
  for (const c of CONFIGS) { c.proven = false; c.audioProven = false; }
}

async function saveKey(key, showResult) {
  save('apiKey', key);
  resetConfigs();
  if (showResult) setKeyStatus('Vérification…', 'busy');
  const r = await probe();
  tech.probe = r;
  if (r.ok) {
    if (showResult) setKeyStatus('✓ Clé valide · Gemini répond en ' + seconds(r.ms), 'ok');
    hideBanner();
    retryFailed();
  } else {
    const msg = isKeyError(r.err) ? "Clé refusée par Google. Vérifiez qu'elle a été copiée en entier." : errorMessage(r.err);
    if (showResult) setKeyStatus(msg, 'bad');
    else showBanner(msg);
  }
  if (!sheet.hidden) renderTech();
}

$('checkBtn').addEventListener('click', () => {
  const key = keyInput.value.trim();
  if (!key) { setKeyStatus('Collez d\'abord la clé.', 'bad'); keyInput.focus(); return; }
  saveKey(key, true);
});

$('pasteBtn').addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) {
      keyInput.value = text;
      setKeyStatus('', '');
    }
  } catch (e) {
    keyInput.focus();
    setKeyStatus('Appuyez longuement dans le champ puis « Coller ».', '');
  }
});

const ENGINES = [
  { id: 'live', title: 'Continue', sub: "Gemini 3.5 Transcribe écoute sans interruption et écrit le vietnamien au fil de la parole ; chaque phrase est ensuite traduite. Le plus juste (recommandé)." },
  { id: 'clips', title: 'Par extraits', sub: "L'ancien mode : chaque phrase est envoyée en audio à Gemini, qui transcrit et traduit d'un coup." }
];
function renderEngines() {
  const box = $('engineChoices');
  box.textContent = '';
  for (const en of ENGINES) {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'engine';
    input.value = en.id;
    input.id = 'engine-' + en.id;
    input.checked = en.id === (S.engine === 'clips' ? 'clips' : 'live');
    input.addEventListener('change', () => {
      save('engine', en.id);
      $('cutGroup').hidden = en.id !== 'clips';
      $('engineNote').hidden = !listening;
    });
    const text = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = en.title;
    const sub = document.createElement('small');
    sub.textContent = en.sub;
    text.append(title, sub);
    label.append(input, text);
    box.appendChild(label);
  }
  $('cutGroup').hidden = S.engine !== 'clips';
  $('engineNote').hidden = true;
}

function renderCuts() {
  const box = $('cutChoices');
  box.textContent = '';
  for (const c of CUTS) {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'cut';
    input.value = c.id;
    input.id = 'cut-' + c.id;
    input.checked = c.id === (CUTS.find((x) => x.id === S.cut) || CUTS[0]).id;
    input.addEventListener('change', () => {
      save('cut', c.id);
      applyTuning();
    });
    const text = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = c.title;
    const sub = document.createElement('small');
    sub.textContent = c.sub;
    text.append(title, sub);
    label.append(input, text);
    box.appendChild(label);
  }
}

function renderModels() {
  const box = $('modelChoices');
  box.textContent = '';
  for (const m of MODELS) {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'model';
    input.value = m.id;
    input.id = 'model-' + m.id;
    input.checked = m.id === S.model;
    input.addEventListener('change', () => {
      save('model', m.id);
      resetConfigs();
      if (S.apiKey) warmUp();
    });
    const text = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = m.title;
    const sub = document.createElement('small');
    sub.textContent = m.sub;
    text.append(title, sub);
    label.append(input, text);
    box.appendChild(label);
  }
}

$('priorityToggle').addEventListener('change', (e) => save('priority', e.target.checked));
$('voicesToggle').addEventListener('change', (e) => {
  save('voices', e.target.checked);
  if (e.target.checked) { if (listening) voiceStart(); } else voiceStop();
  lines.forEach(render);
  renderTech();
});
$('viToggle').addEventListener('change', (e) => {
  save('showVi', e.target.checked);
  lines.forEach(render);
});

async function fillMics() {
  const select = $('micSelect');
  select.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'Micro par défaut';
  select.appendChild(def);
  let devices = [];
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default'); } catch (e) { devices = []; }
  let unnamed = 0;
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || 'Micro ' + (i + 1);
    if (!d.label) unnamed++;
    o.dataset.label = d.label;
    select.appendChild(o);
  });
  const match = devices.find((d) => (S.micLabel && d.label === S.micLabel) || d.deviceId === S.micId);
  select.value = match ? match.deviceId : '';
  $('micNames').hidden = !(unnamed && !listening);
}

$('micSelect').addEventListener('change', (e) => {
  const option = e.target.selectedOptions[0];
  save('micId', e.target.value);
  save('micLabel', e.target.value ? (option.dataset.label || '') : '');
  if (listening) recover();
});

function seconds(ms) {
  return (ms / 1000).toFixed(1).replace('.', ',') + '\u00a0s';
}

function liveStatusText() {
  if (engine === 'live' && live.on) {
    if (live.state === 'connected') return 'continue · Gemini 3.5 Transcribe connecté';
    if (live.state === 'reconnecting') return 'continue · reconnexion (' + live.error + ')';
    return 'continue · connexion…';
  }
  if (live.state === 'error') return 'par extraits (continue indisponible : ' + live.error + ')';
  return S.engine === 'clips' ? 'par extraits' : 'continue (au démarrage de l\'écoute)';
}

function voiceStatus() {
  if (!S.voices) return 'désactivées';
  if (voice.state === 'off') return 'au démarrage de l\'écoute';
  if (voice.state === 'loading') return 'chargement du modèle…';
  if (voice.state === 'error') return 'indisponibles : ' + voice.error;
  const n = voice.clusters.list.length;
  return (n ? n + ' voix reconnue' + (n > 1 ? 's' : '') : 'prêtes') + ' · modèle ' + (voice.size / 1e6).toFixed(1).replace('.', ',') + '\u00a0Mo' + (voice.ms ? ' · ' + Math.round(voice.ms) + '\u00a0ms par phrase' : '');
}

function renderTech() {
  const rows = [
    ['Écoute', liveStatusText()],
    ['Connexion', CONFIGS[cfgIndex].label + (S.priority && CONFIGS[cfgIndex].tier ? ' · prioritaire' : '')],
    ['Audio', tech.mode ? tech.mode + ' · ' + tech.rate + ' Hz → 16 kHz' : 'pas encore démarré'],
    ['Gain du micro', typeof tech.gain === 'number' ? (tech.gain >= 0 ? '+' : '−') + Math.abs(Math.round(tech.gain)) + ' dB, automatique' : 'automatique (×16 au plus par phrase)'],
    ['Dernière phrase', tech.total ? (tech.ttfb ? 'premiers mots ' + seconds(tech.ttfb) + ' · ' : '') + 'complète ' + seconds(tech.total) : '—'],
    ['Écran allumé', 'wakeLock' in navigator ? (wakeLock ? 'actif' : 'pendant l\'écoute') : 'non pris en charge'],
    ['Voix', voiceStatus()]
  ];
  if (tech.probe && !tech.probe.ok) rows.push(['Dernier test', errorMessage(tech.probe.err)]);
  if (tech.note) rows.push(['Note', tech.note]);
  const dl = $('techInfo');
  dl.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

// ─── Démarrage ───────────────────────────────────────────────────────────────
updateStatus();
if (!S.apiKey) openSettings(true);
