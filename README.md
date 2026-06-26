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
- La traduction est lue par `speechSynthesis` (voix du système, gratuite, instantanée) et affichée.
- La clé API est stockée **uniquement sur l'appareil** (`localStorage`) et n'est envoyée qu'à Groq/Mistral.

### Limites connues
- iOS met parfois la synthèse vocale en pause si l'app passe en arrière-plan (garde l'écran allumé — un *Wake Lock* est demandé).
- En mode continu, une phrase peut être coupée entre deux tranches de 3 s (c'est le compromis réactivité).
- Le débit dépend des quotas gratuits Groq/Mistral (largement suffisants pour une conversation).
