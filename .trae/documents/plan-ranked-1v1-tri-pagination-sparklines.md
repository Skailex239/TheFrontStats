# Plan — Ranked 1v1: tri, pagination, Elo Δ, sparklines

## Summary

Objectif : améliorer l’onglet **Classé (1v1)** de TheFrontStats (hébergé sur GitHub Pages) avec :

- Tri interactif du tableau (clic sur les en-têtes)
- Pagination (Top 200, pages de 50)
- Deux nouveaux visuels : **Top Elo Δ** (gains/pertes depuis la précédente sync) + **mini sparklines** d’évolution Elo dans le tableau
- Modal “joueur classé” en mode **hybride** : fallback “cache repo” si l’API live échoue, tout en conservant la possibilité de charger les détails live via proxy CORS

## Current State Analysis

### Frontend

- [index.html](file:///workspace/index.html) contient l’onglet `tab-ranked` avec :
  - Tableau `#ranked-list` (colonnes rang, joueur, elo, peak, winrate, etc.)
  - Recherche `#ranked-search` via `filterRanked()`
  - Visuels existants : “Distribution des Elo” + “Classement des Clans”
  - Modal `#ranked-player-modal` avec “Évolution Elo” + “Historique 1v1 récent”
- [app.js](file:///workspace/app.js) :
  - `loadRankedLeaderboard()` charge `ranked.json(.gz)`, remplit `window._rankedPlayers`, rend le tableau et les visuels.
  - `filterRanked()` filtre mais ne gère ni tri ni pagination.
  - Le modal appelle l’API live via `openfront-client.js` (proxy CORS en prod), avec un risque de panne CORS/proxy.
  - `ranked_history.json(.gz)` est consommé côté client pour le sparkline du modal, mais le fichier n’existe pas dans le repo actuel.

### Génération des données (GitHub Actions / scripts)

- [sync-ranked.js](file:///workspace/sync-ranked.js) existe et :
  - Récupère le leaderboard via `GET https://api.openfront.io/leaderboard/ranked?page=N` (cf. docs OpenFront API)
  - Écrit `ranked.json(.gz)` + `ranked_history.json(.gz)` (historique Elo)
  - Calcule `movement` via comparaison avec l’ancien `ranked.json`
  - Calcule `newcomers/dropouts` seulement pour Top 100
- [sync.yml](file:///workspace/.github/workflows/sync.yml) commit `ranked.json(.gz)` mais :
  - ne lance pas `sync-ranked.js`
  - ne commit pas `ranked_history.json(.gz)` (donc le sparkline modal ne peut pas fonctionner sur GitHub Pages)
  - appelle `sync-massive.js` alors que le fichier est absent dans ce workspace (`node sync-massive.js` échouerait)

## Proposed Changes

### 1) Données ranked : exécuter + publier l’historique et un cache “recent games”

**Fichiers :**

- [sync-ranked.js](file:///workspace/sync-ranked.js)
- [sync.yml](file:///workspace/.github/workflows/sync.yml)

**Changements :**

1. **Activer la génération “ranked” dans GitHub Actions**
   - Ajouter une étape `node sync-ranked.js` (même environnement que les autres scripts : Node 18, `node-fetch@2`, `type=module`, `OPENFRONT_SKAILEX_ACCESS`).
   - Si `sync-massive.js` est réellement absent dans le repo, retirer (ou corriger) l’étape `node sync-massive.js` du workflow pour rétablir une CI fonctionnelle.

2. **Publier les fichiers nécessaires au frontend**
   - Ajouter au commit GitHub Actions :
     - `ranked_history.json`
     - `ranked_history.json.gz`
   - Ajouter un fichier “cache repo” pour le modal (hybride) :
     - `ranked_recent.json`
     - `ranked_recent.json.gz`

3. **Étendre Top 100 → Top 200**
   - Conserver le fetch leaderboard sur `MAX_PAGES=4` (Top 200) et aligner `newcomers/dropouts` sur **Top 200** pour cohérence avec l’UI.

4. **Générer `ranked_recent.json(.gz)` (cache hybride pour le modal)**
   - Pour chaque joueur du Top 200 (public_id), appeler `GET /public/player/:playerId` et extraire un résumé des **10 derniers matchs 1v1** :
     - `gameId`, `start`, `map`, `hasWon`, `clientId` (si disponible), éventuellement `rankedType/mode` si présent.
   - Écrire un payload compact, par ex. :
     - `{ updatedAt, top: { [public_id]: [ { gameId, start, map, hasWon }... ] } }`
   - Stratégie de throttling :
     - Concurrency basse sans exemption, plus élevée avec exemption (pattern déjà utilisé dans les autres scripts).

Pourquoi : sur GitHub Pages, si `corsproxy.io` ou l’API est indisponible, le modal reste utilisable via le cache ; en mode normal, on garde la possibilité d’enrichir (détails opponent, etc.) via appels live.

### 2) UI Ranked : pagination + tri + visuels (Top Elo Δ + sparklines)

**Fichiers :**

- [index.html](file:///workspace/index.html)
- [app.js](file:///workspace/app.js)
- (éventuel) [styles.css](file:///workspace/styles.css)

**Changements UI :**

1. **Top 200 + pagination**
   - Mettre à jour le libellé “Top 100” → “Top 200” dans l’onglet ranked.
   - Ajouter une barre de pagination sous le tableau :
     - Boutons `Précédent / Suivant`
     - Indicateur `Page X / 4`
     - Page size fixe : 50 (4 pages).

2. **Tri interactif**
   - Rendre les en-têtes de colonnes cliquables (tri client-side) :
     - `rank`, `username`, `elo`, `peakElo`, `winrate`, `total`, `movement`, `streak`, `eloDelta` (si affichée), etc.
   - Afficher un indicateur visuel (↑/↓) dans l’en-tête actif.
   - Le tri s’applique sur l’ensemble des résultats filtrés (pas seulement la page courante).

3. **Top Elo Δ (gains/pertes)**
   - Ajouter 2 cards (ou 1 grid) dans `tab-ranked` :
     - “🚀 Top gains Elo” (ex : top 5)
     - “🧊 Top pertes Elo” (ex : top 5)
   - Calcul Δ Elo depuis `ranked_history.json(.gz)` :
     - `delta = last.elo - prev.elo` (sur les 2 derniers points d’historique)
   - UX : clic sur un joueur → ouvre `showRankedPlayerModal(publicId, username)`.

4. **Mini sparklines dans le tableau**
   - Ajouter une colonne `Trend` (sparklines) dans le tableau.
   - Rendu :
     - Sparkline SVG minimaliste (sans labels) basé sur les **N derniers points** (ex : 20) du joueur dans `ranked_history`.
     - Calcul à la demande sur les joueurs visibles (page courante) pour limiter le DOM.

**Changements JS (app.js) :**

- Introduire un état central “ranked UI state” (ex : `window._rankedState`) :
  - `allPlayers`, `filteredPlayers`, `query`
  - `sortKey`, `sortDir`
  - `page`, `pageSize=50`
  - `historyById` (lazy-loaded), `recentById` (lazy-loaded)
- Remplacer l’enchaînement direct `filterRanked() -> renderRankedTable()` par :
  - `setRankedQuery(q)` → recompute filtered → apply sort → apply pagination → render
- Ajouter des handlers globaux :
  - `setRankedSort(key)` (toggle asc/desc)
  - `setRankedPage(page)`

### 3) Modal Ranked : mode hybride (cache repo + enrichissement live)

**Fichiers :**

- [app.js](file:///workspace/app.js)

**Changements :**

1. À l’ouverture du modal :
   - Charger d’abord `ranked_recent.json(.gz)` et afficher immédiatement le résumé des 10 derniers matchs (si présent).
2. Ensuite tenter l’enrichissement live (comme aujourd’hui) via `openfront-client.js` :
   - Si succès : remplacer/compléter avec les données live (opponent, détails game).
   - Si échec : conserver l’affichage cache + message discret “détails live indisponibles”.
3. Conserver l’évolution Elo du modal via `ranked_history.json(.gz)` (qui sera désormais publié par la CI).

## Assumptions & Decisions (locked)

- Hébergement : **GitHub Pages** (pas de backend obligatoire).
- Périmètre ranked : **Top 200** (pages de 50).
- Visuels à ajouter : **Top Elo Δ** + **mini sparklines**.
- Modal : **hybride** (fallback cache repo + enrichissement live quand possible).
- Source de vérité API : endpoints documentés OpenFront (`/leaderboard/ranked`, `/public/player/:id`, `/public/game/:id`) via `https://api.openfront.io` (cf. `docs/API.md` du repo OpenFrontIO).

## Verification Steps

1. Vérifier en local (dev) :
   - Lancer un serveur statique ou [server.js](file:///workspace/server.js) et ouvrir l’onglet Ranked :
     - tri OK sur plusieurs colonnes
     - pagination OK (4 pages)
     - Top gains/pertes Elo visible (si `ranked_history` présent)
     - sparklines visibles sur la page courante
2. Vérifier les scripts :
   - `node sync-ranked.js` génère bien :
     - `ranked.json(.gz)`, `ranked_history.json(.gz)`, `ranked_recent.json(.gz)`
3. Vérifier en “mode GitHub Pages” (sans API live) :
   - Simuler l’échec de l’API/proxy (offline) : le modal doit afficher le cache `ranked_recent`.
