/* ============================================================================
 * Traducteur IA — traduction vocale temps réel, 100% navigateur.
 *
 *   🎤 micro  →  📝 Groq Whisper (STT + détection de langue)
 *             →  🌍 traduction (Groq Llama / Mistral) vers le français
 *             →  🔊 voix française (speechSynthesis) + texte
 *
 * L'écoute est CONTINUE : le micro ne s'arrête jamais tant qu'on n'a pas
 * appuyé sur Stop, même pendant que la voix française parle. Les phrases
 * captées sont mises en file et traitées dans l'ordre.
 * ========================================================================== */

'use strict';

// ───────────────────────────── Réglages (localStorage) ─────────────────────
const DEFAULTS = {
  groqKey: '', mistralKey: '',
  provider: 'groq',
  sttModel: 'whisper-large-v3-turbo',
  groqModel: 'llama-3.1-8b-instant',
  mistralModel: 'mistral-small-latest',
  ttsEngine: 'eleven',
  voiceURI: '',
  rate: 1.05,
  elevenKey: '',
  elevenVoice: 'XB0fDUnXU5powFXDhCwa',
  elevenModel: 'eleven_turbo_v2_5',
  recGapMin: 8,
  sens: 60,
  speakEnabled: true,
};
let settings = load();

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('traducteur') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function save() { localStorage.setItem('traducteur', JSON.stringify(settings)); }

// ───────────────────────────── Paramètres VAD ──────────────────────────────
const TARGET_RATE   = 16000;   // Whisper aime le 16 kHz → upload léger, plus rapide
const END_SILENCE_MS = 650;    // silence avant de clôturer une phrase
const MIN_SPEECH_MS  = 280;    // en-dessous = bruit, on ignore
const MAX_UTT_MS     = 14000;  // phrase trop longue → on coupe quand même
const PREROLL_FRAMES = 3;      // ~250 ms gardés avant le début de parole
const CONTINUOUS_MS  = 3000;   // taille des tranches en mode continu

// ───────────────────────────── État runtime ────────────────────────────────
let mode = 'phrase';
let running = false;
let ctx, stream, source, processor, wakeLock = null;
let collecting = false, curFrames = [], curMs = 0, speechMs = 0, silenceMs = 0;
let preRoll = [];
const sttQueue = [];
let pumping = false;
let selectedVoice = null;
let ttsCtx = null;                 // contexte audio dédié à la voix premium (ElevenLabs)
const elevenQueue = [];            // file de lecture ElevenLabs (1 à la fois, dans l'ordre)
let elevenPlaying = false;
let elevenDisabled = false;        // passe à true quand le quota gratuit est épuisé → voix navigateur
// Enregistrement sur Supabase (clé publique intégrée — aucune saisie utilisateur)
const SUPABASE_URL = (window.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
let rec = { session: null, hourKey: null, lastAt: 0 };   // suivi du « contexte » = 1 session
const recQueue = [];               // lignes en attente (résilient si le réseau coupe)
let recPumping = false;

// ───────────────────────────── Raccourcis DOM ──────────────────────────────
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const queueEl = $('queue');
const recordBtn = $('record');
const convo = [];   // historique de la session (écran principal + onglet Historique)

// ============================================================================
// 1. CAPTURE AUDIO + DÉTECTION DE PAROLE (VAD)
// ============================================================================
async function start() {
  if (!settings.groqKey) { openSettings(); toast('Ajoute ta clé Groq dans les réglages ⚙️'); return; }

  // Débloque la synthèse vocale + l'audio premium (iOS exige un geste utilisateur)
  try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(' ')); } catch {}
  ensureTtsCtx();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) { toast('Micro refusé : ' + e.message); return; }

  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();
  source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor : déprécié mais c'est le plus fiable sur Safari iOS.
  processor = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0; // ne JAMAIS renvoyer le micro vers les HP
  processor.onaudioprocess = onAudio;
  source.connect(processor); processor.connect(mute); mute.connect(ctx.destination);

  resetUtterance(); preRoll = [];
  running = true;
  await requestWakeLock();
  setRecording(true);
  setStatus('listening', 'à l’écoute');
}

