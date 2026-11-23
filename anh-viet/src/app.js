// ─── Anh → Việt : interprète anglais → vietnamien, avec Qwen ─────────────────
// Même principe que Thông Dịch : le découpage en phrases tourne sur le thread audio
// (AudioWorklet) et chaque phrase part aussitôt, en parallèle des précédentes. Qwen3-ASR-Flash
// l'écrit (en anglais, ou en français), puis un modèle Qwen la traduit en vietnamien avec le fil
// de la conversation. Rien n'est perdu pendant qu'une phrase est en cours.
//
// Les appels passent par l'API « DashScope » de Model Studio (…/api/v1/services/aigc/…), en
// JSON, sans streaming et sans en-tête particulier : la forme que Model Studio accepte depuis
// une page web, d'après les essais d'autres projets (« Vérifier et enregistrer » le confirme).
// Son API compatible OpenAI, elle, n'envoie pas les en-têtes CORS : une page web ne peut pas la lire.

const RATE = 16000;
const ASR_MODEL = 'qwen3-asr-flash';
const PATHS = {
  mm: '/api/v1/services/aigc/multimodal-generation/generation',    // audio, et modèles Qwen3.5 et suivants
  text: '/api/v1/services/aigc/text-generation/generation'         // modèles texte (Qwen-MT)
};
const REGIONS = [
  { id: 'sg', title: 'Singapour (international)', sub: 'Pour une clé créée dans la région Singapour de Model Studio (recommandé).', base: 'https://dashscope-intl.aliyuncs.com' },
  { id: 'cn', title: 'Pékin (Chine continentale)', sub: 'Pour une clé créée dans la région Pékin.', base: 'https://dashscope.aliyuncs.com' },
  { id: 'custom', title: 'Autre adresse', sub: "Espace de travail Model Studio ou relais.", base: '' }
];
// Modèles de traduction. Si un modèle n'existe pas pour ce compte ou cette région, l'app passe
// au suivant de sa liste de secours, sans rien perdre.
const MODELS = [
  { id: 'qwen3.7-flash', api: 'mm', title: 'Rapide', sub: 'Qwen3.7 Flash · suit le fil de la conversation (recommandé)', fallback: ['qwen3.6-flash', 'qwen3.5-flash'] },
  { id: 'qwen3.7-plus', api: 'mm', title: 'Soigné', sub: 'Qwen3.7 Plus · tournures plus naturelles, un peu plus lent', fallback: ['qwen3.6-plus', 'qwen3.7-flash', 'qwen3.6-flash'] },
  { id: 'qwen-mt-flash', api: 'text', mt: true, title: 'Spécialisé', sub: 'Qwen-MT Flash · modèle de traduction, phrase par phrase, sans le fil', fallback: ['qwen-mt-plus', 'qwen3.7-flash'] }
];
// Pronoms : le vietnamien dit « je » et « tu » selon l'âge et la relation. On choisit comment on
// s'appelle (je) et comment on appelle la personne en face (tu) ; choisir « tu » met le « je » qui
// va avec (con → chú…), qu'on peut changer ensuite.
const JE = [
  { id: 'tôi', label: 'tôi · neutre' },
  { id: 'con', label: 'con · à cô, chú, bác, ông, bà' },
  { id: 'em', label: 'em · à anh, chị' },
  { id: 'chị', label: 'chị · à plus jeune' },
  { id: 'auto', label: 'Qwen choisit' }
];
const TU = [
  { id: 'bạn', pair: 'tôi', label: 'bạn · neutre', who: 'someone of about the same age, or a stranger' },
  { id: 'anh', pair: 'em', label: 'anh · homme un peu plus âgé', who: 'a man a little older than the speaker' },
  { id: 'chị', pair: 'em', label: 'chị · femme un peu plus âgée', who: 'a woman a little older than the speaker' },
  { id: 'em', pair: 'chị', label: 'em · plus jeune', who: 'someone younger than the speaker' },
  { id: 'cô', pair: 'con', label: 'cô · femme, âge des parents', who: 'a woman of the speaker’s parents’ generation' },
  { id: 'chú', pair: 'con', label: 'chú · homme, âge des parents', who: 'a man of the speaker’s parents’ generation, younger than her father' },
  { id: 'bác', pair: 'con', label: 'bác · plus âgé que les parents', who: 'a man or a woman older than the speaker’s parents' },
  { id: 'ông', pair: 'con', label: 'ông · homme âgé', who: 'an elderly man' },
  { id: 'bà', pair: 'con', label: 'bà · femme âgée', who: 'an elderly woman' },
  { id: 'auto', pair: 'auto', label: 'Qwen choisit', who: '' }
];
const LANGS = [
  { id: 'auto', label: 'Anglais ou français (auto)', sub: "Recommandé : la langue est reconnue à chaque phrase, et les réponses en vietnamien de la personne en face sont laissées de côté." },
  { id: 'en', label: 'Toujours l’anglais', sub: "Reconnaissance un peu plus sûre si personne d'autre ne parle. Une réponse en vietnamien serait alors mal comprise." }
];
const FORCE_SCRIPT_PROCESSOR = /[?&]audio=script\b/.test(location.search);

// ─── Réglages (gardés dans ce navigateur seulement) ──────────────────────────
// Préfixe propre à cette app : Thông Dịch, sur le même site, garde les siens à part.
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('av.' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('av.' + key, JSON.stringify(value)); } catch (e) { /* stockage indisponible */ }
  }
};

