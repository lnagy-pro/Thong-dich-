# Thông Dịch — interprète vietnamien (Centre) → français

App iPhone native (SwiftUI, iOS 18+, conçue pour iPhone 16 et suivants). Elle écoute en continu, découpe la parole en phrases et affiche chaque phrase transcrite et traduite par Gemini, en direct.

## Installation (≈ 10 min)

1. **Clé Gemini** : créer une clé sur https://aistudio.google.com/apikey et **activer la facturation** sur son projet Google. Sans facturation, les quotas gratuits ne suffisent pas pour une conversation continue, et Google peut utiliser les données envoyées pour améliorer ses produits. Recommandé : restreindre la clé à « Generative Language API » et poser une alerte budgétaire.
2. **Ouvrir** `ThongDich.xcodeproj` avec Xcode 16 ou 26.
3. **Signature** : cible *ThongDich* › *Signing & Capabilities* › *Team*, choisir son compte Apple. Si l'identifiant `fr.perso.thongdich` est refusé, le remplacer (par ex. `fr.monnom.thongdich`).
4. **iPhone** : le brancher, activer le *Mode développeur* (Réglages › Confidentialité et sécurité), le choisir comme destination, puis ⌘R. Au premier lancement : Réglages › Général › VPN et gestion de l'appareil › faire confiance au développeur.
5. **Premier lancement** : coller la clé API, valider.
6. **Bouton Action (recommandé)** : Réglages iOS › Bouton Action › Raccourci › Thông Dịch › « Écouter ». Une pression ouvre l'app et lance l'écoute.

Avec un compte Apple gratuit, l'app doit être réinstallée depuis Xcode tous les 7 jours. Avec un compte développeur payant, la signature dure un an.

## Utilisation