function stop() {
  running = false;
  try { processor && (processor.onaudioprocess = null, processor.disconnect()); } catch {}
  try { source && source.disconnect(); } catch {}
  try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { ctx && ctx.close(); } catch {}
  releaseWakeLock();
  setRecording(false);
  setStatus('idle', sttQueue.length ? 'Traitement…' : 'Touchez pour écouter');
  recordBtn.style.removeProperty('--lvl');
  pumpRecord(); // envoie ce qui reste en file (enregistrement Supabase)
}

function onAudio(e) {
  if (!running) return;
  const input = e.inputBuffer.getChannelData(0);
  const frame = new Float32Array(input.length);
  frame.set(input);

  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  updateMeter(rms);

  const frameMs = (frame.length / ctx.sampleRate) * 1000;

  // ── Mode continu : on découpe en tranches fixes ──
  if (mode === 'continuous') {
    curFrames.push(frame); curMs += frameMs;
    if (curMs >= CONTINUOUS_MS) finalizeUtterance();
    return;
  }

  // ── Mode phrase : on détecte les pauses ──
  const threshold = sensToThreshold(settings.sens);
  const isSpeech = rms > threshold;

  if (isSpeech) {
    if (!collecting) { collecting = true; curFrames = preRoll.slice(); curMs = curFrames.length * frameMs; }
    curFrames.push(frame); curMs += frameMs; speechMs += frameMs; silenceMs = 0;
    if (curMs >= MAX_UTT_MS) finalizeUtterance();
  } else {
    preRoll.push(frame); if (preRoll.length > PREROLL_FRAMES) preRoll.shift();
    if (collecting) {
      curFrames.push(frame); curMs += frameMs; silenceMs += frameMs;
      if (silenceMs >= END_SILENCE_MS) {
        if (speechMs >= MIN_SPEECH_MS) finalizeUtterance();
        else resetUtterance();
      }
    }
  }
}

function finalizeUtterance() {
  if (!curFrames.length) { resetUtterance(); return; }
  const merged = mergeFrames(curFrames);
  resetUtterance();
  const ds = downsample(merged, ctx.sampleRate, TARGET_RATE);
  const blob = encodeWAV(ds, TARGET_RATE);
  sttQueue.push(blob);
  updateQueue();
  pump();
}

function resetUtterance() { collecting = false; curFrames = []; curMs = 0; speechMs = 0; silenceMs = 0; }
function sensToThreshold(s) { return 0.004 + (1 - s / 100) * 0.03; } // sens↑ → seuil↓ → + sensible

// ============================================================================
// 2. PIPELINE : transcription → traduction → voix
// ============================================================================
async function pump() {
  if (pumping) return;
  pumping = true;
  while (sttQueue.length) {
    const blob = sttQueue.shift(); updateQueue();
    setStatus('busy', 'traduction…');
    try {
      const { text, language } = await transcribe(blob);
      if (!text || !text.trim()) continue;

      // Garde-fou anti-boucle : si c'est déjà du français, on n'essaie pas de
      // le "traduire" ni de le lire (sinon, sans écouteurs, la voix se traduirait
      // elle-même en boucle).
      if (isFrench(language)) { addEntry({ language, original: text, french: text, skipped: true }); continue; }

      const french = await translate(text, language);
      addEntry({ language, original: text, french });
      recordEntry({ t: new Date(), language, original: text, french });
      speak(french);
    } catch (err) {
      toast('Erreur : ' + err.message);
    }
  }
  pumping = false;
  if (running) setStatus('listening', 'à l’écoute');
  else setStatus('idle', 'prêt');
}

