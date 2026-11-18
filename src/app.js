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

// Découpage des phrases (réglettes). L'ancien choix « Rapide » donne ses valeurs de départ.
const CUT_DEFAULTS = { pause: 1.0, maxLen: 6 };
const wasFast = store.get('cut', 'complete') === 'fast';
const S = {
  apiKey: store.get('apiKey', ''),
  model: store.get('model', DEFAULT_MODEL),
  priority: store.get('priority', true),
  showVi: store.get('showVi', true),
  pause: store.get('pause', wasFast ? 0.6 : CUT_DEFAULTS.pause),
  maxLen: store.get('maxLen', wasFast ? 4 : CUT_DEFAULTS.maxLen),
  listen: store.get('listen', 'phrases'),
  micId: store.get('micId', ''),
  micLabel: store.get('micLabel', ''),
  voices: store.get('voices', true)
};
if (!MODELS.some((m) => m.id === S.model)) S.model = DEFAULT_MODEL;
const clampNum = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
S.pause = Math.round(clampNum(S.pause, 0.3, 2, CUT_DEFAULTS.pause) * 10) / 10;
S.maxLen = Math.round(clampNum(S.maxLen, 3, 15, CUT_DEFAULTS.maxLen));
function save(key, value) { S[key] = value; store.set(key, value); }

function userText(all) {
  const context = all.filter((c) => c.fr);
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
const tech = { note: '', mode: '', rate: 0, gain: null, asr: null, ttfb: null, total: null, probe: null };

class GemError extends Error {
  constructor(kind, message, status) {
    super(message || kind);
    this.kind = kind;       // http | stream | empty | network | timeout
    this.status = status || 0;
    this.quota = null;      // limite atteinte (429) : voir quotaInfo
  }
}

/** Erreur HTTP de Gemini, avec le détail de la limite atteinte s'il s'agit d'un 429. */
function httpError(raw, status) {
  const err = new GemError('http', errorText(raw), status);
  if (status === 429) err.quota = quotaInfo(raw);
  return err;
}

/**
 * Limite atteinte (429) : par minute ou par jour, sa valeur, le délai conseillé avant de
 * réessayer, et s'il s'agit de l'offre gratuite (facturation non activée).
 */
function quotaInfo(raw) {
  const q = { perDay: false, perMinute: false, free: false, limit: 0, retryMs: 0 };
  let e = null;
  try { const j = JSON.parse(raw); e = (Array.isArray(j) ? j[0] : j).error || null; } catch (x) { /* pas du JSON */ }
  const msg = String((e && e.message) || raw || '');
  const ids = [msg];
  for (const d of (e && Array.isArray(e.details) ? e.details : [])) {
    for (const v of (d && Array.isArray(d.violations) ? d.violations : [])) {
      ids.push(String(v.quotaId || '') + ' ' + String(v.quotaMetric || ''));
      if (!q.limit && Number(v.quotaValue)) q.limit = Number(v.quotaValue);
    }
    if (d && typeof d.retryDelay === 'string' && !q.retryMs) q.retryMs = Math.round(parseFloat(d.retryDelay) * 1000) || 0;
  }
  const all = ids.join(' ');
  q.perDay = /per.?day/i.test(all);
  q.perMinute = /per.?minute/i.test(all);
  q.free = /free.?tier/i.test(all);
  const lim = msg.match(/limit:\s*(\d+)/i);
  if (lim && !q.limit) q.limit = Number(lim[1]);
  const wait = msg.match(/retry in\s*([\d.]+)\s*s/i);
  if (wait && !q.retryMs) q.retryMs = Math.round(parseFloat(wait[1]) * 1000);
  return q;
}

/** Prochaine remise à zéro des limites par jour : minuit, heure de Californie. */
function quotaReset(t) {
  const day = 86400000;
  const base = Math.floor(t / day) * day;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' });
    for (let k = 0; k < 3; k++) {
      for (const h of [7, 8]) {
        const c = base + k * day + h * 3600000;
        if (c > t && Number(fmt.format(new Date(c))) === 0) return c;
      }
    }
  } catch (x) { /* fuseau inconnu : 8 h UTC */ }
  return base + 8 * 3600000 > t ? base + 8 * 3600000 : base + day + 8 * 3600000;
}

function clockTime(t) {
  return new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
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
      throw httpError(raw, res.status);
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
      if (err.status === 429) {
        // La facturation n'est en cause que pour l'offre gratuite ; sinon, c'est la limite du modèle.
        const q = err.quota || {};
        if (q.free) return "Quota gratuit de Gemini atteint : activez la facturation sur le projet de la clé (Google AI Studio).";
        if (q.perDay) return 'Limite par jour de ce modèle Gemini atteinte' + (q.limit ? ' (' + q.limit + ' requêtes)' : '') + ' : remise à zéro à ' + clockTime(quotaReset(Date.now())) + '.';
        return 'Trop de requêtes par minute pour ce modèle Gemini' + (q.limit ? ' (limite : ' + q.limit + ')' : '') + '. Nouvel essai automatique.';
      }
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
  track.list = [];   // empreintes liées aux voix effacées
  if (live.win) live.win.line = null;
  for (const w of live.wins) w.line = null;
  liveHideInterim();
  linesEl.textContent = '';
  follow = true;
  livePill.hidden = true;
  updateStatus();
}

