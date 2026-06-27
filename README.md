# 🎧 Traducteur IA — traduction vocale en temps réel

Une web-app **100 % gratuite, sans serveur**, qui écoute la personne en face de toi
(anglais, espagnol, allemand… détection automatique) et te restitue la traduction
**française en continu, dans tes écouteurs + à l'écran**.

```
🎤 micro  →  📝 Groq Whisper (transcription + langue)  →  🌍 traduction (Groq/Mistral)  →  🔊 voix FR + texte
```

- **Écoute non-stop** : le micro ne s'arrête jamais tant que tu n'appuies pas sur **Arrêter**,
  même pendant que la voix française parle. Les phrases sont mises en file et traduites dans l'ordre.
- **Latence ~1,5 à 3 s** après la fin de chaque phrase.
- **Deux modes** : *Phrase par phrase* (attend une pause, fiable — par défaut) ou *Continu (~3 s)* (plus réactif).
- **Voix premium par défaut** (ElevenLabs) avec **repli automatique** sur la voix gratuite du
  navigateur dès que le quota gratuit est épuisé.
- **Enregistrement automatique sur GitHub** : chaque conversation est sauvegardée dans un fichier
  `.txt` poussé sur ton dépôt (jamais sur le téléphone ni l'ordinateur). Voir §4.
- Tourne dans **Safari/Chrome**, s'installe via *« Ajouter à l'écran d'accueil »* → comme une vraie app.

> ⚠️ **Utilise des écouteurs.** Sinon le micro capte la voix française du haut-parleur.
> Un garde-fou ignore ce qui est détecté comme « déjà français », mais les écouteurs restent l'idéal.

---

## 1. Obtenir une clé API gratuite (2 min)

1. Va sur **https://console.groq.com/keys** → connecte-toi → **Create API Key** → copie la clé (`gsk_...`).
   - Groq offre un quota gratuit large : transcription Whisper **~8 h d'audio/jour** + traduction Llama.
2. *(Optionnel, pour une traduction encore plus soignée)* clé Mistral gratuite : **https://console.mistral.ai/api-keys**.

Tu peux **réutiliser la clé Groq de ton projet Média** : c'est la même.

## 2. Mettre en ligne sur GitHub Pages (gratuit)

1. Crée un dépôt GitHub (ex. `traducteur`) et pousse ce dossier.
2. Repo → **Settings → Pages** → *Build and deployment* → **Deploy from a branch** →
   branche `main`, dossier **`/docs`** → **Save**.
3. Au bout d'1 min, ton app est en ligne sur `https://<ton-pseudo>.github.io/traducteur/`.
   (HTTPS obligatoire pour le micro — GitHub Pages le fournit automatiquement.)

## 3. Utiliser sur iPhone

1. Ouvre l'URL dans **Safari**.
2. Onglet **Réglages** (en bas) → colle ta **clé Groq** → **Enregistrer**.
3. **Partager → « Sur l'écran d'accueil »** pour l'installer comme une app.
4. Onglet **Traduire**, branche tes **écouteurs**, touche le **bouton bleu**, autorise le micro. C'est parti 🎉

> Interface : 3 onglets en bas — **Traduire** (le bouton animé + la traduction en grand),
> **Historique** (les phrases de la session), **Réglages**. Thème clair, responsive tel + ordi.

---

## 4. Enregistrement des conversations (Supabase)

Les conversations sont enregistrées dans une **base Supabase dédiée au Traducteur** (distincte de
Média). **L'utilisateur ne saisit RIEN** : la clé publique `anon` est intégrée à l'app (`docs/config.js`).
Rien n'est jamais stocké sur le téléphone ni l'ordinateur.

**Mise en place (une seule fois) :**
1. Crée un **nouveau projet Supabase** (https://supabase.com → *New project*), ex. `traducteur`.
2. Crée la table et la règle d'insertion — *SQL Editor* → colle puis *Run* :
   ```sql
   create table public.enregistrements (
     id          bigint generated always as identity primary key,
     created_at  timestamptz not null default now(),
     session     text,
     lang        text,
     original    text,
     french      text
   );
   alter table public.enregistrements enable row level security;
   -- la clé anon publique peut UNIQUEMENT insérer (pas lire) → conversations privées
   create policy "insert anon" on public.enregistrements
     for insert to anon with check (true);
   ```
3. *Project Settings → API* → copie **Project URL** et **anon public**, et mets-les dans
   `docs/config.js` (`window.SUPABASE_URL` et `window.SUPABASE_ANON_KEY`), puis pousse sur GitHub.

**Fonctionnement :**
- **Une ligne par phrase** : `created_at`, `session`, `lang`, `original`, `french`.
- `session` = un libellé `enregistrement_AAAA-MM-JJ_HH-MM` qui **change automatiquement** à chaque
  changement d'heure ou après une **pause** (= nouveau contexte ; durée réglable, défaut 8 min).
- Envoi en continu + résilient (si le réseau coupe, la phrase repart ensuite). Le bouton **📼**
  ouvre tes enregistrements dans le tableau Supabase.
- 🔒 La clé anon ne peut **qu'insérer**, pas relire → même publique, personne ne peut lire tes
  conversations avec. Toi, tu les consultes dans le tableau Supabase (connecté).
- Tant que `config.js` est vide → aucun enregistrement (l'app marche quand même pour la traduction).

## 5. Écran de connexion & profils (clés chiffrées)

À la première ouverture (ou si la mémoire du navigateur est effacée), un **écran de connexion**
s'affiche : on choisit un **profil** (Hugo, Julia, Erwan, Caroline) ou **Invité**.

- **Profils** : chacun a ses clés API **chiffrées** (AES-256, PBKDF2) déverrouillées par un
  **mot de passe**. Les clés n'apparaissent **jamais en clair** — ni dans le code, ni à l'écran —
  et les robots/GitHub ne trouvent rien d'exploitable.
- **Invité** : on colle ses propres clés, avec un bouton **« ? »** qui ouvre un guide pour obtenir
  une clé Groq gratuite.
- **Changer de profil** : bouton en bas des Réglages (efface les clés de l'appareil, revient à la connexion).

### Créer / modifier un profil (toi uniquement)
1. Ouvre **`/setup.html`** (ex. `https://hugokrvl.github.io/traducteur/setup.html`).
2. Entre le **nom**, un **mot de passe**, la **clé Groq** (+ ElevenLabs / Mistral si besoin).
3. Clique **Générer** → copie la ligne produite.
4. Colle-la dans `docs/profiles.js` à la place de l'entrée du même nom, puis pousse sur GitHub.

> Tes clés sont chiffrées **dans ton navigateur** par `setup.html` : elles ne transitent nulle part.
> Un profil non configuré (`blob: null`) s'affiche grisé « à configurer ».

## Réglages utiles (⚙️ → Options avancées)

| Réglage | À quoi ça sert |
|---|---|
| **Moteur de traduction** | Groq Llama (le plus rapide) ou Mistral (qualité). |
| **Modèle de transcription** | `turbo` = plus rapide ; `large-v3` = un peu plus précis. |
| **Voix française** | Choix de la voix iOS/navigateur lue dans les écouteurs. |
| **Vitesse de lecture** | Accélère/ralentit la voix. |
| **Sensibilité du micro** | Plus haut = capte les voix faibles (mais aussi plus de bruit). |

---

## Comment ça marche (technique)

Tout est **côté navigateur** (`docs/`), aucun backend :

- `app.js` capture le micro en continu (Web Audio + `ScriptProcessor`), détecte les
  pauses (VAD maison) pour découper en phrases, ré-échantillonne en WAV 16 kHz.
- Chaque phrase part chez **Groq Whisper** (`/openai/v1/audio/transcriptions`,
  `verbose_json` → texte **+ langue détectée**).
- Le texte est traduit en français via l'API chat **Groq** ou **Mistral** (compatibles OpenAI).
- La traduction est lue soit par **ElevenLabs** (voix premium, repli auto sur le navigateur si quota
  épuisé), soit par `speechSynthesis` (voix du système, gratuite), puis affichée à l'écran.
- Les conversations sont poussées sur GitHub via l'**API Contents** (`PUT …/contents/{path}` avec un token).
- Toutes les clés/tokens sont stockés **uniquement sur l'appareil** (`localStorage`) et envoyés
  seulement à leurs services respectifs (Groq, Mistral, ElevenLabs, GitHub).

### Limites connues
- iOS met parfois la synthèse vocale en pause si l'app passe en arrière-plan (garde l'écran allumé — un *Wake Lock* est demandé).
- En mode continu, une phrase peut être coupée entre deux tranches de 3 s (c'est le compromis réactivité).
- Le débit dépend des quotas gratuits Groq/Mistral (largement suffisants pour une conversation).