async function transcribe(blob) {
  const fd = new FormData();
  fd.append('file', blob, 'audio.wav');
  fd.append('model', settings.sttModel);
  fd.append('response_format', 'verbose_json');
  fd.append('temperature', '0');
  const res = await fetchRetry('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + settings.groqKey },
    body: fd,
  });
  const data = await res.json();
  return { text: (data.text || '').trim(), language: (data.language || '').toLowerCase() };
}

const SYSTEM_PROMPT =
  "Tu es un interprète professionnel en temps réel. Traduis fidèlement le texte fourni en " +
  "français naturel, fluide et idiomatique. Réponds UNIQUEMENT avec la traduction française : " +
  "aucun guillemet, aucune explication, aucun préambule, aucune note. Si le texte est déjà en " +
  "français, renvoie-le tel quel. Préserve le sens, le ton et le registre. Ne complète pas, ne " +
  "résume pas : traduis exactement ce qui est dit.";

async function translate(text, sourceLang) {
  const isMistral = settings.provider === 'mistral';
  const url = isMistral ? 'https://api.mistral.ai/v1/chat/completions'
                        : 'https://api.groq.com/openai/v1/chat/completions';
  const key = isMistral ? settings.mistralKey : settings.groqKey;
  if (!key) throw new Error('clé ' + settings.provider + ' manquante');
  const body = {
    model: isMistral ? settings.mistralModel : settings.groqModel,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }],
    temperature: 0.2,
    max_tokens: 500,
  };
  const res = await fetchRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function fetchRetry(url, opts, tries = 3) {
  let delay = 700;
  for (let i = 0; i < tries; i++) {
    let res;
    try { res = await fetch(url, opts); }
    catch (e) { if (i < tries - 1) { await sleep(delay); delay *= 2; continue; } throw new Error('réseau'); }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) { await sleep(delay); delay *= 2; continue; }
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); msg = j.error?.message || j.detail?.message || j.detail || j.message || msg; } catch {}
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
    const err = new Error(msg); err.status = res.status; throw err;
  }
}

// ============================================================================
// 3. VOIX (speechSynthesis)
// ============================================================================
function speak(text) {
  if (!settings.speakEnabled || !text) return;
  if (settings.ttsEngine === 'eleven' && settings.elevenKey && !elevenDisabled) enqueueEleven(text);
  else browserSpeak(text);
}

// ── Voix du navigateur (gratuite, instantanée) ──
function browserSpeak(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'fr-FR';
  if (selectedVoice) u.voice = selectedVoice;
  u.rate = Number(settings.rate) || 1.05;
  u.onstart = () => markSpeaking(true);
  u.onend = () => markSpeaking(false);
  speechSynthesis.speak(u);
}

