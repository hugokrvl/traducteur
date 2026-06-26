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
2. Appuie sur **⚙️** → colle ta **clé Groq** → **Enregistrer**.
3. **Partager → « Sur l'écran d'accueil »** pour l'installer comme une app.
4. Branche tes **écouteurs**, appuie sur **Démarrer**, autorise le micro. C'est parti 🎉

---

## 4. Enregistrement des conversations sur GitHub

Les conversations sont sauvegardées **uniquement sur GitHub** (jamais sur le téléphone/ordinateur),
exactement comme la logique du projet Média (push via l'API GitHub avec un token).

> 🔒 **Confidentialité — important.** Le dépôt `traducteur` (celui de l'app) est **public**
> car GitHub Pages gratuit l'exige. **Ne mets PAS tes enregistrements dans un dépôt public.**
> Crée un **dépôt PRIVÉ séparé** (ex. `traducteur-prive`) réservé aux conversations.

**Mise en place :**
1. Crée un **dépôt PRIVÉ** sur GitHub, ex. `hugokrvl/traducteur-prive`.
2. Crée un **token fine-grained** : https://github.com/settings/tokens?type=beta →
   *Generate new token* → **Repository access : Only select repositories** → choisis `traducteur-prive` →
   *Permissions → Repository permissions → **Contents : Read and write*** → génère et copie le token.
3. Dans l'app : ⚙️ → section **📼 Enregistrement sur GitHub** → colle le **token**, le **dépôt**
   (`hugokrvl/traducteur-prive`) et le **dossier** (`enregistrements`) → Enregistrer.

**Fonctionnement :**
- Un fichier `enregistrements/enregistrement_AAAA-MM-JJ_HH-MM.txt` par session.
- **Nouveau fichier automatiquement** quand l'**heure change** ou après une **pause** (= nouveau
  contexte ; durée réglable dans Options avancées, défaut 8 min).
- Sauvegarde en continu (toutes les ~12 s) + à chaque arrêt. Le bouton **📼** force une sauvegarde
  et ouvre le dossier des enregistrements sur GitHub.
- **Aucun token = aucun enregistrement** (rien n'est jamais stocké en local).

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
