# Thông Dịch (web)

Interprète en direct, vietnamien du Centre vers le français, avec Gemini. S'ouvre dans Safari sur iPhone, sans installation : https://lnagy-pro.github.io/Thong-dich-/

## Fichiers publiés

| Fichier | Rôle |
|---|---|
| `index.html` | L'app complète (interface, traitement du son, appels à Gemini), générée par `build.py` |
| `voix.onnx` | Modèle de reconnaissance des voix (une couleur par personne), 8,6 Mo |
| `ort/` | Moteur ONNX Runtime Web pour ce modèle. S'il manque, l'app le charge depuis jsDelivr |

## Utilisation

1. Ouvrir la page, coller la clé API Gemini (Réglages), toucher le micro.
2. Le vietnamien s'écrit en direct pendant qu'on parle ; à chaque pause, la phrase s'affiche traduite, avec une lettre de couleur par personne (A, B, C…). L'anglais et le français ne sont pas traduits.
3. Micro : celui de l'iPhone entend les voix autour de soi. Poser le téléphone entre les personnes, le bas (où est le micro) tourné vers elles. Les micros des AirPods visent la bouche de la personne qui les porte et entendent mal les autres.
4. Réglages › Infos techniques indique l'état de l'écoute, la connexion à Gemini, l'audio, le gain du micro et la reconnaissance des voix.

## Deux modes d'écoute

- **Continue (par défaut)** : le micro part en continu vers Gemini 3.5 Transcribe Live (WebSocket, PCM 16 kHz), qui transcrit au fil de la parole. Chaque phrase finale est traduite en texte par Gemini Flash, avec le contexte des phrases précédentes. Les sessions durent 10 minutes au plus : la suivante s'ouvre avant, sans coupure ; en cas de coupure réseau, l'audio est gardé et renvoyé.
- **Par extraits** : l'ancien mode. L'app découpe la parole en phrases et envoie chaque extrait audio à Gemini, qui transcrit et traduit d'un coup. Utilisé automatiquement si l'écoute continue est refusée.

## Voix lointaines

Le micro est pris brut, sans le traitement d'iOS (qui vise la voix de la personne qui tient le téléphone). Une voix à deux ou trois mètres arrive donc 20 à 30 dB plus bas qu'une voix collée au micro.

- **Écoute continue** : un gain automatique ramène la parole vers un niveau constant avant l'envoi, jusqu'à +30 dB. Il ne suit que la parole : figé pendant les silences, il ne fait pas monter le bruit. Il baisse tout de suite sur une voix forte, et un limiteur doux évite la saturation. Une voix faible qui répond à une voix forte est remontée en moins d'une seconde de parole.
- **Par extraits** : chaque phrase est normalisée avant l'envoi (×16 au plus).

## Confidentialité

- La clé reste dans le navigateur et n'est envoyée qu'à Google (en-tête HTTPS, ou paramètre de la connexion WebSocket de l'écoute continue). La page n'autorise aucune autre connexion (CSP stricte), hormis le chargement du moteur ONNX depuis jsDelivr quand le dossier `ort/` est absent.
- La reconnaissance des voix tourne sur l'appareil : rien n'est envoyé pour elle.
- Pour verrouiller la clé : la restreindre dans Google Cloud au site de la page et à la Generative Language API.

## Organisation du dépôt

| Dossier | Contenu |
|---|---|
| `src/` | Sources de la web app : `dsp.js` (son : rééchantillonnage, découpage, gain automatique), `voice.js` (reconnaissance des voix), `app.js`, `style.css`, `index.html` |
| `build.py` | Assemble `index.html` à partir de `src/` |
| `ios/` | L'app iPhone native (SwiftUI) d'origine. Son prompt (`TranslationPrompt.swift`) et son icône servent aussi à la web app |

## Développement

Modifier `src/`, puis `python3 build.py` (Python 3 avec Pillow) : il assemble `index.html`, y intègre le prompt de `ios/ThongDich/TranslationPrompt.swift` et l'icône, et calcule les empreintes de la CSP. Publier `index.html` avec le reste.

## Licences

- Modèle de voix : CAM++ de [3D-Speaker](https://github.com/modelscope/3D-Speaker) (Apache 2.0), version ONNX de [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), quantifiée en int8 (voir `LICENSE-voix.txt`).
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.22.0 (MIT, voir `ort/LICENSE`).
