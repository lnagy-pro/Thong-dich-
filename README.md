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
2. Chaque réplique s'affiche entière, traduite, avec une lettre de couleur par personne (A, B, C…) : dès que la personne marque une vraie pause (1 s par défaut, réglable), ou dès qu'une autre personne prend la parole. L'anglais et le français ne sont pas traduits.
3. Micro : celui de l'iPhone entend les voix autour de soi. Poser le téléphone entre les personnes, le bas (où est le micro) tourné vers elles. Les micros des AirPods visent la bouche de la personne qui les porte et entendent mal les autres.
4. Réglages › Infos techniques indique l'état de l'écoute, la connexion à Gemini, l'audio, le gain du micro, le découpage en vigueur, la reconnaissance des voix, et un journal des 8 dernières répliques : durée et parole entendue, raison de la coupure, temps de transcription et de traduction, réponse vide (avec la forme de la réponse reçue), réécoute par Flash, erreur. Rien n'en sort de l'appareil.

## Trois modes d'écoute

Chaque réplique part dans sa propre requête, dès qu'elle est coupée : les répliques, d'une même personne ou de plusieurs, avancent toutes en même temps, sans s'attendre, et rien n'est perdu entre deux.

- **Phrase par phrase (par défaut)** : l'app découpe la conversation en répliques, bout à bout, sans trou entre elles. Chaque réplique part en entier vers Gemini 3.5 Transcribe (`generateContent`, audio WAV 16 kHz dans la requête, avec une liste de mots du Centre, du Sud et le prénom Léa), qui l'écrit mot à mot ; le texte est ensuite traduit par Gemini Flash. Langues attendues : vietnamien, anglais et français (ces deux-là bien écrits, pour être laissés de côté par la traduction plutôt que pris pour du vietnamien).
  - Une réplique se termine à une vraie pause, ou **dès qu'une autre voix prend la parole** : toutes les 0,75 s, l'empreinte vocale de la dernière 1,5 s de parole est calculée sur l'appareil, et deux fenêtres d'une autre voix suffisent (≈ 2 s) pour envoyer la réplique précédente, coupée au moment le plus calme entre les deux voix. Sans attendre de pause, donc, même quand les gens enchaînent.
  - La parole est repérée par rapport au bruit de fond des 10 dernières secondes : une réponse plus faible qui suit une voix forte est entendue tout de suite.
  - Gemini 3.5 Transcribe range le texte dans une partie à part de sa réponse (`audioTranscription`), la partie `text` restant vide : c'est elle que l'app lit (la 2.4 lisait `text`, d'où des transcriptions toujours vides).
  - Limites : Gemini 3.5 Transcribe en a de basses au palier 1 de Google (facturation activée, moins de 100 $ dépensés) : 10 requêtes par minute sur le compte de test, et le forum de Google signale aussi 100 par jour. Au-delà, chaque réplique part directement à Gemini Flash, qui transcrit et traduit d'un coup. L'app retient la limite donnée par le premier refus (429) et n'envoie plus à Transcribe que ce qu'il accepte. La limite par jour se remet à zéro à minuit, heure de Californie (15 h à Saigon en hiver, 14 h en été). Réglages › Infos techniques › Transcribe montre où on en est.
  - Une réplique refusée pour une limite, ou trop longue à revenir (plus de 8 s environ), est reprise par Flash tout de suite : aucune ne reste en échec.
  - Filet de sécurité : si la transcription revient vide alors qu'on a nettement entendu parler (1 s de parole ou plus), Gemini Flash réécoute la réplique. S'il y entend des mots deux fois de suite, la suite de l'écoute passe par extraits. Si le modèle est refusé ou introuvable, aussi. Si une option est refusée, l'app retire celle que désigne l'erreur (sinon le français, puis la liste de mots).
- **Par extraits** : même découpage (pauses et changements de voix). Chaque réplique part en audio au modèle choisi dans Réglages › Traduction, qui transcrit et traduit d'un coup : une étape de moins.
- **En direct** : le micro part en continu vers Gemini 3.5 Transcribe Live (WebSocket), qui écrit le vietnamien pendant qu'on parle. L'app découpe les phrases et l'indique au serveur (activité manuelle : `activityStart` / `activityEnd`), la détection de parole de Google étant coupée. Plus réactif, mais le serveur peut manquer le début d'une phrase juste après une pause.
  - Les sessions durent 10 minutes au plus : la suivante s'ouvre avant et prend le relais entre deux phrases. En cas de coupure réseau, l'audio est gardé et renvoyé.
  - Si le serveur refuse ces options, l'app retire d'abord la liste de mots, puis revient à la détection de Google (les morceaux qu'elle renvoie sont alors regroupés par phrase). Elle y revient aussi si le serveur ne répond à aucune phrase.
  - Si le direct est indisponible, l'app passe par extraits ; l'audio pas encore transcrit repart avec la phrase suivante.

Réglages › Infos techniques indique le mode utilisé, et pourquoi il a changé le cas échéant.

## Traduction

- La traduction part du principe que c'est une conversation orale entre personnes présentes : français parlé, qui suit le fil de la discussion.
- Elle reçoit le fil de la conversation : les 6 phrases précédentes (3 minutes au plus), transcrites, avec leur traduction si elle est prête et la lettre de la personne qui parle.
- Le prénom Léa, prononcé « Lia », est connu de la transcription et de la traduction : il n'est pas pris pour un mot vietnamien.

## Découpage des phrases (Réglages)

Deux réglettes, valables dans les trois modes. Elles s'appliquent tout de suite, même pendant l'écoute, phrase en cours comprise, sans la couper.

| Réglette | Effet | Par défaut | Plage |
|---|---|---|---|
| **Fin de phrase** | silence après lequel la phrase part ; une hésitation plus courte reste dans la même phrase | 1,0 s | 0,3 à 2 s |
| **Réplique longue** | passé cette durée de parole, la phrase part à la première petite pause, au plus tard au double | 6 s (12 s au plus) | 3 à 15 s |

Quand une autre voix prend la parole, la phrase part sans attendre, quels que soient ces réglages. « Valeurs par défaut » remet 1,0 s et 6 s.

## Voix lointaines

Le micro est pris brut, sans le traitement d'iOS (qui vise la voix de la personne qui tient le téléphone). Une voix à deux ou trois mètres arrive donc 20 à 30 dB plus bas qu'une voix collée au micro.

- **Dans les trois modes** : tout le son de chaque phrase est transcrit, sans tri par la détection de Google. Un gain automatique ramène la parole vers un niveau constant avant l'envoi, jusqu'à +30 dB. Il ne suit que la parole : figé pendant les silences, il ne fait pas monter le bruit. Il baisse tout de suite sur une voix forte, et un limiteur doux évite la saturation. Une voix faible qui répond à une voix forte est remontée en moins d'une seconde de parole.
- Chaque phrase est en plus normalisée avant l'envoi (×16 au plus).

## Confidentialité

- La clé reste dans le navigateur et n'est envoyée qu'à Google (en-tête HTTPS, ou paramètre de la connexion WebSocket du mode en direct). La page n'autorise aucune autre connexion (CSP stricte), hormis le chargement du moteur ONNX depuis jsDelivr quand le dossier `ort/` est absent.
- La reconnaissance des voix tourne sur l'appareil : rien n'est envoyé pour elle. Une ligne partie avant que les empreintes de sa voix soient prêtes est colorée dès qu'elles arrivent ; l'empreinte de la phrase entière (plus longue à calculer, et qui fait attendre le suivi des voix) n'est calculée qu'à défaut, après 2,5 s.
- Pour verrouiller la clé : la restreindre dans Google Cloud au site de la page et à la Generative Language API.

## Organisation du dépôt

| Dossier | Contenu |
|---|---|
| `src/` | Sources de la web app : `dsp.js` (son : rééchantillonnage, découpage des phrases, gain automatique, chaîne du micro), `voice.js` (reconnaissance des voix), `app.js`, `style.css`, `index.html` |
| `build.py` | Assemble `index.html` à partir de `src/` |
| `ios/` | L'app iPhone native (SwiftUI) d'origine. Son prompt (`TranslationPrompt.swift`) et son icône servent aussi à la web app |

## Développement

Modifier `src/`, puis `python3 build.py` (Python 3 avec Pillow) : il assemble `index.html`, y intègre le prompt de `ios/ThongDich/TranslationPrompt.swift` et l'icône, et calcule les empreintes de la CSP. Publier `index.html` avec le reste.

## Licences

- Modèle de voix : CAM++ de [3D-Speaker](https://github.com/modelscope/3D-Speaker) (Apache 2.0), version ONNX de [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), quantifiée en int8 (voir `LICENSE-voix.txt`).
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.22.0 (MIT, voir `ort/LICENSE`).