const CUT_DEFAULTS = { pause: 1.0, maxLen: 6 };
const S = {
  apiKey: store.get('apiKey', ''),
  region: store.get('region', 'sg'),
  customBase: store.get('customBase', ''),
  model: store.get('model', MODELS[0].id),
  je: store.get('je', 'tôi'),
  tu: store.get('tu', 'bạn'),
  lang: store.get('lang', 'auto'),
  vocab: store.get('vocab', ''),
  pause: store.get('pause', CUT_DEFAULTS.pause),
  maxLen: store.get('maxLen', CUT_DEFAULTS.maxLen),
  showEn: store.get('showEn', true),
  big: store.get('big', false),
  micId: store.get('micId', ''),
  micLabel: store.get('micLabel', '')
};
if (!REGIONS.some((r) => r.id === S.region)) S.region = 'sg';
if (!MODELS.some((m) => m.id === S.model)) S.model = MODELS[0].id;
if (!JE.some((p) => p.id === S.je)) S.je = 'tôi';
if (!TU.some((p) => p.id === S.tu)) S.tu = 'bạn';
if (!LANGS.some((l) => l.id === S.lang)) S.lang = 'auto';
const clampNum = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
S.pause = Math.round(clampNum(S.pause, 0.3, 2, CUT_DEFAULTS.pause) * 10) / 10;
S.maxLen = Math.round(clampNum(S.maxLen, 3, 15, CUT_DEFAULTS.maxLen));
function save(key, value) { S[key] = value; store.set(key, value); }

// ─── Client Qwen (Model Studio, API DashScope) ───────────────────────────────
const tech = { mode: '', rate: 0, gain: null, asr: null, tr: null, probe: null };

class QwenError extends Error {
  constructor(kind, message, status, code) {
    super(message);
    this.kind = kind;          // http, network, timeout, parse, config
    this.status = status || 0;
    this.code = code || '';
  }
}

/** Adresse du serveur : celle de la région, ou une adresse saisie (vérifiée), sans le chemin d'API. */
function apiBase() {
  if (S.region === 'custom') return cleanBase(S.customBase);
  return (REGIONS.find((r) => r.id === S.region) || REGIONS[0]).base;
}

