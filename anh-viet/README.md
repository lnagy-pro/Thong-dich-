# Anh → Việt (web)

Interprète en direct, de l'anglais vers le vietnamien, avec Qwen (Alibaba Cloud Model Studio). Deuxième app du dépôt, à côté de Thông Dịch : même écoute, même découpage en phrases, sans la reconnaissance des voix. S'ouvre dans Safari sur iPhone, sans installation : https://lnagy-pro.github.io/Thong-dich-/anh-viet/

## Utilisation

1. Ouvrir la page, coller la clé API Qwen (Réglages › Vérifier et enregistrer), toucher le micro, parler anglais.
2. Chaque phrase s'affiche en vietnamien, en grand, avec l'anglais en dessous : dès que vous marquez une pause (1 s par défaut, réglable). Tournez l'écran vers la personne en face.
3. Si la personne répond en vietnamien, sa réponse est reconnue et laissée de côté. Le français est traduit aussi.
4. Pour l'ajouter à l'écran d'accueil : Partager › Sur l'écran d'accueil. L'app de l'écran d'accueil garde ses propres réglages : la clé s'y colle une fois.

## Clé Qwen

1. Créer un compte Alibaba Cloud international, puis ouvrir Model Studio dans la région **Singapour** (les nouveaux comptes y ont un quota gratuit pour chaque modèle, 90 jours).
2. Créer la clé : https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key (commence par `sk-`).
3. La coller dans Réglages › Clé API Qwen, puis « Vérifier et enregistrer » : l'app transcrit un court silence et traduit une phrase d'essai, et affiche les deux temps de réponse.

Une clé créée dans la région Pékin marche aussi : Réglages › Serveur Qwen › Pékin. Les clés ne passent pas d'une région à l'autre.

## Comment ça marche

- Le micro est découpé en phrases sur l'appareil (AudioWorklet, mêmes réglages que Thông Dịch : « Fin de phrase » et « Réplique longue »). Chaque phrase part en entier, dès qu'elle est coupée, dans sa propre requête : les phrases avancent en même temps, sans s'attendre, et rien n'est perdu entre deux.
- **Transcription** : Qwen3-ASR-Flash reçoit l'audio (WAV 16 kHz) et l'écrit. Par défaut il reconnaît la langue à chaque phrase (anglais, français, vietnamien…) ; « Toujours l'anglais » la fixe. Les nombres sont écrits en chiffres. Les « Noms et mots à bien reconnaître » lui sont donnés en contexte.
- **Traduction** : par défaut Qwen3.7 Flash, avec les 6 dernières phrases de la conversation pour garder le fil (pronoms, sujets, noms). « Soigné » : Qwen3.7 Plus. « Spécialisé » : Qwen-MT Flash, modèle de traduction pur (sans le fil). Si un modèle n'existe pas pour le compte ou la région, l'app passe au suivant de sa liste de secours (Qwen3.6 Flash, Qwen3.5 Flash…) et l'indique dans Infos techniques.
- **Pronoms** : le vietnamien choisit « je » et « tu » selon l'âge et la relation. Par défaut tôi / bạn (neutre, toujours poli) ; Réglages › Traduction propose em / anh, em / chị, chị / em, ou le choix de Qwen selon le contexte.
- Les phrases ne contenant que des hésitations (« um », « euh ») ou rien d'audible disparaissent. Dans une phrase mêlée, les morceaux déjà en vietnamien ne sont pas retraduits.
- Une erreur passagère (réseau, surcharge, trop de requêtes) est réessayée une fois ; une phrase restée en échec repart d'elle-même à la réponse suivante ou au retour du réseau, ou avec le bouton « Réessayer ».

## Appels à Qwen

- API « DashScope » de Model Studio, en JSON, sans streaming et sans en-tête particulier : `…/api/v1/services/aigc/multimodal-generation/generation` (Qwen3-ASR-Flash et les modèles Qwen3.5 et suivants) et `…/api/v1/services/aigc/text-generation/generation` (Qwen-MT). L'API compatible OpenAI de Model Studio, elle, n'envoie pas les en-têtes qui autorisent une page web à lire la réponse (CORS), d'après d'autres projets.
- Serveur : `dashscope-intl.aliyuncs.com` (Singapour, par défaut) ou `dashscope.aliyuncs.com` (Pékin). « Autre adresse » accepte l'adresse d'un espace de travail Model Studio (`…maas.aliyuncs.com`) ou d'un relais (`….workers.dev`).
- Si « Vérifier et enregistrer » répond que Qwen ne répond pas depuis cette page alors qu'internet marche, c'est que le serveur refuse les appels venant d'une page web : il faut alors un petit relais (Cloudflare Worker) dont l'adresse se met dans « Autre adresse ».
- Coût (tarifs Singapour) : la transcription coûte 0,000035 $ par seconde d'audio envoyée, soit environ 0,13 $ par heure de parole ; la traduction de chaque phrase coûte quelques centaines de jetons.
- La clé reste dans ce navigateur (localStorage, préfixe `av.`, à part de Thông Dịch) et n'est envoyée qu'à Alibaba Cloud. La politique de sécurité de la page n'autorise les connexions que vers `*.aliyuncs.com` et `*.workers.dev`.

## Infos techniques

Réglages › Infos techniques indique le modèle qui traduit, le serveur, l'audio, le gain du micro, le découpage en vigueur, et un journal des 8 dernières phrases : durée et parole entendue, raison de la coupure, temps de transcription (nombre de mots, langue reconnue) et de traduction, phrase laissée de côté et pourquoi, erreur. Rien n'en sort de l'appareil.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | L'app complète, générée par `build.py` |
| `src/app.js` | Interface, écoute, appels à Qwen |
| `src/dsp.js` | Traitement du son, copie de celui de Thông Dịch (`../src/dsp.js`) |
| `src/index.html`, `src/style.css` | Page et styles |
| `icon.png` | Icône (EN → VI) |

Après une modification : `python3 anh-viet/build.py` (Python 3 et Pillow), puis publier `anh-viet/index.html`.
