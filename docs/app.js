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
  githubToken: '',
  githubRepo: '',
  githubFolder: 'enregistrements',
  githubBranch: 'main',
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
// Enregistrement sur GitHub (aucune copie locale)
const shaMap = {};                 // chemin de fichier → sha du dernier commit
let rec = { path: null, content: '', hourKey: null, lastAt: 0 };
let recTimer = null, recDirty = false;
let flushChain = Promise.resolve();
const REC_DEBOUNCE = 12000;

// ───────────────────────────── Raccourcis DOM ──────────────────────────────
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const meterEl = $('meter');
const transcriptEl = $('transcript');
const queueEl = $('queue');
const recordBtn = $('record');

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
  setStatus('idle', sttQueue.length ? 'traitement…' : 'prêt');
  meterEl.style.width = '0%';
  flush(); // sauvegarde finale de l'enregistrement sur GitHub
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
      if (isFrench(language)) { addBubble({ language, original: text, french: text, skipped: true }); continue; }

      const french = await translate(text, language);
      const bubble = addBubble({ language, original: text, french });
      recordEntry({ t: new Date(), language, original: text, french });
      speak(french, bubble);
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
function speak(text, bubbleEl) {
  if (!settings.speakEnabled || !text) return;
  if (settings.ttsEngine === 'eleven' && settings.elevenKey && !elevenDisabled) enqueueEleven(text, bubbleEl);
  else browserSpeak(text, bubbleEl);
}