// ── Voix premium ElevenLabs (qualité, quota limité) ──
function ensureTtsCtx() {
  try {
    if (!ttsCtx) ttsCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (ttsCtx.state === 'suspended') ttsCtx.resume();
  } catch {}
  return ttsCtx;
}
function enqueueEleven(text) { elevenQueue.push(text); pumpEleven(); }
async function pumpEleven() {
  if (elevenPlaying) return;
  elevenPlaying = true;
  while (elevenQueue.length) {
    const text = elevenQueue.shift();
    try {
      const blob = await elevenTTS(text);
      await playBlob(blob);
    } catch (err) {
      // Quota gratuit épuisé (401) ou crédits finis → on bascule définitivement
      // sur la voix gratuite du navigateur pour le reste de la session.
      const quota = err.status === 401 || /quota|credit|exceed|unusual/i.test(err.message || '');
      if (quota) { elevenDisabled = true; toast('Quota ElevenLabs épuisé → voix gratuite activée 🔊'); }
      else toast('Voix premium : ' + err.message + ' → repli navigateur');
      browserSpeak(text);
    }
  }
  elevenPlaying = false;
}
async function elevenTTS(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${settings.elevenVoice}` +
              `?optimize_streaming_latency=3&output_format=mp3_44100_128`;
  const res = await fetchRetry(url, {
    method: 'POST',
    headers: { 'xi-api-key': settings.elevenKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: settings.elevenModel,
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
    }),
  });
  return res.blob();
}
function playBlob(blob) {
  return new Promise((resolve) => {
    blob.arrayBuffer()
      .then((arr) => ensureTtsCtx().decodeAudioData(arr))
      .then((audioBuf) => {
        const src = ttsCtx.createBufferSource();
        src.buffer = audioBuf; src.connect(ttsCtx.destination);
        markSpeaking(true);
        src.onended = () => { markSpeaking(false); resolve(); };
        src.start();
      })
      .catch(() => { markSpeaking(false); resolve(); });
  });
}

function loadVoices() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith('fr'));
  const sel = $('voice');
  sel.innerHTML = '';
  if (!voices.length) { sel.innerHTML = '<option>Voix française par défaut</option>'; return; }
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(o);
  }
  selectedVoice = voices.find((v) => v.voiceURI === settings.voiceURI) || voices[0];
  if (selectedVoice) sel.value = selectedVoice.voiceURI;
}
speechSynthesis.onvoiceschanged = loadVoices;

// ============================================================================
// 4. AFFICHAGE
// ============================================================================
const LANGS = {
  english: '🇬🇧 Anglais', french: '🇫🇷 Français', spanish: '🇪🇸 Espagnol',
  german: '🇩🇪 Allemand', italian: '🇮🇹 Italien', portuguese: '🇵🇹 Portugais',
  arabic: '🇸🇦 Arabe', russian: '🇷🇺 Russe', chinese: '🇨🇳 Chinois',
  japanese: '🇯🇵 Japonais', dutch: '🇳🇱 Néerlandais', polish: '🇵🇱 Polonais',
  turkish: '🇹🇷 Turc', korean: '🇰🇷 Coréen',
};
function isFrench(lang) { return (lang || '').includes('french') || (lang || '').startsWith('fr'); }

function badgeFor(language) { return LANGS[language] || (language ? '🌐 ' + language : '🌐'); }
function markSpeaking(on) { const el = document.querySelector('#subs .sub.latest'); if (el) el.classList.toggle('speaking', on); }

function addEntry({ language, original, french, skipped }) {
  const entry = { t: new Date(), language, original, french, skipped };
  convo.push(entry);
  renderSubs();
  appendHistory(entry);
  return entry;
}

// Écran principal : la dernière phrase en GROS + les précédentes en petit, fondu.
function renderSubs() {
  const subs = $('subs');
  const last = convo.slice(-4);
  if (!last.length) return;
  subs.innerHTML = last.map((e, i) => {
    const cls = 'sub' + (i === last.length - 1 ? ' latest' : '') + (e.skipped ? ' skip' : '');
    return `<div class="${cls}">` +
      `<div class="sub-badge">${badgeFor(e.language)}</div>` +
      `<div class="sub-fr">${highlightNums(escapeHtml(e.french))}</div>` +
      `<div class="sub-src">${escapeHtml(e.original)}</div></div>`;
  }).join('');
  subs.scrollTop = subs.scrollHeight;
}

// Onglet Historique : une carte par phrase (ajout incrémental).
function appendHistory(e) {
  const h = $('history');
  const empty = h.querySelector('.hint-empty'); if (empty) empty.remove();
  const hh = e.t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const div = document.createElement('div');
  div.className = 'h-card' + (e.skipped ? ' skip' : '');
  div.innerHTML =
    `<div class="h-top"><span class="h-badge">${badgeFor(e.language)}</span><span class="h-time">${hh}</span></div>` +
    `<div class="h-fr">${highlightNums(escapeHtml(e.french))}</div>` +
    `<div class="h-src">${escapeHtml(e.original)}</div>`;
  h.appendChild(div); h.scrollTop = h.scrollHeight;
}

// ============================================================================
// 4bis. ENREGISTREMENT SUR SUPABASE (clé publique intégrée — zéro config)
//  - une ligne par phrase : created_at, session, lang, original, french
//  - "session" = libellé enregistrement_<date>_<heure> qui change à chaque
//    changement d'heure OU après une longue pause (= nouveau contexte)
//  - protégé par les règles RLS Supabase (insertion seule via la clé anon)
// ============================================================================
function supabaseOn() { return !!(SUPABASE_URL && SUPABASE_ANON_KEY); }

function recordEntry({ t, language, original, french }) {
  if (!supabaseOn()) return;
  const hourKey = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}-${t.getHours()}`;
  const gapMs = rec.lastAt ? t - rec.lastAt : 0;
  if (!rec.session || hourKey !== rec.hourKey || gapMs > (settings.recGapMin || 8) * 60000) newSession(t);
  rec.lastAt = t; rec.hourKey = hourKey;
  const lang = (LANGS[language] || language || '').replace(/^\S+\s/, '').trim() || (language || '—');
  recQueue.push({ session: rec.session, lang, original, french, created_at: t.toISOString() });
  pumpRecord();
}