function cleanBase(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https:\/\//i.test(u)) u = 'https://' + u.replace(/^[a-z]+:\/\//i, '');
  try {
    const p = new URL(u);
    // La politique de sécurité de la page n'autorise que ces domaines.
    if (!/(^|\.)aliyuncs\.com$|\.workers\.dev$/i.test(p.hostname)) return '';
    const path = p.pathname.replace(/\/+$/, '').replace(/\/(api\/v1|compatible-mode\/v1)(\/.*)?$/i, '');
    return p.origin + path;
  } catch (e) { return ''; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST JSON vers Model Studio. Rend la réponse décodée, ou lève une QwenError. */
async function qwenPost(api, body, timeoutMs) {
  const base = apiBase();
  if (!base) throw new QwenError('config', 'Adresse du serveur Qwen invalide (Réglages › Serveur Qwen).');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, raw;
  try {
    res = await fetch(base + PATHS[api], {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + S.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      signal: ctrl.signal
    });
    raw = await res.text();
  } catch (e) {
    const late = ctrl.signal.aborted;
    throw new QwenError(late ? 'timeout' : 'network', late ? 'Délai dépassé.' : 'Réseau indisponible.');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = JSON.parse(raw); } catch (e) { /* pas du JSON */ }
  if (!res.ok || (json && json.code && !json.output)) {
    const code = (json && json.code) || '';
    const message = (json && json.message) || String(raw || '').slice(0, 200) || 'HTTP ' + res.status;
    throw new QwenError('http', message, res.status, code);
  }
  if (!json || !json.output) throw new QwenError('parse', 'Réponse illisible de Qwen.');
  return json;
}

const isKeyError = (e) => !!e && e.kind === 'http' && (e.status === 401 || /InvalidApiKey/i.test(e.code));
const isAccountError = (e) => !!e && e.kind === 'http' && /Arrearage|FreeTierOnly|Overdue|AccountStatus/i.test(e.code + ' ' + e.message);
const isModelError = (e) => !!e && e.kind === 'http' && !isKeyError(e) && !isAccountError(e) &&
  (e.status === 404 || ((e.status === 400 || e.status === 403) && /model|enable_thinking|AccessDenied|not (exist|found|support)/i.test(e.code + ' ' + e.message)));
const isTransient = (e) => !!e && (e.kind === 'network' || e.kind === 'timeout' || (e.kind === 'http' && (e.status === 429 || e.status >= 500)));

function errorMessage(err) {
  if (!err) return 'Erreur inconnue.';
  if (err.kind === 'config' || err.kind === 'parse') return err.message;
  if (err.kind === 'timeout') return 'Délai dépassé (réseau lent).';
  if (err.kind === 'network') {
    return navigator.onLine === false ? 'Pas de connexion internet.'
      : 'Qwen ne répond pas depuis cette page (réseau coupé, ou appel refusé par le serveur).';
  }
  const t = err.code + ' ' + err.message;
  if (isKeyError(err)) return "Clé refusée par Qwen : vérifiez qu'elle est complète et qu'elle vient de la région choisie dans « Serveur Qwen ».";
  if (/FreeTierOnly/i.test(t)) return 'Quota gratuit épuisé : dans Model Studio, désactivez « Free tier only » pour continuer en payant.';
  if (/Arrearage|Overdue/i.test(t)) return 'Compte Alibaba Cloud en impayé : rechargez-le ou ajoutez un moyen de paiement.';
  if (err.status === 429) return 'Trop de requêtes en même temps chez Qwen : nouvel essai automatique.';
  if (/DataInspection/i.test(t)) return 'Passage refusé par le filtre de contenu de Qwen.';
  if (isModelError(err)) return 'Modèle indisponible pour ce compte ou cette région (' + err.message + ').';
  if (err.status >= 500) return 'Qwen est momentanément indisponible (erreur ' + err.status + ').';
  return 'Erreur ' + err.status + ' : ' + err.message;
}

/** Erreur en quelques mots, pour le journal. */
function shortError(err) {
  if (!err) return 'erreur';
  if (err.kind === 'http') return (err.code || 'erreur') + ' ' + err.status;
  return { network: 'réseau', timeout: 'délai dépassé', parse: 'réponse illisible', config: 'adresse invalide' }[err.kind] || 'erreur';
}

/** Un essai de plus sur une erreur passagère (réseau, surcharge, trop de requêtes). */
async function withRetry(fn) {
  try { return await fn(); } catch (e) {
    if (!isTransient(e) || (e.kind === 'network' && navigator.onLine === false)) throw e;
    await sleep(e.status === 429 ? 1500 : 400);
    return fn();
  }
}

/** Texte de la réponse : `content` est une liste de { text } (modèles multimodaux) ou une chaîne. */
function contentText(json) {
  const out = json && json.output;
  const choice = out && out.choices && out.choices[0];
  const c = choice && choice.message ? choice.message.content : out && out.text;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

/** Langue reconnue par Qwen3-ASR (« en », « fr », « vi »…), ou ''. */
function detectedLang(json) {
  const choice = json && json.output && json.output.choices && json.output.choices[0];
  const notes = choice && choice.message && choice.message.annotations;
  const info = Array.isArray(notes) && notes.find((a) => a && a.language);
  return info ? String(info.language).toLowerCase() : '';
}

function vocabList() {
  return String(S.vocab || '').split(/[,;\n]/).map((w) => w.trim().slice(0, 40)).filter(Boolean).slice(0, 40);
}

// ─── Transcription : Qwen3-ASR-Flash ─────────────────────────────────────────
async function transcribe(audio, sec) {
  const messages = [];
  const vocab = vocabList();
  // Contexte de Qwen3-ASR : liste de noms et de termes, pour les écrire juste.
  if (vocab.length) messages.push({ role: 'system', content: [{ text: vocab.join(', ') }] });
  messages.push({ role: 'user', content: [{ audio: 'data:audio/wav;base64,' + audio }] });
  const asrOptions = { enable_itn: true };   // nombres en chiffres
  if (S.lang === 'en') asrOptions.language = 'en';
  const body = { model: ASR_MODEL, input: { messages }, parameters: { asr_options: asrOptions } };
  const json = await withRetry(() => qwenPost('mm', body, Math.max(8000, 4000 + sec * 1000)));
  return { text: contentText(json).trim(), lang: detectedLang(json) };
}

// ─── Traduction ──────────────────────────────────────────────────────────────
const trState = { dead: new Set(), used: '', note: '' };

function chosenModel() { return MODELS.find((m) => m.id === S.model) || MODELS[0]; }
function modelInfo(id) {
  return MODELS.find((m) => m.id === id) || { id, api: /^qwen-mt-/.test(id) ? 'text' : 'mm', mt: /^qwen-mt-/.test(id) };
}
/** Le modèle choisi, ou le premier de ses secours encore disponible. */
function activeModel() {
  const chain = [S.model].concat(chosenModel().fallback || []);
  const id = chain.find((m) => !trState.dead.has(m)) || S.model;
  return modelInfo(id);
}
/** « qwen3.6-flash » → « Qwen3.6 Flash », « qwen-mt-plus » → « Qwen-MT Plus ». */
function modelName(id) {
  const m = MODELS.find((x) => x.id === id);
  if (m) return m.sub.split(' · ')[0];
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const s = String(id);
  if (/^qwen-mt-/.test(s)) return 'Qwen-MT ' + cap(s.slice(8));
  return s.replace(/^qwen([\d.]+)-(\w+)$/, (x, v, n) => 'Qwen' + v + ' ' + cap(n));
}

/** Consigne des pronoms, d'après les choix « je » et « tu ». */
function pronounRule() {
  if (S.je === 'auto' && S.tu === 'auto') {
    return 'choose natural Vietnamese pronouns from the context and keep them consistent; when unsure, use “tôi” and “bạn”.';
  }
  const tu = TU.find((p) => p.id === S.tu) || TU[0];
  const me = S.je === 'auto' ? 'choose from the context how the speaker calls herself'
    : 'the speaker calls herself “' + S.je + '” (for I, me and my)';
  const you = tu.id === 'auto' ? 'choose from the context how to address the listener'
    : 'address the listener as “' + tu.id + '”, ' + tu.who + ' (for you and your; for several listeners, the usual plural)';
  const polite = ['con', 'em'].includes(S.je) || ['anh', 'chị', 'cô', 'chú', 'bác', 'ông', 'bà'].includes(tu.id);
  return me + '; ' + you + '.' +
    (polite ? ' Be polite, as with an elder: use “dạ” and “ạ” where Vietnamese speakers naturally would, without changing the meaning.' : '') +
    ' Keep these pronouns in every sentence.';
}
/** Jeu de pronoms en vigueur : le fil de la conversation ne mélange pas deux jeux. */
function pronounKey() { return S.je + '/' + S.tu; }

function systemPrompt() {
  const vocab = vocabList();
  return [
    'You are a live interpreter in Ho Chi Minh City. Someone is speaking, usually in English (sometimes in French), to Vietnamese people. You receive the automatic transcript of what they just said, one sentence or phrase at a time, and translate it into Vietnamese so the listeners can read it on a phone screen.',
    '',
    'Rules:',
    '- Faithful and complete: keep every idea, question, number, name and nuance. Never add, explain, summarize, or answer the speaker.',
    '- Natural, everyday spoken Vietnamese as people speak it in Saigon, with correct diacritics. No slang unless the speaker uses slang.',
    '- Pronouns: ' + pronounRule(),
    '- The transcript may contain recognition errors, miss punctuation or stop mid-sentence: use the recent conversation to understand it, but translate only the new text.',
    '- Keep names of people, places and brands unchanged' + (vocab.length ? ' (for example: ' + vocab.join(', ') + ')' : '') + '.',
    '- Parts already in Vietnamese are the listeners answering: leave them out. If nothing is left to translate (only Vietnamese, or only hesitation sounds such as um, uh, hmm), answer exactly: -',
    '- Answer with the Vietnamese translation only: no quotes, labels, notes or alternatives.'
  ].join('\n');
}

function userPrompt(context, text) {
  const thread = context.map((c) => 'Speaker: ' + c.en + '\nVietnamese: ' + c.vi).join('\n');
  return (thread ? 'Recent conversation (context only, do not translate it again):\n' + thread + '\n\n' : '') +
    'Translate into Vietnamese:\n' + text;
}

/** Consigne de Qwen-MT (« domains ») : il ne prend ni message système ni fil de conversation. */
function mtDomain() {
  const vocab = vocabList();
  return 'Live spoken conversation with Vietnamese people in Ho Chi Minh City, translated sentence by sentence for them to read: natural, everyday spoken Vietnamese. Pronouns: ' +
    pronounRule() + (vocab.length ? ' Keep these names unchanged: ' + vocab.join(', ') + '.' : '');
}

function translateBody(model, text, context) {
  if (model.mt) {
    return {
      model: model.id,
      input: { messages: [{ role: 'user', content: text }] },
      parameters: {
        result_format: 'message',
        translation_options: { source_lang: S.lang === 'en' ? 'English' : 'auto', target_lang: 'Vietnamese', domains: mtDomain() }
      }
    };
  }
  return {
    model: model.id,
    input: {
      messages: [
        { role: 'system', content: [{ text: systemPrompt() }] },
        { role: 'user', content: [{ text: userPrompt(context, text) }] }
      ]
    },
    parameters: { result_format: 'message', enable_thinking: false, temperature: 0.3, max_tokens: 600 }
  };
}

/** Traduit `text` ; passe au modèle de secours si celui-ci n'existe pas pour ce compte. */
async function translateText(text, context) {
  for (;;) {
    const model = activeModel();
    try {
      const json = await withRetry(() => qwenPost(model.api, translateBody(model, text, context), 12000));
      trState.used = model.id;
      return cleanVi(contentText(json));
    } catch (e) {
      const chain = [S.model].concat(chosenModel().fallback || []);
      if (isModelError(e) && chain.some((id) => id !== model.id && !trState.dead.has(id))) {
        trState.dead.add(model.id);
        trState.note = modelName(model.id) + ' indisponible (' + shortError(e) + ') : remplacé par ' + modelName(activeModel().id);
        continue;
      }
      throw e;
    }
  }
}

function cleanVi(text) {
  return String(text || '')
    .replace(/^\s*```[a-z]*\s*|\s*```\s*$/gi, '')
    .replace(/^\s*(VI|Vietnamese|Tiếng Việt|Bản dịch)\s*[:：]\s*/i, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/^["“«]\s*|\s*["”»]$/g, '')
    .trim();
}

/** Seulement des hésitations (« uh », « um », « hmm », « euh »…) ou rien. */
function isFiller(text) {
  const words = String(text || '').toLowerCase().replace(/[^\p{L}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  return words.every((w) => /^(u+h+|u+m+|h+m+|m+h*m+|a+h+|e+r+m*|o+h+|hu+h|e+h+|eu+h+)$/.test(w));
}

// Lettres propres au vietnamien (â, ê, ô, à… existent aussi en français).
const VIET_ONLY = /[áảãạăằắẳẵặấầẩẫậđẻẽẹếềểễệìíỉĩịòóỏõọốồổỗộơờớởỡợúủũụưừứửữựỳýỷỹỵ]/i;
/**
 * Réplique entièrement en vietnamien (la personne en face qui répond) : la moitié des mots au
 * moins portent un accent vietnamien. Une phrase mêlée part à la traduction, qui laisse de côté
 * les morceaux déjà en vietnamien.
 */
function isVietnamese(text, lang) {
  if (lang && lang !== 'vi') return false;
  const words = String(text || '').split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return words.length > 0 && words.filter((w) => VIET_ONLY.test(w)).length / words.length >= 0.5;
}

// ─── Interface ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
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

document.body.classList.toggle('big', S.big);

function showBanner(text) {
  $('bannerText').textContent = text;
  banner.hidden = false;
}
function hideBanner() { banner.hidden = true; }
$('bannerClose').addEventListener('click', hideBanner);

function updateStatus() {
  let text;
  if (listening) text = (micBusy ? 'Micro occupé' : (micName || 'Micro')) + (inFlight ? ' · ' + inFlight + ' en cours' : '');
  else text = starting ? 'Démarrage…' : 'En pause';
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
  const tr = document.createElement('p');
  tr.className = 'tr';
  tr.lang = 'vi';
  const err = document.createElement('div');
  err.className = 'err';
  const errText = document.createElement('p');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'retry';
  retry.textContent = 'Réessayer';
  retry.addEventListener('click', () => retryLine(line));
  err.append(errText, retry);
  const src = document.createElement('p');
  src.className = 'src';
  src.lang = 'en';
  el.append(tr, err, src);
  line.el = el;
  line.parts = { tr, err, errText, src };
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
  p.tr.hidden = failed;
  if (failed) p.errText.textContent = line.error;
  if (line.status === 'done') {
    p.tr.textContent = line.vi;
    p.tr.classList.remove('wait');
  } else if (!failed) {
    p.tr.textContent = line.status === 'asr' ? 'Transcription' : 'Traduction';
    p.tr.classList.add('wait');
  }
  // L'anglais : toujours visible sur une ligne en échec, pour savoir ce qui n'est pas passé.
  const showSrc = !!line.en && (S.showEn || failed);
  p.src.hidden = !showSrc;
  if (showSrc) {
    p.src.textContent = line.en;
    p.src.lang = line.lang && /^[a-z]{2}$/.test(line.lang) ? line.lang : 'en';
  }
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
  linesEl.textContent = '';
  follow = true;
  livePill.hidden = true;
  updateStatus();
}

function removeLine(line) {
  line.dead = true;
  const i = lines.indexOf(line);
  if (i >= 0) lines.splice(i, 1);
  if (line.el) line.el.remove();
  line.el = null;
  updateStatus();
}

function failLine(line, err, autoRetry) {
  Object.assign(line, { status: 'failed', error: typeof err === 'string' ? err : errorMessage(err), autoRetry: !!autoRetry });
  render(line);
}

// ─── Phrases ─────────────────────────────────────────────────────────────────
// L'app découpe la parole en phrases, bout à bout, sans trou : à chaque vraie pause (fenêtres de
// Turns, réglettes « Découpage »). Chaque phrase part en entier dans sa propre requête : rien
// n'est perdu entre deux, et les phrases avancent toutes en même temps, sans s'attendre.
const pw = { start: 0 };   // début de la phrase en cours (position en échantillons)

/** Fin de phrase repérée par Turns (pause, phrase trop longue, arrêt de l'écoute). */
function phraseCut(c) {
  const from = pw.start;
  pw.start = c.at;
  if (c.speech && c.last > from + 0.2 * RATE) phraseEmit(from, c.at, c.why || 'pause');
}

function phraseEmit(a, b, why) {
  const first = ringFirstVoiced(a, b);
  if (first < 0) return;                       // aucune parole
  if (first - a > 3 * RATE) a = first - RATE;  // long silence au début : on garde 1 s avant le premier mot
  const samples = ringAudio(a, b);
  if (!samples || samples.length < 0.3 * RATE) return;
  const sec = samples.length / RATE;
  const line = {
    id: ++lineSeq, createdAt: Date.now(), audio: toBase64(encodeWAV(samples, RATE)), sec,
    voiced: ringVoiced(a, b) * sec, en: '', vi: '', lang: '', status: 'asr', error: '', autoRetry: false
  };
  journalAdd(line, why);
  lines.push(line);
  mountLine(line);
  transcribeLine(line);
}

async function transcribeLine(line) {
  if (line.dead || line.busy || !line.audio) return;
  if (!S.apiKey) { failLine(line, 'Ajoutez votre clé API Qwen dans les réglages.', false); return; }
  line.busy = true;
  Object.assign(line, { status: 'asr', error: '', autoRetry: false });
  render(line);
  inFlight++;
  updateStatus();
  const t0 = performance.now();
  let next = false;
  try {
    const r = await transcribe(line.audio, line.sec);
    tech.asr = performance.now() - t0;
    Object.assign(line.log, { asr: tech.asr, words: wordCount(r.text), lang: r.lang, error: '' });
    if (line.dead) return;
    if (!r.text || isNoiseOnly(r.text) || isFiller(r.text)) {
      line.log.drop = r.text ? 'hésitation' : 'rien entendu';
      removeLine(line);
    } else if (S.lang !== 'en' && isVietnamese(r.text, r.lang)) {
      line.log.drop = 'réponse en vietnamien, laissée de côté';
      removeLine(line);
    } else {
      Object.assign(line, { en: r.text, lang: r.lang, audio: null });
      next = true;
    }
    retryFailed();
  } catch (err) {
    line.log.error = 'transcription : ' + shortError(err);
    if (!line.dead) failLine(line, err, isTransient(err) || isKeyError(err) || isAccountError(err));
    if (isKeyError(err) || isAccountError(err)) showBanner(errorMessage(err));
  } finally {
    line.busy = false;
    inFlight--;
    updateStatus();
    if (!sheet.hidden) renderTech();
  }
  if (next) translateLine(line);
}

/** Le fil de la conversation : les phrases déjà traduites des 3 dernières minutes, avec les mêmes pronoms. */
function recentContext(line) {
  const index = lines.indexOf(line);
  const cutoff = line.createdAt - 180000;
  const out = [];
  for (let k = index - 1; k >= 0 && out.length < 6; k--) {
    const prev = lines[k];
    if (prev.createdAt < cutoff) break;
    if (prev.dead || prev.status !== 'done' || !prev.en || prev.pron !== line.pron) continue;
    out.unshift({ en: prev.en, vi: prev.vi });
  }
  return out;
}

async function translateLine(line) {
  if (line.dead || line.busy || !line.en) return;
  if (!S.apiKey) { failLine(line, 'Ajoutez votre clé API Qwen dans les réglages.', false); return; }
  line.busy = true;
  Object.assign(line, { status: 'tr', error: '', autoRetry: false, pron: pronounKey() });
  render(line);
  inFlight++;
  updateStatus();
  const t0 = performance.now();
  try {
    const vi = await translateText(line.en, recentContext(line));
    tech.tr = performance.now() - t0;
    Object.assign(line.log, { tr: tech.tr, model: trState.used, error: '' });
    if (line.dead) return;
    if (!vi || vi === '-' || isNoiseOnly(vi)) {
      line.log.drop = 'rien à traduire';
      removeLine(line);
    } else {
      Object.assign(line, { vi, status: 'done' });
      render(line);
    }
    retryFailed();
  } catch (err) {
    line.log.error = 'traduction : ' + shortError(err);
    if (!line.dead) failLine(line, err, isTransient(err) || isKeyError(err) || isAccountError(err));
    if (isKeyError(err) || isAccountError(err)) showBanner(errorMessage(err));
  } finally {
    line.busy = false;
    inFlight--;
    updateStatus();
    if (!sheet.hidden) renderTech();
  }
}

function retryLine(line) {
  if (line.status !== 'failed' || line.busy || line.dead) return;
  if (line.en) translateLine(line);
  else transcribeLine(line);
}

/** Un appel a réussi, ou le réseau est revenu : on relance les phrases restées en échec. */
function retryFailed() {
  for (const line of lines) if (line.status === 'failed' && line.autoRetry) retryLine(line);
}
window.addEventListener('online', retryFailed);

// ─── Journal des dernières phrases (Réglages › Infos techniques) ─────────────
// Pour comprendre en situation réelle ce qui ralentit ou ce qui manque : durée, parole entendue,
// raison de la coupure, temps de transcription et de traduction, erreur. Rien n'en sort de l'appareil.
const journal = [];
function journalAdd(line, why) {
  line.log = { t: new Date(), sec: line.sec, voiced: line.voiced, why, asr: null, words: null, lang: '', tr: null, model: '', drop: '', error: '' };
  journal.push(line.log);
  if (journal.length > 30) journal.shift();
}

function wordCount(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

// ─── Mémoire audio ───────────────────────────────────────────────────────────
// Les 90 dernières secondes envoyées par le micro (PCM 16 kHz, après gain automatique) et la
// décision parole / silence de chaque trame de 20 ms. Positions en échantillons depuis le début.
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
/** Échantillons [a, b) encore en mémoire, ou null. */
function ringAudio(a, b) {
  a = Math.max(0, Math.round(a));
  b = Math.min(ring.pos, Math.round(b));
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

// ─── Micro ───────────────────────────────────────────────────────────────────
const WORKLET_SOURCE = [
  Resampler.toString(),
  Segmenter.toString(),
  Agc.toString(),
  Turns.toString(),
  Capture.toString(),
  `class AVCapture extends AudioWorkletProcessor {
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
registerProcessor('av-capture', AVCapture);`
].join('\n');

// Découpage (réglettes) : une phrase part après `pause` secondes de silence ; un long monologue
// part à la première petite pause passé `maxLen` secondes de parole, au plus tard au double.
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
  else if (msg.type === 'pcm') ringPush(msg);
  else if (msg.type === 'cut') phraseCut(msg);
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
      const node = new AudioWorkletNode(ctx, 'av-capture', {
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
    const feedCap = new Capture({ turns: currentTurns(), stream: true }, (m) => onCapture(m));
    cap.feed = feedCap;
    sp.onaudioprocess = (e) => {
      if (cap.feed === feedCap) feedCap.process(rs.process(e.inputBuffer.getChannelData(0)));
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

/** Rend la phrase en cours ; attend l'accusé du micro. */
function flushCapture() {
  return new Promise((resolve) => {
    if (!cap.node && !cap.feed) { resolve(); return; }
    const id = ++flushSeq;
    flushWaiters.set(id, resolve);
    capCommand({ type: 'flush', id });
    setTimeout(() => { if (flushWaiters.delete(id)) resolve(); }, 400);
  });
}

/** Ouvre la connexion vers Qwen avant la première phrase (rien n'est envoyé). */
let warmedAt = 0;
function warmUp() {
  const base = apiBase();
  if (!base || Date.now() - warmedAt < 60000) return;
  warmedAt = Date.now();
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = base;
  link.crossOrigin = 'anonymous';   // même type de connexion que les appels (sans cookies)
  document.head.appendChild(link);
  setTimeout(() => link.remove(), 30000);
}

async function startListening() {
  if (listening || starting) return;
  if (!S.apiKey) { openSettings(true); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showBanner(window.isSecureContext ? "Ce navigateur ne donne pas accès au micro." : "Le micro n'est accessible que sur une page sécurisée (https).");
    return;
  }
  starting = true;
  ringReset();
  pw.start = 0;
  updateStatus();
  lockScreen();   // demandé pendant le toucher : Safari l'accorde plus volontiers
  // L'AudioContext doit naître pendant le toucher (règle de Safari), avant toute attente.
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
  cap.ctx = ctx;
  const resumed = ctx.resume().catch(() => {});
  warmUp();
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
  await flushCapture().catch(() => {});
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
  if (hiddenAt) {
    const gap = (Date.now() - hiddenAt) / 1000;
    hiddenAt = 0;
    // Sur iPhone le micro s'arrête quand la page passe en arrière-plan ; ailleurs il continue.
    if (gap >= 2 && !heardWhileHidden) addNote('Écoute coupée pendant ' + formatGap(gap) + ' (écran verrouillé ou autre app)');
    warmUp();
  }
});

function formatGap(sec) {
  if (sec < 60) return Math.round(sec) + ' s';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m + ' min' + (s ? ' ' + s + ' s' : '');
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
const customInput = $('customInput');

function openSettings(welcome) {
  $('welcome').hidden = !welcome;
  keyInput.value = S.apiKey;
  setKeyStatus('', '');
  renderChoices('regionChoices', 'region', REGIONS, S.region, onRegion);
  renderCustom();
  renderChoices('modelChoices', 'model', MODELS, S.model, (id) => { save('model', id); trState.dead.clear(); trState.note = ''; });
  renderSelect('langSelect', LANGS, S.lang);
  showLangSub();
  $('vocabInput').value = S.vocab;
  renderCuts();
  $('enToggle').checked = S.showEn;
  $('bigToggle').checked = S.big;
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

// Vérification de la clé : une transcription d'un court silence et une traduction d'une phrase,
// en même temps. Elle teste aussi que le serveur répond bien à une page web.
const SILENCE = toBase64(encodeWAV(new Float32Array(RATE / 2), RATE));
const PROBE_TEXT = 'Hello, nice to meet you.';

async function probe() {
  const t0 = performance.now();
  const [a, t] = await Promise.allSettled([
    transcribe(SILENCE, 0.5).then(() => performance.now() - t0),
    translateText(PROBE_TEXT, []).then((vi) => ({ ms: performance.now() - t0, vi }))
  ]);
  if (a.status === 'fulfilled' && t.status === 'fulfilled') return { ok: true, asrMs: a.value, trMs: t.value.ms, sample: t.value.vi };
  return { ok: false, asrErr: a.status === 'rejected' ? a.reason : null, trErr: t.status === 'rejected' ? t.reason : null };
}

function probeMessage(r) {
  const e = r.trErr || r.asrErr;
  if (isKeyError(e)) return "Clé refusée par Qwen. Vérifiez qu'elle est copiée en entier et qu'elle vient de la région choisie dans « Serveur Qwen ».";
  if (e && e.kind === 'network' && navigator.onLine !== false) {
    return "Qwen ne répond pas depuis cette page. Si internet marche, c'est que ce serveur refuse les appels venant d'une page web : essayez l'autre serveur, ou une adresse de relais (Serveur Qwen › Autre adresse).";
  }
  if (r.asrErr && !r.trErr) return 'La traduction marche, mais pas la transcription : ' + errorMessage(r.asrErr);
  if (r.trErr && !r.asrErr) return 'La transcription marche, mais pas la traduction : ' + errorMessage(r.trErr);
  return errorMessage(e);
}

async function saveKey(key, showResult) {
  save('apiKey', key);
  trState.dead.clear();
  trState.note = '';
  if (showResult) setKeyStatus('Vérification…', 'busy');
  const r = await probe();
  tech.probe = r;
  if (r.ok) {
    if (showResult) {
      setKeyStatus('✓ Clé valide · transcription ' + seconds(r.asrMs) + ' · traduction ' + seconds(r.trMs) +
        (r.sample ? ' · « ' + PROBE_TEXT + ' » → « ' + r.sample + ' »' : ''), 'ok');
    }
    hideBanner();
    retryFailed();
  } else {
    const msg = probeMessage(r);
    if (showResult) setKeyStatus(msg, 'bad');
    else showBanner(msg);
  }
  if (!sheet.hidden) renderTech();
}

$('checkBtn').addEventListener('click', () => {
  const key = keyInput.value.trim();
  if (!key) { setKeyStatus("Collez d'abord la clé.", 'bad'); keyInput.focus(); return; }
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

/** Choix à boutons radio (serveur, modèle). */
function renderChoices(boxId, name, items, current, onPick) {
  const box = $(boxId);
  box.textContent = '';
  for (const item of items) {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = item.id;
    input.checked = item.id === current;
    input.addEventListener('change', () => onPick(item.id));
    const text = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = item.title;
    const sub = document.createElement('small');
    sub.textContent = item.sub;
    text.append(title, sub);
    label.append(input, text);
    box.appendChild(label);
  }
}

function renderSelect(id, items, current) {
  const select = $(id);
  select.textContent = '';
  for (const item of items) {
    const o = document.createElement('option');
    o.value = item.id;
    o.textContent = item.label;
    select.appendChild(o);
  }
  select.value = current;
}

function onRegion(id) {
  save('region', id);
  trState.dead.clear();
  trState.note = '';
  warmedAt = 0;
  renderCustom();
}

function renderCustom() {
  const custom = S.region === 'custom';
  customInput.hidden = !custom;
  $('customNote').hidden = !custom;
  if (custom) customInput.value = S.customBase;
}

customInput.addEventListener('change', () => {
  const clean = cleanBase(customInput.value);
  save('customBase', clean || customInput.value.trim());
  $('customNote').textContent = clean ? 'Appels envoyés à ' + clean + '.'
    : "Adresse refusée : seuls les domaines …aliyuncs.com (Model Studio) et ….workers.dev (relais) sont autorisés.";
});

// Pronoms : de part et d'autre du micro, et dans Réglages › Traduction. Choisir « tu » met le
// « je » qui va avec ; changer « je » ne touche pas à « tu ». Ils valent dès la phrase suivante.
const jeSelects = [$('jeChip'), $('jeSelect')];
const tuSelects = [$('tuChip'), $('tuSelect')];
function fillSelect(select, items, current, short) {
  select.textContent = '';
  for (const item of items) {
    const o = document.createElement('option');
    o.value = item.id;
    o.textContent = short ? item.id : item.label;
    select.appendChild(o);
  }
  select.value = current;
}
function renderPronouns() {
  jeSelects.forEach((el, i) => fillSelect(el, JE, S.je, i === 0));
  tuSelects.forEach((el, i) => fillSelect(el, TU, S.tu, i === 0));
}
function setPronouns(je, tu) {
  save('je', je);
  save('tu', tu);
  jeSelects.forEach((el) => { el.value = je; });
  tuSelects.forEach((el) => { el.value = tu; });
  if (!sheet.hidden) renderTech();
}
jeSelects.forEach((el) => el.addEventListener('change', () => setPronouns(el.value, S.tu)));
tuSelects.forEach((el) => el.addEventListener('change', () => {
  const tu = TU.find((p) => p.id === el.value) || TU[0];
  setPronouns(tu.pair, tu.id);
}));
renderPronouns();
$('langSelect').addEventListener('change', (e) => { save('lang', e.target.value); showLangSub(); });
function showLangSub() { $('langSub').textContent = (LANGS.find((l) => l.id === S.lang) || LANGS[0]).sub; }
$('vocabInput').addEventListener('change', (e) => save('vocab', e.target.value.trim()));

// Réglettes du découpage : elles valent tout de suite, même pendant l'écoute.
const pauseRange = $('pauseRange');
const maxRange = $('maxRange');
function renderCuts() {
  pauseRange.value = String(S.pause);
  maxRange.value = String(S.maxLen);
  showCuts();
}
function showCuts() {
  $('pauseOut').textContent = S.pause.toFixed(1).replace('.', ',') + ' s';
  $('maxOut').textContent = S.maxLen + ' s';
  $('maxSub').textContent = 'Passé ' + S.maxLen + ' s de parole, la phrase part à la première petite pause, au plus tard à ' + 2 * S.maxLen + ' s.';
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

$('enToggle').addEventListener('change', (e) => {
  save('showEn', e.target.checked);
  lines.forEach(render);
});
$('bigToggle').addEventListener('change', (e) => {
  save('big', e.target.checked);
  document.body.classList.toggle('big', S.big);
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
  return (ms / 1000).toFixed(1).replace('.', ',') + ' s';
}

/** Une ligne du journal : durée, parole entendue, coupure, transcription, traduction. */
function journalText(j) {
  const plural = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');
  const parts = [seconds(j.sec * 1000) + (j.voiced ? ' (parole ' + seconds(j.voiced * 1000) + ')' : ''), 'coupée : ' + j.why];
  if (j.asr !== null) parts.push('transcription ' + seconds(j.asr) + (j.words ? ' (' + plural(j.words, 'mot') + (j.lang ? ', ' + j.lang : '') + ')' : ' (vide)'));
  else if (!j.error) parts.push('transcription…');
  if (j.tr !== null) parts.push('traduction ' + seconds(j.tr) + (j.model && j.model !== S.model ? ' (' + modelName(j.model) + ')' : ''));
  if (j.drop) parts.push(j.drop);
  if (j.error) parts.push(j.error);
  return parts.join(' · ');
}

function renderTech() {
  const base = apiBase();
  const rows = [
    ['Écoute', 'phrase par phrase · Qwen3-ASR-Flash écrit ' + (S.lang === 'en' ? "l'anglais" : 'la langue reconnue') + ', ' + modelName(activeModel().id) + ' traduit'],
    ['Serveur', base ? base.replace(/^https:\/\//, '') : 'adresse invalide'],
    ['Pronoms', 'je\u00a0: ' + (S.je === 'auto' ? 'au choix de Qwen' : S.je) + ' · tu\u00a0: ' + (S.tu === 'auto' ? 'au choix de Qwen' : S.tu)],
    ['Audio', tech.mode ? tech.mode + ' · ' + tech.rate + '\u00a0Hz → 16\u00a0kHz' : 'pas encore démarré'],
    ['Gain du micro', typeof tech.gain === 'number' ? (tech.gain >= 0 ? '+' : '−') + Math.abs(Math.round(tech.gain)) + ' dB, automatique' : 'automatique (×16 au plus par phrase)'],
    ['Dernière phrase', tech.asr ? 'transcription ' + seconds(tech.asr) + (tech.tr ? ' · traduction ' + seconds(tech.tr) : '') : '—'],
    ['Écran allumé', 'wakeLock' in navigator ? (wakeLock ? 'actif' : "pendant l'écoute") : 'non pris en charge'],
    ['Découpage', 'fin de phrase après ' + seconds(S.pause * 1000) + ' de silence · réplique longue coupée vers ' + S.maxLen + ' s (au plus ' + 2 * S.maxLen + ' s)']
  ];
  if (trState.note) rows.push(['Modèle', trState.note]);
  if (tech.probe && !tech.probe.ok) rows.push(['Dernier test', probeMessage(tech.probe)]);
  // Dernières phrases, de la plus récente à la plus ancienne.
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