- **Gros bouton** : écouter / arrêter (il passe au rouge pendant l'écoute). L'écoute continue écran verrouillé.
- Chaque phrase apparaît : **traduction française en gras**, vietnamien en dessous (masquable dans les réglages).
- Remonter dans la conversation fige l'affichage ; le bouton « En direct » y revient.
- **Micro** : celui de l'iPhone capte bien mieux les voix environnantes. Tenir le téléphone tourné vers les personnes qui parlent. Les AirPods sont possibles (réglage *Micro*), mais leurs micros visent la voix de la personne qui les porte.

## Pourquoi c'est rapide

- **Écoute et traduction indépendantes.** Le découpage en phrases se fait sur l'iPhone, sur le thread audio, sans jamais attendre le réseau. Chaque phrase part aussitôt vers Gemini, en parallèle des précédentes : rien n'est perdu pendant qu'une traduction est en cours.
- **Une phrase = un seul appel.** L'audio et la consigne partent ensemble ; Gemini transcrit puis traduit dans la même réponse, en streaming (le texte s'affiche au fil de l'eau). Aucun aller-retour transcription → traduction.
- **Découpage court.** Une phrase se termine après 0,45 s de silence. Pendant un long monologue, l'audio est coupé toutes les 5 s au plus, au moment le plus calme, pour que les traductions continuent d'arriver.
- **Réseau optimisé.** Connexion HTTP/2 ouverte dès le démarrage et réutilisée, raisonnement du modèle au minimum, niveau *priority* de Gemini (désactivable).
- **Cohérence.** Les 3 dernières répliques traduites sont renvoyées en texte (jamais l'audio) pour lever les ambiguïtés.
- **Coupure réseau.** L'audio des phrases en échec est gardé et relancé automatiquement dès qu'une traduction repasse ; un bouton « Réessayer » existe aussi.

## Réglages fins (dans le code)

| Fichier | Ce qu'on y règle |
|---|---|
| `TranslationPrompt.swift` | Le prompt : traduction fidèle sans interprétation, dialectes du Centre, argot monétaire, format de sortie |
| `SpeechSegmenter.swift` › `SegmenterTuning` | `endSilence` (réactivité), `maxSegment` (longueur max d'un extrait), sensibilité au bruit |
| `GeminiClient.swift` › `GeminiModel` | Les modèles proposés (Google les renomme régulièrement) |

## Sécurité et confidentialité

- Clé API dans le trousseau iOS, accessible à cet appareil seulement (ni iCloud, ni sauvegarde vers un autre iPhone). Elle n'est envoyée qu'à Google, dans un en-tête HTTPS.
- Les requêtes sont envoyées avec `store: false` : l'interaction n'est pas conservée côté API pour être relue.
- Rien n'est enregistré sur l'iPhone : l'audio est gardé en mémoire le temps de la traduction, puis effacé. La corbeille efface la conversation affichée.
- Clé côté client : acceptable pour un usage personnel. Pour la distribuer à d'autres, il faudrait un petit backend qui garde la clé.

## Coût

Estimation pour **une heure de dispute**, calculée sur les jetons que l'app envoie vraiment : environ 900 jetons de consigne et 130 de contexte, renvoyés avec chaque phrase, plus 32 jetons par seconde d'audio. Une dispute produit 15 à 24 phrases par minute. Dans chaque fourchette, le bas correspond à 45 min de parole sur l'heure, le haut à une parole continue.

| Réglage | Jusqu'au 31/12/2026 | Dès le 1er janvier 2027 |
|---|---|---|
| Ultra-rapide (3.5 Flash-Lite) | 0,40 – 0,65 $ | inchangé |
| Équilibré (3.6 Flash) | 0,95 – 1,45 $ | 1,90 – 2,90 $ |
| **Équilibré + prioritaire (par défaut)** | **1,70 – 2,60 $** | **3,40 – 5,20 $** |
| Précis (3.8 Flash) + prioritaire | ~2,90 – 4,50 $ | ~5,80 – 9,10 $ |

- **Répartition** : les deux tiers de la facture viennent de la consigne renvoyée avec chaque phrase. L'audio pèse moins de 10 %.
- **Hausse en 2027** : le tarif de lancement de 3.6 Flash et 3.8 Flash s'arrête au 31 décembre 2026, et leur prix double.
- **Payer moins** : couper le mode prioritaire (environ −45 %) ou passer en Ultra-rapide (4 fois moins cher que le réglage par défaut).
- **Précis** : chiffres approximatifs, car ce modèle réfléchit avant de répondre et ces jetons de réflexion sont facturés en plus.
- **Tarifs utilisés (novembre 2026)**, par million de jetons en entrée / en sortie : 3.5 Flash-Lite 0,30 $ / 2,50 $ ; 3.6 Flash et 3.8 Flash 0,75 $ / 3,75 $ ; mode prioritaire 75 à 100 % plus cher. Google les modifie régulièrement : les vérifier sur sa page de tarifs.

## Dépannage

- **« Clé refusée »** : la recopier en entier.
- **« Quota atteint »** : la facturation n'est pas activée sur le projet de la clé.
- **« Modèle introuvable »** : choisir un autre modèle dans les réglages, ou mettre à jour `GeminiModel`.
- **Rien ne s'affiche dans un lieu très bruyant** : rapprocher le téléphone des voix, ou baisser `startMarginDB` dans `SegmenterTuning`.
- **Le projet ne s'ouvre pas** : créer un projet *App* (SwiftUI) nommé `ThongDich`, y glisser les fichiers `.swift` et `Assets.xcassets`, ajouter *Background Modes › Audio* et la clé `NSMicrophoneUsageDescription`. Sous Xcode 26, régler aussi *Default Actor Isolation* sur `nonisolated` et *Swift Language Version* sur 5.

## Choix techniques

- **Interactions API** de Gemini (`POST /v1beta/interactions`), recommandée par Google pour tout nouveau développement, en streaming SSE.
- Modèles : Gemini 3.5 Flash-Lite, 3.6 Flash (par défaut) et 3.8 Flash, avec le niveau de raisonnement le plus bas que chacun accepte.
- **Gemini 3.5 Live Translate** (flux continu voix → voix) a été écarté : il n'accepte ni prompt ni consigne, donc ni indications sur les parlers du Centre, ni format VI/FR.