function newSession(t) {
  const p = (n) => String(n).padStart(2, '0');
  rec.session = `enregistrement_${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}_${p(t.getHours())}-${p(t.getMinutes())}`;
}

// Envoi séquentiel et résilient : si le réseau coupe, la ligne reste en tête de
// file et repartira au prochain appel → on ne perd jamais une phrase.
async function pumpRecord() {
  if (recPumping || !supabaseOn()) return;
  recPumping = true;
  while (recQueue.length) {
    try { await supabaseInsert(recQueue[0]); recQueue.shift(); setStatusDot(true); }
    catch (err) { setStatusDot(false); toast('Enregistrement : ' + err.message); break; }
  }
  recPumping = false;
}

function supabaseInsert(row) {
  return fetchRetry(`${SUPABASE_URL}/rest/v1/enregistrements`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
}

function openRecordings() {
  if (!supabaseOn()) { toast('Enregistrement Supabase pas encore configuré.'); return; }
  pumpRecord(); // tente d'envoyer ce qui reste en file
  const ref = (SUPABASE_URL.match(/https?:\/\/([^.]+)\./) || [])[1];
  window.open(ref ? `https://supabase.com/dashboard/project/${ref}/editor` : SUPABASE_URL, '_blank');
}
function highlightNums(s) { return s.replace(/(\d[\d  .,]*\d|\d)/g, '<b class="num">$1</b>'); }
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ============================================================================
// 5. UTILITAIRES AUDIO
// ============================================================================
function mergeFrames(frames) {
  let total = 0; for (const f of frames) total += f.length;
  const out = new Float32Array(total);
  let off = 0; for (const f of frames) { out.set(f, off); off += f.length; }
  return out;
}
function downsample(buffer, inRate, outRate) {
  if (outRate >= inRate) return buffer;
  const ratio = inRate / outRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  let oi = 0, bi = 0;
  while (oi < newLen) {
    const next = Math.round((oi + 1) * ratio);
    let acc = 0, n = 0;
    for (let i = bi; i < next && i < buffer.length; i++) { acc += buffer[i]; n++; }
    result[oi++] = n ? acc / n : 0;
    bi = next;
  }
  return result;
}
function encodeWAV(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

// ============================================================================
// 6. PETITS HELPERS UI / SYSTÈME
// ============================================================================
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function setStatus(cls, txt) { statusEl.className = 'status-text ' + cls; statusEl.textContent = txt; }
function setRecording(on) { recordBtn.classList.toggle('listening', on); }
function updateMeter(rms) { recordBtn.style.setProperty('--lvl', Math.min(1, rms * 6).toFixed(2)); }
function switchPage(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === name));
}
function setStatusDot(ok) { const b = $('btn-export'); if (b) b.style.color = ok ? 'var(--ok)' : ''; }
function updateQueue() {
  const n = sttQueue.length + (pumping ? 1 : 0);
  queueEl.textContent = n;
  queueEl.classList.toggle('active', n > 0);
}
let toastT;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 4000);
}
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (running && document.visibilityState === 'visible') requestWakeLock();
});