// ── Voix du navigateur (gratuite, instantanée) ──
function browserSpeak(text, bubbleEl) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'fr-FR';
  if (selectedVoice) u.voice = selectedVoice;
  u.rate = Number(settings.rate) || 1.05;
  u.onstart = () => bubbleEl && bubbleEl.classList.add('speaking');
  u.onend = () => bubbleEl && bubbleEl.classList.remove('speaking');
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
function enqueueEleven(text, bubbleEl) { elevenQueue.push({ text, bubbleEl }); pumpEleven(); }
async function pumpEleven() {
  if (elevenPlaying) return;
  elevenPlaying = true;
  while (elevenQueue.length) {
    const { text, bubbleEl } = elevenQueue.shift();
    try {
      const blob = await elevenTTS(text);
      await playBlob(blob, bubbleEl);
    } catch (err) {
      // Quota gratuit épuisé (401) ou crédits finis → on bascule définitivement
      // sur la voix gratuite du navigateur pour le reste de la session.
      const quota = err.status === 401 || /quota|credit|exceed|unusual/i.test(err.message || '');
      if (quota) { elevenDisabled = true; toast('Quota ElevenLabs épuisé → voix gratuite activée 🔊'); }
      else toast('Voix premium : ' + err.message + ' → repli navigateur');
      browserSpeak(text, bubbleEl);
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
function playBlob(blob, bubbleEl) {
  return new Promise((resolve) => {
    blob.arrayBuffer()
      .then((arr) => ensureTtsCtx().decodeAudioData(arr))
      .then((audioBuf) => {
        const src = ttsCtx.createBufferSource();
        src.buffer = audioBuf; src.connect(ttsCtx.destination);
        bubbleEl && bubbleEl.classList.add('speaking');
        src.onended = () => { bubbleEl && bubbleEl.classList.remove('speaking'); resolve(); };
        src.start();
      })
      .catch(() => { bubbleEl && bubbleEl.classList.remove('speaking'); resolve(); });
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

function addBubble({ language, original, french, skipped }) {
  if (transcriptEl.querySelector('.empty-state')) transcriptEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'bubble' + (skipped ? ' skipped' : '');
  const badge = LANGS[language] || (language ? '🌐 ' + language : '🌐');
  div.innerHTML =
    `<div class="src"><span class="lang-badge">${badge}</span></div>` +
    `<p class="original">${escapeHtml(original)}</p>` +
    `<p class="french">${highlightNums(escapeHtml(french))}</p>`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return div;
}

// ============================================================================
// 4bis. ENREGISTREMENT SUR GITHUB (jamais de copie locale)
//  - un fichier .txt par session, nommé enregistrement_<date>_<heure>.txt
//  - nouveau fichier quand l'heure change OU après une longue pause (= nouveau contexte)
//  - poussé sur le dépôt GitHub via l'API Contents (logique « comme Média »)
// ============================================================================
function recordingOn() {
  return !!(settings.githubToken && settings.githubRepo && settings.githubRepo.includes('/'));
}

function recordEntry({ t, language, original, french }) {
  if (!recordingOn()) return;
  const hourKey = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}-${t.getHours()}`;
  const gapMs = rec.lastAt ? t - rec.lastAt : 0;
  const newFile = !rec.path || hourKey !== rec.hourKey || gapMs > (settings.recGapMin || 8) * 60000;
  if (newFile) startNewFile(t);
  const hh = t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const lang = (LANGS[language] || language || '').replace(/^\S+\s/, '').trim() || '—';
  rec.content += `[${hh}] ${lang} : ${original}\n→ ${french}\n\n`;
  rec.lastAt = t; rec.hourKey = hourKey; recDirty = true;
  clearTimeout(recTimer); recTimer = setTimeout(() => flush(), REC_DEBOUNCE);
}

function startNewFile(t) {
  if (rec.path && recDirty) flush();           // on sauve d'abord l'ancien fichier en entier
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}_${p(t.getHours())}-${p(t.getMinutes())}`;
  const folder = (settings.githubFolder || 'enregistrements').replace(/^\/+|\/+$/g, '');
  rec.path = (folder ? folder + '/' : '') + `enregistrement_${stamp}.txt`;
  rec.content = `Traducteur IA — enregistrement du ${t.toLocaleString('fr-FR')}\n\n`;
}

// Sauve le fichier courant EN ENTIER sur GitHub. Sérialisé (flushChain) pour ne
// jamais avoir deux PUT concurrents sur le même fichier (sha périmé = 409).
function flush(manual) {
  if (!recDirty || !rec.path || !recordingOn()) { if (manual) toast('Rien à enregistrer.'); return flushChain; }
  recDirty = false; clearTimeout(recTimer);
  const path = rec.path, content = rec.content;  // snapshot synchrone (avant tout await)
  flushChain = flushChain
    .then(() => githubPut(path, content))
    .then(() => { setStatusDot(true); if (manual) toast('Enregistré sur GitHub ✓'); })
    .catch((err) => { recDirty = true; setStatusDot(false); toast('GitHub : ' + err.message); });
  return flushChain;
}

async function githubPut(path, content) {
  const [owner, repo] = settings.githubRepo.split('/');
  const branch = settings.githubBranch || 'main';
  // 'main' = branche par défaut → on NE l'envoie PAS : GitHub utilise (ou crée) la branche
  // par défaut tout seul, ce qui marche même sur un dépôt vide. On ne force la branche
  // que si l'utilisateur en a configuré une autre.
  const custom = branch && branch !== 'main';
  const enc = path.split('/').map(encodeURIComponent).join('/');
  const base = `https://api.github.com/repos/${owner}/${repo}/contents/${enc}`;
  const headers = { Authorization: 'Bearer ' + settings.githubToken, Accept: 'application/vnd.github+json' };
  if (shaMap[path] === undefined) {              // le fichier existe-t-il déjà ? (récupère son sha)
    try { const g = await fetch(base + (custom ? `?ref=${branch}` : ''), { headers }); shaMap[path] = g.ok ? (await g.json()).sha : null; }
    catch { shaMap[path] = null; }
  }
  const body = { message: 'enregistrement ' + path.split('/').pop(), content: utf8ToB64(content) };
  if (custom) body.branch = branch;
  if (shaMap[path]) body.sha = shaMap[path];
  const res = await fetch(base, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    if (res.status === 409 || res.status === 422) delete shaMap[path];  // sha périmé → re-découverte
    let m = res.status + ''; try { m = (await res.json()).message || m; } catch {}
    throw new Error(m);
  }
  shaMap[path] = (await res.json()).content?.sha || null;
}
function utf8ToB64(s) { return btoa(unescape(encodeURIComponent(s))); }

function openRecordings() {
  if (!recordingOn()) { openSettings(); toast('Ajoute ton token + dépôt GitHub dans les réglages ⚙️'); return; }
  flush(true);
  const [owner, repo] = settings.githubRepo.split('/');
  const folder = (settings.githubFolder || 'enregistrements').replace(/^\/+|\/+$/g, '');
  window.open(`https://github.com/${owner}/${repo}/tree/${settings.githubBranch || 'main'}/${folder}`, '_blank');
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
function setStatus(cls, txt) { statusEl.className = 'status ' + cls; statusEl.textContent = txt; }
function setRecording(on) {
  recordBtn.classList.toggle('on', on);
  recordBtn.querySelector('.rec-label').textContent = on ? 'Arrêter' : 'Démarrer';
}
function updateMeter(rms) { meterEl.style.width = Math.min(100, rms * 600) + '%'; }
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
function openSettings() { $('settings').classList.remove('hidden'); }
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
  $('githubToken').value = settings.githubToken;
  $('githubRepo').value = settings.githubRepo;
  $('githubFolder').value = settings.githubFolder;
  $('recGap').value = settings.recGapMin; $('gapVal').textContent = settings.recGapMin;
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
  settings.githubToken = $('githubToken').value.trim();
  settings.githubRepo = $('githubRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  settings.githubFolder = $('githubFolder').value.trim() || 'enregistrements';
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
// 8. ÉVÉNEMENTS
// ============================================================================
recordBtn.addEventListener('click', () => (running ? stop() : start()));

document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.mode-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  mode = b.dataset.mode;
  resetUtterance();
}));

$('btn-settings').addEventListener('click', () => $('settings').classList.toggle('hidden'));
$('btn-save').addEventListener('click', () => { readForm(); $('settings').classList.add('hidden'); toast('Réglages enregistrés ✓'); });
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
  // efface seulement l'écran ; l'enregistrement GitHub n'est pas touché
  transcriptEl.innerHTML = '<div class="empty-state"><p>🎙️ Prêt. Appuie sur Démarrer.</p></div>';
});

// ───────────────────────────── Démarrage ───────────────────────────────────
fillForm();
loadVoices();
if (!settings.groqKey) openSettings();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