// ─── Traduction ──────────────────────────────────────────────────────────────
function recentContext(line) {
  const index = lines.indexOf(line);
  const cutoff = line.createdAt - 180000;
  const out = [];
  for (let k = index - 1; k >= 0 && out.length < 6; k--) {
    const prev = lines[k];
    if (prev.createdAt < cutoff) break;
    if (prev.dead || !prev.vi || isBlank(prev.vi)) continue;
    out.unshift({ vi: prev.vi, fr: prev.status === 'done' ? prev.fr : '', who: speakerTag(prev) });
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
    if (line.log) Object.assign(line.log, { flash: tech.total, flashWords: line.dead ? 0 : wordCount(line.vi), error: '' });
    if (line.rescue) phraseRescued(line);
    retryFailed();
  } catch (err) {
    if (line.log) line.log.error = 'Flash\u00a0: ' + (err.status ? 'erreur ' + err.status : errorMessage(err));
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
  else if (line.kind === 'phrase' && line.vi) translateText(line);
  else if (line.kind === 'phrase' && engine !== 'clips' && canTranscribe()) transcribePhrase(line);
  else { line.kind = 'clip'; translate(line); }
}

/** Le réseau est revenu : on relance les phrases perdues pendant la coupure. */
function retryFailed() {
  for (const line of lines) {
    if (line.status === 'failed' && line.autoRetry && (line.kind === 'live' || line.kind === 'phrase' || line.audio)) retryLine(line);
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
  if (m.type === 'embed1') {
    let e = null;
    const t0 = performance.now();
    try {
      const { session } = await ready;
      const w = fb.windows(m.samples);
      if (w.n) {
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', w.data.subarray(0, w.frames * 80), [1, w.frames, 80]) });
        e = out[session.outputNames[0]].data.slice();
      }
    } catch (err) { /* modèle indisponible */ }
    postMessage({ type: 'embedding1', id: m.id, e, ms: performance.now() - t0 });
    return;
  }
  if (m.type === 'embed') {
    const list = [], spans = [];
    const t0 = performance.now();
    try {
      const { session } = await ready;
      const part = voicedPart(m.samples);
      const off = (part.byteOffset - m.samples.byteOffset) / 4;
      const w = fb.windows(part);
      if (w.n) {
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', w.data, [w.n, w.frames, 80]) });
        const all = out[session.outputNames[0]].data, d = all.length / w.n;
        for (let i = 0; i < w.n; i++) {
          list.push(all.slice(i * d, (i + 1) * d));
          spans.push([off + Math.round(w.spans[i][0] * 16000), off + Math.round(w.spans[i][1] * 16000)]);
        }
      }
    } catch (err) { /* modèle indisponible : la phrase reste sans couleur */ }
    postMessage({ type: 'embeddings', id: m.id, list, spans, ms: performance.now() - t0 });
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

/** Voix de chaque fenêtre ; les voix devenues trop proches sont fusionnées partout. */
function voiceAssign(list) {
  const ids = voice.clusters.assign(list);
  const merged = voice.clusters.mergeClose();
  if (Object.keys(merged).length) {
    const remap = (id) => (id !== null && merged[id] ? merged[id] : id);
    for (const other of lines) {
      if (!other.voiceIds) continue;
      other.voiceIds = other.voiceIds.map(remap);
      render(other);
    }
    for (const t of track.list) t.id = remap(t.id);
    return ids.map(remap);
  }
  return ids;
}

function voiceMessage(m) {
  if (m.type === 'ready') {
    voice.state = 'ready';
    voice.size = m.size;
  } else if (m.type === 'error') {
    voice.state = 'error';
    voice.error = m.message;
  } else if (m.type === 'embedding1') {
    const target = voice.waiting.get(m.id);
    voice.waiting.delete(m.id);
    if (m.e && typeof m.ms === 'number') track.ms = track.ms ? 0.8 * track.ms + 0.2 * m.ms : m.ms;
    if (target && target.track !== undefined) trackResult(target.track, m.e);
    return;
  } else if (m.type === 'embeddings') {
    voice.ms = m.ms;
    const line = voice.waiting.get(m.id);
    voice.waiting.delete(m.id);
    if (!line || line.dead || !m.list.length) return;
    line.voiceIds = voiceAssign(m.list);
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
// Le micro part en continu (PCM 16 kHz) vers un modèle fait pour la transcription. C'est l'app
// qui découpe la parole en phrases (fenêtres closes sur une vraie pause, voir Turns) et qui le
// dit au serveur (activité manuelle) : la détection de parole de Google, faite pour quelqu'un
// qui parle à son téléphone, ignorait les voix éloignées et coupait à la moindre hésitation.
// Chaque fenêtre donne une ligne, traduite en texte seul dès que sa transcription est arrivée.
// Une session dure au plus 10 minutes : la suivante s'ouvre avant et prend le relais entre deux
// phrases. Si le serveur refuse ces options, on revient à sa détection, puis au mode par extraits.
const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const LIVE_MODEL = 'models/gemini-3.5-transcribe-live';
const LIVE_ROTATE_MS = 9 * 60 * 1000;
const RATE = 16000;
// Du plus complet au plus simple : on descend d'un cran si le serveur refuse la configuration.
const LIVE_LEVELS = [
  { manual: true, vocab: true },
  { manual: true, vocab: false },
  { manual: false, vocab: false }
];
// Mots du Centre et du Sud à bien reconnaître (la documentation conseille 100 termes au plus).
const LIVE_VOCAB = [
  'Léa', 'Lia', 'mô', 'tê', 'răng', 'rứa', 'chừ', 'mần', 'nỏ', 'ưng', 'mạ', 'mệ', 'nác', 'trốc', 'chộ', 'tau', 'hắn', 'bọ', 'ôn',
  'đi mô', 'ở mô', 'mần chi', 'nói chi', 'làm chi', 'cái chi', 'chi rứa', 'răng rứa', 'rứa hả', 'rứa thì',
  'bữa ni', 'chỗ ni', 'cái ni', 'cái nớ', 'bên tê', 'bây chừ', 'mi nói', 'mi đi',
  'hông', 'hổng', 'dzậy', 'dzô', 'dìa', 'bển', 'ổng', 'bả', 'mắc quá', 'xị', 'củ'
];

const TRANSLATE_PROMPT = `Tu es traducteur vietnamien → français. On te donne la transcription automatique de ce qui vient d'être dit autour d'une personne qui ne parle pas vietnamien : accent du Sud (Saigon), du Centre ou du Nord, souvent une conversation à plusieurs, avec du bruit. La transcription peut contenir des erreurs.

C'est une conversation orale : des personnes présentes qui se parlent entre elles, de vive voix (récit, discussion, dispute), pas un texte écrit. Chaque phrase répond souvent à la précédente ou s'adresse à quelqu'un de présent : suis le fil de la conversation donné en contexte.

Ta seule tâche : traduire la phrase en français, fidèlement. Tu ne juges pas, tu n'interprètes ni les intentions ni les émotions, tu ne commentes pas.

- Même sens, même niveau de langue, ni plus ni moins. Français parlé, courant et naturel, comme on le dirait à l'oral, sans mot à mot ni tournure écrite.
- Léa : prénom d'une personne présente (une Française), prononcé « Lia ». Dans la transcription, Lia, Li-a, Lê A, Lea, Léa, ou lia, lìa, lía employés comme un nom ou pour appeler quelqu'un (« Lia ơi », « con Lia », « chị Lia », « bé Lia ») désignent Léa : écris « Léa », ne le traduis pas comme un mot vietnamien.
- N'ajoute ni émotion, ni intensité, ni exclamation, ni juron absents du texte.
- Mot sans doute mal transcrit : prends le sens le plus vraisemblable d'après la phrase et le contexte, suivi de (?). Passage qui n'a aucun sens : traduis ce qui est sûr et mets […] pour le reste. N'invente rien.
- Phrases de plusieurs personnes mêlées : traduis séparément chaque morceau compréhensible, séparés par « / », sans les fondre en une seule phrase.
- Phrase incomplète : traduis le fragment tel quel, sans le compléter.
- Particules finales (nè, nha, hen, mà, hả, ơi, hỉ, tề, nghe…) : marques ordinaires de l'oral, sans agacement ni agressivité. Tao/mày (tau/mi au Centre) : « je » et « tu » familiers, sans hostilité. Anh, chị, em, cô, chú, bác, ông, bà : tu ou vous selon la relation ; ổng, bả, ảnh, chỉ, nó, hắn : il ou elle.
- Insulte ou menace dite avec des mots explicites : traduis-la telle quelle, sans l'adoucir ni l'amplifier.
- Chiffres, sommes, heures, lieux, noms : exacts. À l'oral, les milliers sont souvent sous-entendus (« hai trăm » = 200 000 đ, « năm chục » = 50 000 đ) ; argot : « xị » ou « lít » = 100 000 đ, « củ » = 1 000 000 đ.
- Sud : hông, hổng = không ; dzậy = vậy ; dzô = vào ; dìa = về ; nè = này ; hồi sáng = sáng nay ; hồi nãy = lúc nãy ; mắc = đắt ; xài = dùng ; kêu = gọi ; tụi = bọn ; bển = bên đó ; « cái quần (què) » = rejet moqueur (« mon œil », « n'importe quoi »).
- Centre : mô = đâu, tê = kia, ni = này, nớ = đó, răng = sao, rứa = vậy, chi = gì, chừ = bây giờ, mần = làm, nỏ = không, ưng = thích, hắn = nó, mạ = mẹ, o = cô, mệ = bà, nác = nước, trốc = đầu, chộ = thấy.
- Le fil de la conversation sert à comprendre de quoi on parle et qui s'adresse à qui : ne le retraduis pas. Les lettres entre crochets ([A], [B]…) indiquent qui parle (repérage automatique, parfois faux) : ne les recopie pas.
- Passages en anglais ou en français : ne les traduis pas. Texte entièrement en anglais ou en français, ou sans parole réelle : réponds uniquement -

Réponds uniquement par la traduction française, sur une ligne, sans guillemets ni étiquette.`;

let engine = 'clips';
const live = {
  on: false, current: null, next: null, sessions: new Set(), queue: [],
  worked: false, retries: 0, state: 'off', error: '', note: '',
  level: 0, heard: false, misses: 0,
  win: null, wins: [], winSeq: 0, switchWithin: 20000,
  interimTimer: 0, rotateTimer: 0, switchTimer: 0, seq: 0
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

const wsOpen = (s) => !!(s && s.ws && s.ws.readyState === 1);
function wsSend(s, msg) {
  try { if (wsOpen(s)) s.ws.send(JSON.stringify(msg)); } catch (e) { /* fermée : la reconnexion suit */ }
}

function liveStart() {
  for (const old of live.sessions) { old.closing = true; try { old.ws.close(); } catch (e) { /* déjà fermée */ } }
  clearTimeout(live.switchTimer);
  Object.assign(live, {
    on: true, current: null, next: null, queue: [], worked: false, retries: 0,
    state: 'connecting', error: '', note: '', heard: false, misses: 0, wins: []
  });
  live.win = winOpen(0);
  live.sessions = new Set();
  liveOpen('current');
}

function liveOpen(role) {
  const level = LIVE_LEVELS[live.level];
  const session = { id: ++live.seq, ws: null, ready: false, base: null, closing: false, setupTimer: 0, manual: level.manual, activity: false };
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
    const transcription = { languageCodes: ['vi-VN', 'en-US'] };
    if (level.vocab) transcription.customVocabulary = LIVE_VOCAB;
    const setup = { model: LIVE_MODEL, generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: transcription };
    // L'app signale elle-même début et fin de chaque phrase : la détection de Google est coupée.
    if (level.manual) setup.realtimeInputConfig = { automaticActivityDetection: { disabled: true } };
    ws.send(JSON.stringify({ setup }));
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
      // Relève prête : elle prend la main à la prochaine fin de phrase (au plus tard après un délai).
      if (!live.current || !live.current.ready || !wsOpen(live.current)) { liveSwitch(); liveFlushQueue(); }
      else {
        clearTimeout(live.switchTimer);
        live.switchTimer = setTimeout(() => { liveSwitch(); liveFlushQueue(); }, live.switchWithin);
      }
    } else if (session === live.current) {
      liveBegin(session);
    }
    updateStatus();
    if (!sheet.hidden) renderTech();
    return;
  }
  if (msg.goAway) {
    if (session === live.current) liveRotate(durationSeconds(msg.goAway.timeLeft));
    return;
  }
  const c = msg.serverContent;
  if (!c) return;
  live.heard = true;   // le serveur répond : l'activité manuelle fonctionne
  if (c.interimInputTranscription && c.interimInputTranscription.text) liveInterim(c.interimInputTranscription.text);
  if (c.inputTranscription && c.inputTranscription.text) liveFinal(session, c.inputTranscription);
  if (c.turnComplete && session.manual) {
    // Activité manuelle : la phrase finie la plus ancienne a reçu toute sa transcription.
    const w = live.wins.find((x) => !x.sealed && x.line);
    if (w) winSeal(w);
  }
}

/** La session devient celle qui reçoit l'audio. */
function liveBegin(session) {
  if (session.manual && !session.activity) {
    wsSend(session, { realtimeInput: { activityStart: {} } });
    session.activity = true;
  }
  liveFlushQueue();
  clearTimeout(live.rotateTimer);
  live.rotateTimer = setTimeout(() => liveRotate(), LIVE_ROTATE_MS);
}

/** Morceau d'audio venu du micro (100 ms, ou moins juste avant une fin de phrase). */
function liveSend(chunk) {
  if (!live.on) return;
  live.queue.push(chunk);
  if (live.queue.length > 400) live.queue.shift();   // ~30 s au plus pendant une reconnexion
  liveFlushQueue();
}

/** Envoie l'audio et les fins de phrase en attente, dans l'ordre, à la session courante. */
function liveFlushQueue() {
  while (live.queue.length) {
    const s = live.current;
    if (!s || !s.ready || !wsOpen(s)) return;
    const item = live.queue.shift();
    if (item.cut) liveBoundary(s);
    else liveWrite(s, item);
  }
}

function liveWrite(session, chunk) {
  if (session.base === null) session.base = chunk.end - chunk.data.length;
  wsSend(session, {
    realtimeInput: { audio: { data: toBase64(new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)), mimeType: 'audio/pcm;rate=16000' } }
  });
}

/** Fin de phrase côté serveur : on clôt l'activité, puis on en ouvre une autre (ou la relève prend la main). */
function liveBoundary(s) {
  if (s.manual && s.activity) {
    wsSend(s, { realtimeInput: { activityEnd: {} } });
    s.activity = false;
  }
  if (live.next && live.next.ready && wsOpen(live.next)) liveSwitch();
  else if (s.manual) {
    wsSend(s, { realtimeInput: { activityStart: {} } });
    s.activity = true;
  }
}

/** Relève avant la limite de 10 minutes (ou à l'annonce du serveur). */
function liveRotate(timeLeft) {
  if (!live.on) return;
  live.switchWithin = timeLeft ? Math.max(300, (timeLeft - 1.5) * 1000) : 20000;
  if (live.next) {
    if (live.next.ready) { clearTimeout(live.switchTimer); live.switchTimer = setTimeout(() => { liveSwitch(); liveFlushQueue(); }, live.switchWithin); }
    return;
  }
  liveOpen('next');
}

function liveSwitch() {
  const next = live.next;
  if (!next || !next.ready) return;
  clearTimeout(live.switchTimer);
  const old = live.current;
  live.current = next;
  live.next = null;
  if (old) liveEnd(old);
  liveBegin(next);
}

/** Fin propre : le serveur finalise la phrase en cours, puis la session se ferme. */
function liveEnd(session) {
  if (session.closing) return;
  session.closing = true;
  if (session.manual) {
    if (session.activity) wsSend(session, { realtimeInput: { activityEnd: {} } });
    session.activity = false;
  } else {
    wsSend(session, { realtimeInput: { audioStreamEnd: true } });
  }
  setTimeout(() => { try { session.ws.close(1000, 'fin'); } catch (e) { /* fermée */ } }, 3000);
}

function liveClosed(session, e) {
  clearTimeout(session.setupTimer);
  live.sessions.delete(session);
  if (session.closing || !live.on) return;
  const reason = (e && e.reason) || ('fermeture ' + ((e && e.code) || '?'));
  if (session === live.next) {
    live.next = null;
    setTimeout(() => liveRotate(), 5000);
    return;
  }
  if (session !== live.current) return;
  live.current = null;
  if (!session.ready && !live.worked) {
    // Refusé dès l'ouverture : on retire d'abord les options (vocabulaire, activité manuelle),
    // puis on passe au mode par extraits si le modèle lui-même est indisponible.
    const config = /realtime|activity|vocabular|unknown name|cannot find field|unrecognized|invalid json/i.test(reason);
    const fatal = !config && /not found|not supported|permission|api.?key|unauthenticated|billing|quota|exhausted/i.test(reason);
    if (!fatal && live.level < LIVE_LEVELS.length - 1) {
      live.level++;
      live.note = 'option refusée par le serveur (' + reason + ')';
      liveOpen('current');
      return;
    }
    liveFallback(reason);
    return;
  }
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

/** Nouvelle session au niveau courant (après un changement de niveau). */
function liveReconnect() {
  for (const s of [live.current, live.next]) {
    if (!s) continue;
    s.closing = true;
    live.sessions.delete(s);
    try { s.ws.close(1000, 'changement de réglage'); } catch (e) { /* fermée */ }
  }
  clearTimeout(live.switchTimer);
  live.current = null;
  live.next = null;
  liveOpen('current');
}

function liveFallback(reason) {
  live.on = false;
  Object.assign(live, { state: 'error', error: reason });
  for (const s of live.sessions) { s.closing = true; try { s.ws.close(); } catch (e) { /* fermée */ } }
  live.sessions = new Set();
  live.current = null;
  live.next = null;
  clearTimeout(live.rotateTimer);
  clearTimeout(live.switchTimer);
  liveHideInterim();
  engine = 'clips';
  // L'audio pas encore transcrit (phrase en cours, phrases restées sans réponse) est encore en
  // mémoire : il part avec la prochaine phrase, par extraits. Rien n'est perdu.
  let from = live.win ? live.win.start : ring.pos;
  for (const w of live.wins) if (!w.sealed && !w.line && w.speech) from = Math.min(from, w.start);
  const pending = live.queue.find((c) => c.data);
  if (pending) from = Math.min(from, pending.end - pending.data.length);
  live.queue = [];
  if (live.win && live.win.line && !live.win.line.dead && live.win.line.status !== 'done') removeLine(live.win.line);
  live.win = null;
  pw.start = Math.max(from, ring.pos - 60 * RATE, 0);
  track.next = ring.pos + 0.75 * RATE;
  showBanner('Écoute en direct indisponible (' + reason + "). L'app traduit par extraits.");
  updateStatus();
}

async function liveStop() {
  clearTimeout(live.rotateTimer);
  clearTimeout(live.switchTimer);
  if (live.on) await flushCapture();   // la phrase en cours est close et part au serveur
  live.on = false;
  liveHideInterim();
  const s = live.current;
  if (s && s.ready && wsOpen(s)) {
    liveEnd(s);
    // Laisse arriver la dernière transcription (2,5 s au plus).
    const t0 = performance.now();
    while (performance.now() - t0 < 2500 && live.wins.some((w) => w.speech && !w.line && !w.sealed)) await sleep(100);
    await sleep(300);
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

// ─── Phrases (fenêtres) ──────────────────────────────────────────────────────
// Une fenêtre va d'une fin de phrase à la suivante (positions en échantillons, depuis le début
// de l'écoute). Toutes les transcriptions qui y tombent forment une seule ligne.
function winOpen(start) {
  return { id: ++live.winSeq, start, end: null, first: -1, last: -1, voiced: 0, speech: false, line: null, closedAt: 0, sealed: false, timer: 0 };
}

/** La parole a commencé dans la fenêtre ouverte. */
function liveSpeech() {
  if (live.win) live.win.speech = true;
}

/** Fin de phrase détectée par l'app, à sa place exacte dans le flux. */
function liveCut(c) {
  if (!live.on) return;
  const w = live.win;
  if (w) {
    Object.assign(w, { start: Math.min(w.start, c.start), end: c.at, first: c.first, last: c.last, voiced: c.voiced, speech: c.speech, closedAt: performance.now() });
    winClosed(w);
  }
  live.win = winOpen(c.at);
  live.queue.push({ cut: true });
  liveFlushQueue();
}

function winClosed(w) {
  live.wins.push(w);
  w.timer = setTimeout(() => winSeal(w), w.speech ? 6000 : 1500);
  const line = w.line;
  if (line && !line.dead) {
    line.span = winSpan(w);
    translateText(line);   // la phrase est complète : traduction définitive
    liveVoice(line);
  }
}

/** La fenêtre ne recevra plus de transcription. */
function winSeal(w) {
  if (w.sealed) return;
  w.sealed = true;
  clearTimeout(w.timer);
  const i = live.wins.indexOf(w);
  if (i >= 0) live.wins.splice(i, 1);
  if (!w.line && w.speech && w.voiced >= 1) liveMiss();
}

function winSpan(w) {
  return [w.first >= 0 ? w.first : w.start, w.last >= 0 ? w.last : (w.end === null ? ring.pos : w.end)];
}

/** Fenêtre d'une transcription : par ses horodatages, sinon par l'ordre d'arrivée. */
function winFor(session, tr) {
  const open = live.win;
  const pending = live.wins.filter((w) => !w.sealed);
  const a = durationSeconds(tr.startOffset), b = durationSeconds(tr.endOffset);
  if (a !== null && b !== null && b >= a && session.base !== null) {
    const mid = session.base + Math.round((a + b) / 2 * RATE);
    const hit = pending.find((w) => mid >= w.start && mid < w.end);
    if (hit) return hit;
    if (open && mid >= open.start && mid <= ring.pos + RATE) return open;
  }
  // Sans horodatage utilisable : la plus ancienne phrase finie qui attend encore sa transcription
  // (en activité manuelle, le serveur ne transcrit qu'en fin de phrase), sinon la phrase en cours.
  const waiting = pending.find((w) => w.speech && !w.line);
  if (waiting && (session.manual || !open || !open.speech)) return waiting;
  return open || pending[pending.length - 1];
}

function liveFinal(session, tr) {
  const text = String(tr.text || '').replace(/\s+/g, ' ').trim();
  if (!text || isNoiseOnly(text)) return;
  liveHideInterim();
  if (isForeignSpeech(text, tr.languageCode)) return;   // anglais ou français : rien à traduire
  const w = winFor(session, tr);
  if (!w) return;
  for (const old of live.wins.slice()) if (old.id < w.id) winSeal(old);
  let line = w.line && !w.line.dead ? w.line : null;
  if (line) {
    line.vi += ' ' + text;
    render(line);
  } else {
    line = {
      id: ++lineSeq, kind: 'live', win: w, createdAt: Date.now(), vi: text, fr: '', doneVi: '',
      status: 'waiting', error: '', autoRetry: false, voiceIds: null, span: winSpan(w)
    };
    w.line = line;
    lines.push(line);
    mountLine(line);
  }
  if (w.end !== null) {
    // Phrase finie : traduction (ou mise à jour si un morceau arrive en retard), couleur de la voix.
    line.span = winSpan(w);
    translateText(line);
    liveVoice(line);
  } else if (Date.now() - line.createdAt >= 4000) {
    translateText(line);   // long monologue : traduction provisoire, refaite à la fin de la phrase
  }
}

/** Phrase parlée restée sans transcription. Quatre en activité manuelle sans aucune réponse du
 * serveur : il ne suit pas ce mode, on revient à sa propre détection de parole. */
function liveMiss() {
  if (!LIVE_LEVELS[live.level].manual || live.heard || !live.on) return;
  if (++live.misses < 4) return;
  live.level = LIVE_LEVELS.length - 1;
  live.note = 'découpage par l\'app sans réponse du serveur : retour à la détection de Google';
  liveReconnect();
  if (!sheet.hidden) renderTech();
}

/** Audio d'une phrase, retrouvé dans les 90 dernières secondes, pour la couleur de la voix. */
function liveVoice(line) {
  if (!S.voices || !voice.worker || voice.state === 'error' || line.voiceSent || !line.span) return;
  const out = ringAudio(line.span[0] - Math.round(0.15 * RATE), line.span[1] + Math.round(0.15 * RATE), 20 * RATE);
  if (out && out.length >= 0.6 * RATE) {
    line.voiceSent = true;
    voiceEmbed(line, out);
  }
}

// ─── Mémoire audio commune ───────────────────────────────────────────────────
// Les 90 dernières secondes envoyées par le micro (PCM 16 kHz, après gain automatique) et la
// décision parole / silence de chaque trame de 20 ms : pour l'audio de chaque phrase, la couleur
// des voix et le repérage des changements de voix. Positions en échantillons depuis le début.
const ring = { chunks: [], pos: 0, vad: [] };
function ringPush(chunk) {
  ring.chunks.push(chunk);
  while (ring.chunks.length && chunk.end - ring.chunks[0].end > 90 * RATE) ring.chunks.shift();
  ring.pos = chunk.end;
  const v = chunk.vad;
  if (v && v.length) {
    for (let i = 0; i < v.length; i++) ring.vad.push({ e: chunk.vadEnd - (v.length - 1 - i) * 320, v: v[i] });
    while (ring.vad.length && chunk.vadEnd - ring.vad[0].e > 90 * RATE) ring.vad.shift();
  }
}
function ringReset() { ring.chunks = []; ring.pos = 0; ring.vad = []; }
/** Échantillons [a, b) encore en mémoire (au plus `max`, depuis le début), ou null. */
function ringAudio(a, b, max) {
  a = Math.max(0, Math.round(a));
  b = Math.min(ring.pos, Math.round(b));
  if (max && b - a > max) b = a + max;
  if (b <= a) return null;
  const out = new Float32Array(b - a);
  let filled = 0;
  for (const c of ring.chunks) {
    const cs = c.end - c.data.length;
    if (c.end <= a || cs >= b) continue;
    const from = Math.max(a, cs), to = Math.min(b, c.end);
    for (let i = from; i < to; i++) out[i - a] = c.data[i - cs] / 32768;
    filled += to - from;
  }
  return filled ? out : null;
}
/** Part des trames de parole entre a et b. */
function ringVoiced(a, b) {
  let n = 0, voiced = 0;
  for (let i = ring.vad.length - 1; i >= 0; i--) {
    const f = ring.vad[i];
    if (f.e <= a) break;
    if (f.e <= b) { n++; voiced += f.v; }
  }
  return n ? voiced / n : 0;
}
/** Début de la première trame de parole entre a et b, ou -1. */
function ringFirstVoiced(a, b) {
  for (const f of ring.vad) if (f.e > a && f.e <= b && f.v) return f.e - 320;
  return -1;
}

// ─── Voix au fil de l'écoute (phrase par phrase, par extraits) ───────────────
// Toutes les 0,75 s, l'empreinte vocale de la dernière 1,5 s de parole est calculée sur
// l'appareil. On sait ainsi à tout moment qui parle : quand une autre personne prend la parole,
// la réplique précédente part tout de suite, sans attendre une pause ; et chaque ligne reçoit la
// couleur de sa voix, sans calcul supplémentaire.
const track = { next: 0, list: [], busy: 0, ms: 0 };
function trackReset() { track.next = 1.5 * RATE; track.list = []; track.busy = 0; }

function trackStep() {
  if (!S.voices || voice.state !== 'ready' || !voice.worker) return;
  while (ring.pos >= track.next) {
    const end = track.next;
    track.next += 0.75 * RATE;
    if (track.busy >= 2 || ring.pos - end > 0.75 * RATE) continue;   // calcul en retard : on saute
    if (ringVoiced(end - 1.5 * RATE, end) < 0.4) continue;            // pas assez de parole
    const clip = ringAudio(end - 1.5 * RATE, end);
    if (!clip) continue;
    track.busy++;
    const id = ++voice.seq;
    voice.waiting.set(id, { track: end });
    voice.worker.postMessage({ type: 'embed1', id, samples: clip }, [clip.buffer]);
  }
}

/** Empreinte de la fenêtre de 1,5 s finissant à `end`. */
function trackResult(end, e) {
  track.busy = Math.max(0, track.busy - 1);
  if (!e || engine === 'live' || !listening) return;
  const entry = { c: end - 0.75 * RATE, e: VoiceClusters.normalize(e), id: voiceAssign([e])[0] };
  track.list.push(entry);
  while (track.list.length && end - track.list[0].c > 90 * RATE) track.list.shift();
  trackColor(entry);
  // Une autre personne a pris la parole : la réplique précédente part tout de suite.
  const since = track.list.filter((t) => t.c - 0.75 * RATE >= pw.start);
  const change = speakerChange(since, RATE);
  if (!change) return;
  const lo = Math.max(pw.start + 0.5 * RATE, change.lo), hi = Math.min(ring.pos, change.hi);
  const audio = hi - lo >= 0.1 * RATE ? ringAudio(lo, hi) : null;
  if (!audio) return;
  const cut = Math.round(lo + quietest(audio, 0, audio.length));
  const from = pw.start;
  pw.start = cut;
  capCommand({ type: 'rebase', at: cut });   // la réplique suivante compte sa durée depuis ici
  phraseEmit(from, cut, 'autre voix');
}

/** Lignes parties avant que les empreintes de leur voix soient prêtes : colorées dès qu'elles arrivent. */
function trackColor(entry) {
  for (let k = lines.length - 1, n = 0; k >= 0 && n < 10; k--, n++) {
    const l = lines[k];
    if (l.voiceIds || l.dead || !l.span || l.kind === 'live') continue;
    if (entry.c < l.span[0] || entry.c >= l.span[1]) continue;
    l.voiceIds = mainVoice(track.list.filter((t) => t.c >= l.span[0] && t.c < l.span[1]).map((t) => t.id));
    if (l.voiceIds) render(l);
  }
}

/**
 * Ligne partie sans couleur : le suivi des voix la colore dès que ses empreintes arrivent. Sinon
 * (suivi pas encore démarré, ou rien après 2,5 s), empreinte de la phrase entière : plus long,
 * et pendant ce calcul le suivi des voix attend, d'où ce délai.
 */
function voiceLater(line) {
  if (!S.voices || !voice.worker || voice.state === 'error') return;
  if (voice.state !== 'ready') { liveVoice(line); return; }
  setTimeout(() => { if (!line.voiceIds && !line.dead) liveVoice(line); }, 2500);
}

// ─── Phrase par phrase, par extraits ─────────────────────────────────────────
// L'app découpe la conversation en répliques, bout à bout, sans trou : à chaque vraie pause
// (fenêtres de Turns), et dès qu'une autre voix prend la parole. Chaque réplique part en entier
// dans sa propre requête : rien n'est perdu entre deux, le modèle entend toute la phrase, et
// les répliques avancent toutes en même temps, sans s'attendre.
// - Phrase par phrase : Gemini 3.5 Transcribe écrit la réplique, puis le texte est traduit.
// - Par extraits : Gemini Flash reçoit l'audio, transcrit et traduit d'un coup.
// Si Gemini 3.5 Transcribe est indisponible, ou ne rend rien là où Flash entend des mots, la
// suite passe par extraits, sans changer le découpage.
// Gemini 3.5 Transcribe a des limites basses (au palier 1 : 10 requêtes par minute, 100 par
// jour) : au-delà, chaque réplique part directement à Flash, et l'app tient le compte pour ne pas
// dépasser la limite apprise du premier refus (429). Une réplique refusée, ou trop longue à
// revenir, est reprise par Flash tout de suite : aucune ne reste en échec pour une limite.
const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
// Langues attendues : le vietnamien, et l'anglais et le français, bien écrits pour être ensuite
// laissés de côté par la traduction (sinon ils ressortent en faux vietnamien).
const phr = {
  vocab: true, langs: ['vi-VN', 'en-US', 'fr-FR'], note: '', rescued: 0,
  sent: [],                                   // envois des 60 dernières secondes
  rpm: 0,                                     // limite par minute apprise d'un refus (0 : inconnue)
  pausedUntil: store.get('transcribePause', 0), // limite atteinte : Flash seul jusqu'à cette heure
  quota: ''                                   // dernière limite atteinte, pour Infos techniques
};
if (phr.pausedUntil > Date.now()) phr.quota = 'limite par jour atteinte';
const pw = { start: 0 };     // début de la réplique en cours (position)
const RESCUE_VOICED = 1.0;   // s de parole : au-delà, une transcription vide est vérifiée par Flash

/** Fin de phrase repérée par Turns (pause, phrase trop longue, arrêt de l'écoute). */
function phraseCut(c) {
  const from = pw.start;
  pw.start = c.at;
  if (c.speech && c.last > from + 0.2 * RATE) phraseEmit(from, c.at, c.why || 'pause');
}

/** Envoie la réplique [a, b) : une ligne, ou une par voix si plusieurs personnes s'y suivent. */
function phraseEmit(a, b, why) {
  const first = ringFirstVoiced(a, b);
  if (first < 0) return;                       // aucune parole
  if (first - a > 3 * RATE) a = first - RATE;  // long silence au début : on garde 1 s avant le premier mot
  const samples = ringAudio(a, b);
  if (!samples || samples.length < 0.3 * RATE) return;
  const inside = track.list.filter((t) => t.c >= a && t.c < b);
  let parts = [{ a: 0, b: samples.length, ids: inside.map((t) => t.id) }];
  if (inside.length >= 4) {
    parts = speakerParts(samples, inside.map((t) => t.id), inside.map((t) => [t.c - 0.75 * RATE - a, t.c + 0.75 * RATE - a]), RATE);
  }
  for (const p of parts) {
    const part = parts.length > 1 ? samples.subarray(p.a, p.b) : samples;
    const span = [a + p.a, a + p.b];
    const voiced = ringVoiced(span[0], span[1]) * part.length / RATE;
    phraseLine(toBase64(encodeWAV(part, RATE)), mainVoice(p.ids), span, parts.length > 1 ? why + ' + autre voix' : why, part.length / RATE, voiced);
  }
}

/** Voix d'une ligne : la principale si elle domine nettement, sinon toutes. */
function mainVoice(ids) {
  const known = (ids || []).filter((id) => id !== null);
  if (!known.length) return null;
  const tally = new Map();
  for (const id of known) tally.set(id, (tally.get(id) || 0) + 1);
  let main = null, most = 0;
  for (const [id, n] of tally) if (n > most) { most = n; main = id; }
  return most >= 0.7 * known.length ? [main] : known;
}

function phraseLine(audio, ids, span, why, sec, voiced) {
  // Limite de Gemini 3.5 Transcribe atteinte : la réplique part directement à Flash.
  const overQuota = engine === 'phrases' && !canTranscribe();
  const line = {
    id: ++lineSeq, kind: engine === 'clips' || overQuota ? 'clip' : 'phrase', createdAt: Date.now(), audio,
    vi: '', fr: '', doneVi: '', status: 'waiting', error: '', autoRetry: false,
    voiceIds: ids && ids.length ? ids : null, span, voiced: voiced || 0, sec
  };
  journalAdd(line, why, sec);
  if (overQuota && line.log) line.log.quota = true;
  lines.push(line);
  mountLine(line);
  if (line.kind === 'clip') translate(line);
  else transcribePhrase(line);
  if (!line.voiceIds) voiceLater(line);
}

// ─── Journal des dernières répliques (Réglages › Infos techniques) ─────────────
// Pour comprendre en situation réelle ce qui ralentit ou ce qui manque : durée, parole entendue,
// raison de la coupure, temps de transcription et de traduction, réponse vide (et sa forme),
// erreur. Rien n'en sort de l'appareil.
const journal = [];
function journalAdd(line, why, sec) {
  line.log = {
    t: new Date(), sec, voiced: line.voiced, why, via: line.kind === 'clip' ? 'flash' : 'transcribe', quota: false,
    asr: null, asrError: '', words: null, shape: '', rescue: '', flash: null, flashWords: null, tr: null, error: ''
  };
  journal.push(line.log);
  if (journal.length > 30) journal.shift();
}

function wordCount(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

async function transcribePhrase(line) {
  if (line.dead || line.transcribing || !line.audio) return;
  if (!S.apiKey) {
    Object.assign(line, { status: 'failed', error: 'Ajoutez votre clé API Gemini dans les réglages.', autoRetry: false });
    render(line);
    return;
  }
  line.transcribing = true;
  Object.assign(line, { status: 'waiting', error: '', autoRetry: false });
  render(line);
  inFlight++;
  updateStatus();
  const t0 = performance.now();
  try {
    const r = await transcribe(line.audio, line.sec || 10);
    tech.asr = performance.now() - t0;
    const vi = String(r.text || '').replace(/\s+/g, ' ').trim();
    const words = isNoiseOnly(vi) ? 0 : wordCount(vi);
    if (line.log) Object.assign(line.log, { asr: tech.asr, words, shape: words ? '' : r.shape, error: '' });
    if (line.dead) return;
    if (!words) {
      // Rien d'écrit : du bruit, le plus souvent. Mais si l'on a nettement entendu parler,
      // Gemini Flash réécoute la phrase (transcription et traduction d'un coup).
      line.transcribing = false;
      if (line.voiced >= RESCUE_VOICED) phraseRescue(line, 'vide');
      else removeLine(line);
      return;
    }
    phr.rescued = 0;
    line.vi = vi;
    line.audio = null;
    render(line);
    translateText(line);
    retryFailed();
  } catch (err) {
    if (line.dead) return;
    if (line.log) {
      line.log.asrError = err.status ? 'erreur ' + err.status : errorMessage(err);
      line.log.error = 'transcription\u00a0: ' + line.log.asrError;
    }
    if (err.fallback) { line.transcribing = false; phraseFallback(err); return; }
    const offline = err.kind === 'network' && navigator.onLine === false;
    if (!isKeyError(err) && !offline) {
      // Limite atteinte, délai dépassé, serveur occupé : Flash reprend la réplique tout de suite.
      if (err.status === 429) transcribeQuota(err.quota || {});
      line.transcribing = false;
      phraseRescue(line, err.status === 429 ? 'limite' : 'erreur');
      return;
    }
    Object.assign(line, { status: 'failed', error: errorMessage(err), autoRetry: isTransient(err) || isKeyError(err) });
    render(line);
    if (isKeyError(err)) showBanner(errorMessage(err));
  } finally {
    line.transcribing = false;
    inFlight--;
    updateStatus();
  }
}

/** Gemini Flash reprend une réplique que Gemini 3.5 Transcribe a rendue vide (`vide`), a refusée pour une limite (`limite`) ou n'a pas su rendre (`erreur`). */
function phraseRescue(line, why) {
  line.kind = 'clip';
  line.rescue = why;
  if (line.log) line.log.rescue = why;
  translate(line);
}

/** Gemini 3.5 Transcribe peut-il prendre une réplique de plus sans dépasser sa limite ? */
function canTranscribe() {
  const now = Date.now();
  if (now < phr.pausedUntil) return false;
  while (phr.sent.length && now - phr.sent[0] > 60000) phr.sent.shift();
  return !phr.rpm || phr.sent.length < Math.max(1, phr.rpm - 1);   // une requête de marge
}

/** Refus pour limite atteinte (429) : par jour, Flash seul jusqu'à la remise à zéro ; par minute, on retient la limite. */
function transcribeQuota(q) {
  const now = Date.now();
  if (q.perDay) {
    phr.pausedUntil = quotaReset(now);
    phr.quota = 'limite par jour atteinte' + (q.limit ? ' (' + q.limit + ' requêtes)' : '');
    store.set('transcribePause', phr.pausedUntil);
  } else {
    const recent = phr.sent.filter((t) => now - t < 60000).length;
    phr.rpm = q.limit || phr.rpm || Math.max(1, recent - 1);
    phr.pausedUntil = now + Math.min(60000, q.retryMs || 15000);
    phr.quota = 'limite de ' + phr.rpm + ' requêtes par minute';
  }
  if (!sheet.hidden) renderTech();
}

/** État de Gemini 3.5 Transcribe pour Infos techniques. */
function transcribeStatus() {
  const now = Date.now();
  const n = phr.sent.filter((t) => now - t < 60000).length;
  const parts = [n + ' requête' + (n > 1 ? 's' : '') + ' dans la dernière minute' + (phr.rpm ? ' sur ' + phr.rpm + ' permises' : '')];
  if (phr.quota) parts.push(phr.quota);
  if (now < phr.pausedUntil) parts.push('répliques envoyées à Flash jusqu\'à ' + clockTime(phr.pausedUntil));
  else if (phr.rpm) parts.push('au-delà, répliques envoyées à Flash');
  return parts.join(' · ');
}

/**
 * Flash a entendu des mots là où Gemini 3.5 Transcribe n'a rien écrit. Deux fois de suite, sans
 * transcription réussie entre les deux : Transcribe ne marche pas en ce moment, la suite part
 * directement à Flash (même découpage).
 */
function phraseRescued(line) {
  if (line.rescue !== 'vide' || line.dead || isNoiseOnly(line.vi) || !wordCount(line.vi)) return;
  if (++phr.rescued < 2 || engine !== 'phrases') return;
  engine = 'clips';
  phr.note = 'Gemini 3.5 Transcribe rendait des transcriptions vides là où Gemini Flash entendait des mots : les phrases partent à Flash';
  showBanner("Gemini 3.5 Transcribe ne rend rien en ce moment : l'app passe par Gemini Flash, qui transcrit et traduit d'un coup.");
  updateStatus();
  if (!sheet.hidden) renderTech();
}

/**
 * Transcription d'une phrase. Requête refusée (400) : on retire d'abord ce que le message
 * d'erreur désigne, sinon le français, puis la liste de mots. Limite atteinte (429) ou délai
 * dépassé : pas de nouvel essai, Flash reprend la réplique ; serveur en erreur : un seul.
 */
async function transcribe(audio, sec) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await transcribeOnce(audio, phr.vocab, phr.langs, Math.max(8000, 4000 + sec * 1000));
    } catch (err) {
      if (err.kind === 'http' && !isKeyError(err) && (err.status === 400 || err.status === 404)) {
        const vocabBlamed = /vocab/i.test(err.message);
        if (err.status === 400 && phr.langs.length > 2 && !vocabBlamed) {
          phr.langs = ['vi-VN', 'en-US'];
          phr.note = 'français retiré des langues attendues (' + err.message.slice(0, 120) + ')';
          attempt--;
          continue;
        }
        if (err.status === 400 && phr.vocab) {
          phr.vocab = false;
          phr.note = 'liste de mots refusée (' + err.message.slice(0, 120) + ')';
          attempt--;
          continue;
        }
        err.fallback = true;   // modèle ou requête refusés : la suite part à Flash
        throw err;
      }
      if (err.status === 429 || err.kind === 'timeout' || attempt >= 2 || !isTransient(err)) throw err;
      await sleep(400);
    }
  }
}

async function transcribeOnce(audio, vocab, langs, timeoutMs) {
  const config = { languageCodes: langs };
  if (vocab) config.customVocabulary = LIVE_VOCAB;
  const body = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: audio } }] }],
    generationConfig: { audioTranscriptionConfig: config }
  };
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs || 25000);
  let res, raw;
  phr.sent.push(Date.now());
  try {
    res = await fetch(API + '/models/' + TRANSCRIBE_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.apiKey },
      body: JSON.stringify(body),
      signal: ctl.signal,
      cache: 'no-store'
    });
    raw = await res.text();
  } catch (e) {
    throw new GemError(timedOut ? 'timeout' : 'network', e && e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw httpError(raw, res.status);
  let json;
  try { json = JSON.parse(raw); } catch (e) { throw new GemError('stream', 'réponse illisible'); }
  const c = json.candidates && json.candidates[0];
  if (!c && json.promptFeedback && json.promptFeedback.blockReason) throw new GemError('stream', 'contenu bloqué (' + json.promptFeedback.blockReason + ')');
  return transcriptOf(json);
}

/**
 * Texte d'une réponse de Gemini 3.5 Transcribe. Le modèle le range dans une partie à part,
 * `audioTranscription` (`text`, ou ses mots un par un), la partie `text` restant vide ; une
 * partie `text` remplie ne sert qu'à défaut. `shape` décrit la réponse pour le journal.
 */
function transcriptOf(json) {
  const c = json && json.candidates && json.candidates[0];
  const parts = c && c.content && Array.isArray(c.content.parts) ? c.content.parts : [];
  const heard = [], texts = [];
  for (const p of parts) {
    if (!p || p.thought) continue;
    const t = p.audioTranscription;
    if (t && typeof t.text === 'string' && t.text.trim()) heard.push(t.text.trim());
    else if (t && Array.isArray(t.words) && t.words.length) {
      heard.push(t.words.map((w) => (w && (w.word || w.text)) || '').join(' ').trim());
    }
    if (typeof p.text === 'string' && p.text.trim()) texts.push(p.text.trim());
  }
  const shape = (parts.length ? parts.map((p) => Object.keys(p || {}).join('+') || '{}').join(', ') : 'aucune partie') +
    (c && c.finishReason ? ' · ' + c.finishReason : '');
  return { text: (heard.length ? heard : texts).join(' '), shape };
}

/** Gemini 3.5 Transcribe refusé ou introuvable : les phrases en attente et la suite partent à Flash. */
function phraseFallback(err) {
  if (engine === 'phrases') {
    engine = 'clips';
    showBanner('Gemini 3.5 Transcribe indisponible (' + err.message.slice(0, 120) + "). L'app passe par Gemini Flash, qui transcrit et traduit d'un coup.");
  }
  phr.note = 'Gemini 3.5 Transcribe indisponible (' + err.message.slice(0, 120) + ') : les phrases partent à Gemini Flash';
  for (const line of lines.slice()) {
    if (line.kind === 'phrase' && !line.vi && line.audio && !line.dead && !line.transcribing) {
      line.kind = 'clip';
      if (line.log) line.log.rescue = true;
      translate(line);
    }
  }
  updateStatus();
  if (!sheet.hidden) renderTech();
}

function cleanFrench(text) {
  return String(text || '').replace(/\s*\n+\s*/g, ' ').replace(/^\s*(\[[A-Z]\]\s*)?FR\s*[:：]\s*/i, '').replace(/^\s*\[[A-Z]\]\s*/, '').replace(/^["«“]\s*|\s*["»”]$/g, '').trim();
}

/** Lettres des voix d'une ligne (« A », « A+B »), ou ''. */
function speakerTag(line) {
  return S.voices && line.voiceIds ? voiceRuns(line.voiceIds).map((id) => voiceLabel(id).letter).join('+') : '';
}

/** Le fil de la conversation (phrases déjà transcrites, traduites ou non), puis la phrase à traduire. */
function translateUserText(context, line) {
  const tag = (who) => (who ? '[' + who + '] ' : '');
  const thread = context.map((c) => tag(c.who) + 'VI: ' + c.vi + (c.fr ? '\n' + tag(c.who) + 'FR: ' + c.fr : '')).join('\n');
  const who = speakerTag(line);
  return (thread ? 'Fil de la conversation (ne pas retraduire) :\n' + thread + '\n\n' : '') +
    (who ? 'Qui parle : [' + who + ']\n' : '') + 'Phrase à traduire :\n' + line.vi;
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
  if (line.vi === line.doneVi && line.status === 'done') return;   // déjà traduite telle quelle
  line.translating = true;
  line.again = false;
  // Mise à jour d'une phrase déjà traduite (morceau arrivé ensuite) : l'ancienne traduction reste
  // affichée jusqu'à la nouvelle, sans clignoter.
  const update = !!line.fr;
  Object.assign(line, { status: update ? 'done' : 'waiting', error: '', autoRetry: false });
  render(line);
  inFlight++;
  updateStatus();
  const vi = line.vi;
  const t0 = performance.now();
  let first = 0;
  try {
    const raw = await gemini({
      system: TRANSLATE_PROMPT,
      text: translateUserText(recentContext(line), { vi, voiceIds: line.voiceIds }),
      maxTokens: 512,
      onText: (text) => {
        if (!first) first = performance.now();
        if (update || line.dead || line.vi !== vi) return;
        line.fr = cleanFrench(text);
        line.status = 'streaming';
        render(line);
      }
    });
    tech.ttfb = first ? first - t0 : null;
    tech.total = performance.now() - t0;
    if (line.log) line.log.tr = tech.total;
    if (!line.dead && line.vi === vi && !line.again) {
      const fr = cleanFrench(raw);
      if (fr === '-' || isNoiseOnly(fr)) {
        // Rien à traduire (anglais, bruit) : la ligne disparaît, sauf si la phrase continue.
        if (line.win && line.win.end === null) { Object.assign(line, { fr: '', status: 'waiting' }); render(line); }
        else removeLine(line);
      } else {
        Object.assign(line, { fr, status: 'done', doneVi: vi });
        render(line);
      }
    }
    retryFailed();
  } catch (err) {
    if (line.log) line.log.error = 'traduction\u00a0: ' + (err.status ? 'erreur ' + err.status : errorMessage(err));
    if (!line.dead) {
      // Mise à jour ratée : l'ancienne traduction reste, la suivante réessaiera.
      if (update) line.status = 'done';
      else Object.assign(line, { status: 'failed', error: errorMessage(err), autoRetry: isTransient(err) || isKeyError(err) });
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
  Turns.toString(),
  Capture.toString(),
  `class TDCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const port = this.port;
    this.rs = new Resampler(sampleRate, 16000);
    this.cap = new Capture(o, function (m, transfer) { port.postMessage(m, transfer || []); });
    port.onmessage = (e) => this.cap.command(e.data || {});
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) this.cap.process(this.rs.process(input[0]));
    return true;
  }
}
registerProcessor('td-capture', TDCapture);`
].join('\n');

// Découpage (réglettes, mêmes valeurs dans les trois modes) : une phrase part après `pause`
// secondes de silence ; un long monologue part à la première petite pause passé `maxLen`
// secondes de parole, au plus tard au double. Une autre voix coupe aussi la phrase.
function currentTurns() {
  return { endSilence: S.pause, softMax: S.maxLen, softPause: Math.min(0.25, S.pause / 2), hardMax: 2 * S.maxLen };
}

/** Commande pour la chaîne du micro, qu'elle tourne dans l'AudioWorklet ou en secours. */
function capCommand(m) {
  if (cap.node) cap.node.port.postMessage(m);
  else if (cap.feed) cap.feed.command(m);
}

/** Nouveau découpage pendant l'écoute : il vaut tout de suite, phrase en cours comprise. */
function applyTuning() {
  if (listening) capCommand({ type: 'tune', turns: currentTurns() });
}

const cap = { ctx: null, stream: null, src: null, node: null, sp: null, feed: null, sink: null, url: '', lastAudio: 0, failures: 0 };
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
  else if (msg.type === 'pcm') { ringPush(msg); if (engine === 'live') liveSend(msg); else trackStep(); }
  else if (msg.type === 'cut') { if (engine === 'live') liveCut(msg); else phraseCut(msg); }
  else if (msg.type === 'speech') { if (engine === 'live') liveSpeech(msg); }
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
        processorOptions: { turns: currentTurns(), stream: true }
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
    const feed = new Capture({ turns: currentTurns(), stream: true }, (m) => onCapture(m));
    cap.feed = feed;
    sp.onaudioprocess = (e) => {
      if (cap.feed === feed) feed.process(rs.process(e.inputBuffer.getChannelData(0)));
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

/** Rend la phrase en cours (extrait, ou fin de phrase en continu) ; attend l'accusé du micro. */
function flushCapture() {
  return new Promise((resolve) => {
    if (!cap.node && !cap.feed) { resolve(); return; }
    const id = ++flushSeq;
    flushWaiters.set(id, resolve);
    capCommand({ type: 'flush', id });
    setTimeout(() => { if (flushWaiters.delete(id)) resolve(); }, 400);
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
  engine = ENGINES.some((e) => e.id === S.listen) ? S.listen : 'phrases';
  ringReset();
  trackReset();
  pw.start = 0;
  phr.rescued = 0;
  phr.note = '';
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
    Object.assign(cap, { ctx: null, node: null, sp: null, feed: null, sink: null, src: null, stream: null });
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
  Object.assign(cap, { ctx: null, node: null, sp: null, feed: null, sink: null, src: null, stream: null });
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
  { id: 'phrases', title: 'Phrase par phrase', sub: "L'app découpe la conversation en phrases, sans rien laisser de côté. Chaque phrase est écrite mot à mot par Gemini 3.5 Transcribe, puis traduite. Le plus fidèle (recommandé)." },
  { id: 'clips', title: 'Par extraits', sub: "Même découpage. Chaque phrase part en audio au modèle choisi plus haut, qui transcrit et traduit d'un coup : une étape de moins." },
  { id: 'live', title: 'En direct', sub: "Gemini 3.5 Transcribe Live écrit le vietnamien pendant qu'on parle. Plus réactif, mais il peut manquer le début d'une phrase après une pause." }
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
    input.checked = en.id === (ENGINES.some((e) => e.id === S.listen) ? S.listen : 'phrases');
    input.addEventListener('change', () => {
      save('listen', en.id);
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
  $('engineNote').hidden = true;
}

// Réglettes du découpage : elles valent tout de suite, même pendant l'écoute.
const pauseRange = $('pauseRange');
const maxRange = $('maxRange');
function renderCuts() {
  pauseRange.value = String(S.pause);
  maxRange.value = String(S.maxLen);
  showCuts();
}
function showCuts() {
  $('pauseOut').textContent = S.pause.toFixed(1).replace('.', ',') + ' s';
  $('maxOut').textContent = S.maxLen + ' s';
  $('maxSub').textContent = 'Passé ' + S.maxLen + ' s de parole, la phrase part à la première petite pause, au plus tard à ' + 2 * S.maxLen + ' s.';
  $('cutReset').disabled = S.pause === CUT_DEFAULTS.pause && S.maxLen === CUT_DEFAULTS.maxLen;
}
pauseRange.addEventListener('input', () => {
  save('pause', Math.round(Number(pauseRange.value) * 10) / 10);
  showCuts();
  applyTuning();
});
maxRange.addEventListener('input', () => {
  save('maxLen', Math.round(Number(maxRange.value)));
  showCuts();
  applyTuning();
});
$('cutReset').addEventListener('click', () => {
  save('pause', CUT_DEFAULTS.pause);
  save('maxLen', CUT_DEFAULTS.maxLen);
  renderCuts();
  applyTuning();
});

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
  if (listening && engine === 'phrases') return 'phrase par phrase · Gemini 3.5 Transcribe, puis traduction par ' + currentModel().sub.split(' · ')[0] + (phr.vocab ? '' : ' (sans liste de mots)');
  if (engine === 'live' && live.on) {
    if (live.state === 'connected') return 'en direct · Gemini 3.5 Transcribe Live connecté · phrases découpées par ' + (LIVE_LEVELS[live.level].manual ? "l'app" : 'Google');
    if (live.state === 'reconnecting') return 'en direct · reconnexion (' + live.error + ')';
    return 'en direct · connexion…';
  }
  if (listening && engine === 'clips') {
    const why = S.listen === 'live' && live.state === 'error' ? ' (en direct indisponible : ' + live.error + ')' : S.listen === 'phrases' && phr.note ? ' (' + phr.note + ')' : '';
    return 'par extraits · ' + currentModel().sub.split(' · ')[0] + ' transcrit et traduit' + why;
  }
  return ({ phrases: 'phrase par phrase', live: 'en direct', clips: 'par extraits' }[S.listen] || 'phrase par phrase') + ' (au démarrage de l\'écoute)';
}

function voiceStatus() {
  if (!S.voices) return 'désactivées';
  if (voice.state === 'off') return 'au démarrage de l\'écoute';
  if (voice.state === 'loading') return 'chargement du modèle…';
  if (voice.state === 'error') return 'indisponibles : ' + voice.error;
  const n = voice.clusters.list.length;
  const parts = [n ? n + ' voix reconnue' + (n > 1 ? 's' : '') : 'prêtes', 'modèle ' + (voice.size / 1e6).toFixed(1).replace('.', ',') + ' Mo'];
  // Suivi : une empreinte toutes les 0,75 s. Plus lent que ça, l'appareil en saute.
  if (track.ms) parts.push('suivi ' + Math.round(track.ms) + ' ms par empreinte' + (track.ms > 700 ? ' (appareil lent : changement de voix repéré plus tard)' : ''));
  if (voice.ms) parts.push('phrase entière ' + Math.round(voice.ms) + ' ms');
  return parts.join(' · ');
}

/** Une ligne du journal : durée, parole entendue, coupure, transcription, Flash, traduction. */
function journalText(j) {
  const plural = (n, w) => n + '\u00a0' + w + (n > 1 ? 's' : '');
  const parts = [seconds(j.sec * 1000) + (j.voiced ? ' (parole ' + seconds(j.voiced * 1000) + ')' : ''), 'coupée\u00a0: ' + j.why];
  if (j.via === 'transcribe') {
    parts.push(j.asr === null ? (j.asrError ? (j.error ? '' : 'transcription\u00a0: ' + j.asrError) : j.error ? '' : 'transcription…')
      : 'transcription ' + seconds(j.asr) + (j.words ? ' (' + plural(j.words, 'mot') + ')' : ' (vide' + (j.shape ? '\u00a0: ' + j.shape : '') + ')'));
  }
  if (j.via === 'flash' || j.rescue) {
    const label = j.rescue === 'vide' ? 'réécoutée par Flash' : j.rescue === 'limite' ? 'limite de Transcribe, reprise par Flash'
      : j.rescue ? 'reprise par Flash' : j.quota ? 'Flash (limite de Transcribe)' : 'Flash';
    parts.push(j.flash === null ? (j.error ? '' : label + '…')
      : label + ' ' + seconds(j.flash) + (j.flashWords ? ' (' + plural(j.flashWords, 'mot') + ')' : ' (rien entendu)'));
  }
  if (j.tr !== null) parts.push('traduction ' + seconds(j.tr));
  if (j.error) parts.push(j.error);
  return parts.filter(Boolean).join(' · ');
}

function renderTech() {
  const rows = [
    ['Écoute', liveStatusText()],
    ['Connexion', CONFIGS[cfgIndex].label + (S.priority && CONFIGS[cfgIndex].tier ? ' · prioritaire' : '')],
    ['Audio', tech.mode ? tech.mode + ' · ' + tech.rate + ' Hz → 16 kHz' : 'pas encore démarré'],
    ['Gain du micro', typeof tech.gain === 'number' ? (tech.gain >= 0 ? '+' : '−') + Math.abs(Math.round(tech.gain)) + ' dB, automatique' : 'automatique (×16 au plus par phrase)'],
    ['Dernière phrase', tech.total ? (tech.asr ? 'transcription ' + seconds(tech.asr) + ' · ' : '') + (tech.ttfb ? 'premiers mots ' + seconds(tech.ttfb) + ' · ' : '') + 'traduction ' + seconds(tech.total) : '—'],
    ['Écran allumé', 'wakeLock' in navigator ? (wakeLock ? 'actif' : 'pendant l\'écoute') : 'non pris en charge'],
    ['Découpage', 'fin de phrase après ' + seconds(S.pause * 1000) + ' de silence · réplique longue coupée vers ' + S.maxLen + ' s (au plus ' + 2 * S.maxLen + ' s)'],
    ['Voix', voiceStatus()]
  ];
  if (tech.probe && !tech.probe.ok) rows.push(['Dernier test', errorMessage(tech.probe.err)]);
  if (live.note) rows.push(['Écoute (note)', live.note]);
  if (S.listen === 'phrases' || phr.sent.length || phr.quota) rows.push(['Transcribe', transcribeStatus()]);
  if (phr.note) rows.push(['Transcription (note)', phr.note]);
  if (tech.note) rows.push(['Note', tech.note]);
  // Dernières répliques, de la plus récente à la plus ancienne.
  for (const j of journal.slice(-8).reverse()) {
    rows.push([j.t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), journalText(j)]);
  }
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