// ============================================================================
// 7. RÉGLAGES — lecture / écriture du formulaire
// ============================================================================
function openSettings() { switchPage('settings'); }
function fillForm() {
  $('groqKey').value = settings.groqKey;
  $('mistralKey').value = settings.mistralKey;
  $('provider').value = settings.provider;
  $('sttModel').value = settings.sttModel;
  $('groqModel').value = settings.groqModel;
  $('mistralModel').value = settings.mistralModel;
  $('ttsEngine').value = settings.ttsEngine;
  $('elevenKey').value = settings.elevenKey;
  $('elevenVoice').value = settings.elevenVoice;
  $('elevenModel').value = settings.elevenModel;
  $('recGap').value = settings.recGapMin; $('gapVal').textContent = settings.recGapMin;
  $('recStatus').textContent = supabaseOn() ? '✓ activé (Supabase)' : '— non configuré';
  $('recStatus').className = 'rec-status ' + (supabaseOn() ? 'ok' : '');
  $('rate').value = settings.rate; $('rateVal').textContent = settings.rate;
  $('sens').value = settings.sens; $('sensVal').textContent = settings.sens;
  $('speakEnabled').checked = settings.speakEnabled;
  syncProviderUI();
  syncTtsUI();
}
function readForm() {
  settings.groqKey = $('groqKey').value.trim();
  settings.mistralKey = $('mistralKey').value.trim();
  settings.provider = $('provider').value;
  settings.sttModel = $('sttModel').value;
  settings.groqModel = $('groqModel').value;
  settings.mistralModel = $('mistralModel').value;
  settings.ttsEngine = $('ttsEngine').value;
  settings.elevenKey = $('elevenKey').value.trim();
  settings.elevenVoice = $('elevenVoice').value;
  settings.elevenModel = $('elevenModel').value;
  settings.recGapMin = Number($('recGap').value);
  settings.rate = Number($('rate').value);
  settings.sens = Number($('sens').value);
  settings.speakEnabled = $('speakEnabled').checked;
  const v = $('voice').value;
  if (v) { settings.voiceURI = v; selectedVoice = speechSynthesis.getVoices().find((x) => x.voiceURI === v) || selectedVoice; }
  save();
}
function syncProviderUI() {
  const m = settings.provider === 'mistral';
  $('mistralKeyField').style.display = m ? '' : 'none';
  document.querySelectorAll('[data-provider]').forEach((el) => {
    el.style.display = el.getAttribute('data-provider') === settings.provider ? '' : 'none';
  });
}
function syncTtsUI() {
  document.querySelectorAll('[data-tts]').forEach((el) => {
    el.style.display = el.getAttribute('data-tts') === settings.ttsEngine ? '' : 'none';
  });
}

// ============================================================================
// 7ter. CONNEXION / PROFILS (clés chiffrées AES, déverrouillées par mot de passe)
// ============================================================================
let pendingProfile = null;

function fromB64(str) { const bin = atob(str); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function decryptProfile(blob, password) {
  const key = await deriveKey(password, fromB64(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.data));
  return JSON.parse(new TextDecoder().decode(pt));
}

function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }
function showLogin() { renderProfiles(); $('login').classList.remove('hidden'); }
function hideLogin() { $('login').classList.add('hidden'); }

function renderProfiles() {
  $('profiles').innerHTML = (window.PROFILES || []).map((p, i) =>
    `<button class="profile${p.blob ? '' : ' todo'}" data-i="${i}">` +
    `<span class="ava">${escapeHtml((p.name[0] || '?').toUpperCase())}</span>` +
    `<span class="pname">${escapeHtml(p.name)}</span></button>`
  ).join('');
}

function chooseProfile(i) {
  const p = (window.PROFILES || [])[i];
  if (!p) return;
  if (!p.blob) { toast('Profil « ' + p.name + ' » pas encore configuré.'); return; }
  pendingProfile = p;
  $('pwd-title').textContent = p.name;
  $('pwd-err').textContent = '';
  $('pwd-input').value = '';
  showModal('pwd');
  setTimeout(() => $('pwd-input').focus(), 60);
}

async function submitPassword() {
  if (!pendingProfile) return;
  const pw = $('pwd-input').value;
  if (!pw) return;
  try {
    const data = await decryptProfile(pendingProfile.blob, pw);
    Object.assign(settings, data);
    localStorage.setItem('tr_session', pendingProfile.name);
    save(); fillForm(); syncProviderUI(); syncTtsUI(); loadVoices();
    hideModal('pwd'); hideLogin(); switchPage('translate');
    toast('Bienvenue ' + pendingProfile.name + ' 👋');
  } catch {
    $('pwd-err').textContent = 'Mot de passe incorrect';
  }
}

function enterGuest() {
  localStorage.setItem('tr_session', 'invité');
  hideLogin(); switchPage('settings'); showModal('help');
}

function logout() {
  localStorage.removeItem('tr_session');
  settings = { ...DEFAULTS };     // on efface les clés/réglages de cet appareil
  save(); fillForm(); syncProviderUI(); syncTtsUI();
  showLogin();
}

// ============================================================================
// 8. ÉVÉNEMENTS
// ============================================================================
recordBtn.addEventListener('click', () => (running ? stop() : start()));

document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.mode-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  mode = b.dataset.mode;
  resetUtterance();
}));

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchPage(t.dataset.page)));
$('btn-save').addEventListener('click', () => { readForm(); toast('Réglages enregistrés ✓'); switchPage('translate'); });
$('provider').addEventListener('change', () => { settings.provider = $('provider').value; syncProviderUI(); });
$('ttsEngine').addEventListener('change', () => { settings.ttsEngine = $('ttsEngine').value; syncTtsUI(); });
$('rate').addEventListener('input', (e) => $('rateVal').textContent = e.target.value);
$('sens').addEventListener('input', (e) => $('sensVal').textContent = e.target.value);
$('voice').addEventListener('change', (e) => {
  selectedVoice = speechSynthesis.getVoices().find((x) => x.voiceURI === e.target.value) || selectedVoice;
});
$('testVoice').addEventListener('click', () => {
  readForm(); ensureTtsCtx();
  const phrase = 'Bonjour, ceci est un test de la voix française.';
  if (settings.ttsEngine === 'eleven' && settings.elevenKey) enqueueEleven(phrase);
  else browserSpeak(phrase);
});
$('btn-export').addEventListener('click', openRecordings);
$('recGap') && $('recGap').addEventListener('input', (e) => $('gapVal').textContent = e.target.value);
$('clear').addEventListener('click', () => {
  // efface l'écran et l'historique de session ; les enregistrements Supabase ne sont pas touchés
  convo.length = 0;
  $('history').innerHTML = '<div class="hint-empty"><p>Les phrases de la session apparaîtront ici.</p></div>';
  $('subs').innerHTML = '<div class="hint-empty"><p class="big">Prêt à traduire</p><p>Touche le bouton bleu et laisse la personne parler.</p></div>';
});

// ── Connexion ──
$('profiles').addEventListener('click', (e) => { const b = e.target.closest('.profile'); if (b) chooseProfile(Number(b.dataset.i)); });
$('guest-btn').addEventListener('click', enterGuest);
$('pwd-go').addEventListener('click', submitPassword);
$('pwd-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPassword(); });
$('help-groq').addEventListener('click', () => showModal('help'));
$('logout').addEventListener('click', logout);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => hideModal(b.dataset.close)));

// ───────────────────────────── Démarrage ───────────────────────────────────
fillForm();
loadVoices();
if (localStorage.getItem('tr_session')) {        // déjà connecté sur cet appareil
  hideLogin();
  if (!settings.groqKey) switchPage('settings');
} else {                                          // 1re fois / mémoire effacée → connexion
  showLogin();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
