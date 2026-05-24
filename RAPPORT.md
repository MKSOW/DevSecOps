# Rapport de TP — DevSecOps : de l'application au déploiement Azure

**Mamadou Khaly Sow**
Master 1 — Expert en études et développement du système d'information
Mai 2026

Application support : **Helpdesk**, une plateforme de gestion de tickets écrite
en Next.js (fullstack TypeScript).
Application déployée et accessible : **https://helpdesk-mks.azurewebsites.net**

---

## Mise en route

J'ai d'abord récupéré le projet, installé les dépendances et lancé l'application
en local pour la prendre en main avant de commencer le TP.

```bash
npm install
cp .env.example .env
npx prisma migrate dev --name init
npx prisma db seed
npm run dev
```

Je me suis connecté avec le compte `admin@helpdesk.io` et j'ai vérifié que le
dashboard affichait bien des tickets.

*Capture à fournir : page `/dashboard` avec au moins un ticket, connecté en admin.*

---

## Étape 1 — Conteneurisation Docker

### 1.1 Lecture du Dockerfile et questions

**Pourquoi un multi-stage build plutôt qu'un seul `FROM` ?**

Si on construisait l'image avec un seul `FROM`, on se retrouverait avec tout
l'outillage de compilation dans l'image finale : le compilateur TypeScript, les
devDependencies (Vitest, ESLint…), les fichiers sources `.ts`, etc. L'image
pèserait facilement plus de 1,5 Go alors que rien de tout ça n'est utile pour
faire *tourner* l'application.

Le Dockerfile découpe donc le travail en trois étapes :

- `deps` installe les dépendances npm,
- `builder` compile l'application et génère le client Prisma,
- `runner` est l'image finale, qui ne récupère que le résultat compilé
  (`.next/standalone`) et les quelques modules nécessaires à l'exécution.

Chaque étape est un layer isolé, et Docker ne copie d'une étape à l'autre que ce
qu'on lui demande explicitement avec `COPY --from=...`. Les étapes intermédiaires
sont jetées. Au final mon image fait 235 Mo.

**Que fait `output: 'standalone'` dans `next.config.js` ?**

Normalement Next.js se lance avec `next start`, qui a besoin de tout le dossier
`node_modules` (plusieurs centaines de Mo). Avec `output: 'standalone'`, Next.js
analyse les imports réellement utilisés et génère un dossier `.next/standalone`
qui contient un `server.js` autonome et uniquement les modules nécessaires.

Le Dockerfile s'appuie là-dessus dans l'étape `runner` : au lieu de recopier tout
`node_modules`, il ne copie que `.next/standalone`. C'est ce qui permet de garder
l'image légère.

**Pourquoi un utilisateur non-root `nextjs` ?**

Par défaut un conteneur exécute ses processus en `root`. Si l'application a une
faille permettant d'exécuter du code, l'attaquant se retrouve root dans le
conteneur et peut faire beaucoup de dégâts. En créant un utilisateur dédié
`nextjs` (UID 1001) et en faisant tourner l'app sous cet utilisateur, on applique
le principe du moindre privilège : même en cas de faille, l'attaquant est limité
aux fichiers de cet utilisateur, il ne peut pas toucher au système.

**À quoi sert le `HEALTHCHECK` ?**

C'est une sonde que Docker exécute régulièrement (toutes les 30 secondes ici)
pour savoir si l'application répond. La commande appelle `/api/health` ; si ça
répond, le conteneur est marqué `healthy`, sinon `unhealthy` après plusieurs
échecs. C'est utile pour Docker Compose (un service peut attendre qu'un autre
soit `healthy`) et surtout pour un hébergeur comme Azure App Service, qui
redémarre un conteneur `unhealthy` ou arrête de lui envoyer du trafic.

### 1.2 Build et validation

J'ai construit l'image puis vérifié sa taille :

```bash
docker build -t helpdesk:dev .
docker images | grep helpdesk
```

L'image fait **235 Mo**, donc en dessous des 300 Mo demandés.

J'ai ensuite lancé le conteneur et testé la sonde de santé. À noter : le port
3000 était déjà pris par un autre projet sur ma machine, j'ai donc utilisé le
port 3004 pour le reste du TP.

```bash
curl http://localhost:3004/api/health
{"status":"ok","timestamp":"...","uptime":...}
```

La connexion fonctionne avec les comptes de démo. Je suis tombé sur un petit
souci au passage : la première fois, le login renvoyait une erreur interne. Le
conteneur avait démarré avant que la base soit prête, et Prisma avait mis en
cache une connexion vide. Un simple `docker restart` a réglé le problème.

*Captures à fournir : taille de l'image, réponse de `/api/health`.*

### 1.3 Docker Compose

```bash
docker compose down -v
docker compose up -d --build
docker compose logs -f app
```

Le `docker compose up` fonctionne. J'ai aussi corrigé un petit avertissement :
le `docker-compose.yml` commençait par `version: '3.9'`, attribut devenu obsolète
avec Docker Compose v2, je l'ai retiré.

*Capture à fournir : logs de démarrage sans erreur.*

---

## Étape 2 — Tests unitaires

### 2.1 Tests existants

```bash
npm test
npm run test:coverage
```

Le projet fournissait deux fichiers de tests : `auth.test.ts` et
`validators.test.ts`. Tous les tests passent.

### 2.2 Tests que j'ai ajoutés

Le TP demandait au moins 5 tests supplémentaires. J'ai créé un module de logique
métier puis trois fichiers de tests :

- `src/lib/permissions.ts` : un module RBAC que j'ai écrit, avec
  `canEditTicket`, `canDeleteTicket` et `canAssignTicket`.
- `tests/unit/permissions.test.ts` : 12 tests sur ces fonctions.
- `tests/unit/extra.test.ts` : 10 tests (token JWT expiré, `loginSchema`,
  `ticketUpdateSchema`).
- `tests/unit/mamadou.test.ts` : 22 tests de valeurs limites, c'est-à-dire que
  je teste les frontières exactes des règles de validation (un mot de passe de
  7 caractères doit échouer, un de 8 doit passer, etc.). C'est là que les bugs
  se cachent le plus souvent.

Au total **57 tests passent**, dont 44 que j'ai ajoutés.

### Couverture de code

| Fichier | Statements | Branches | Functions |
|---------|-----------|----------|-----------|
| `auth.ts` | 80 % | 100 % | 80 % |
| `permissions.ts` | 100 % | 100 % | 100 % |
| `validators.ts` | 100 % | 100 % | 100 % |
| `prisma.ts` | 0 % | 0 % | 0 % |
| `src/lib` (global) | 81,7 % | 93,3 % | 77,8 % |

La couverture globale affichée par Vitest est faible (environ 5 %) parce que
l'outil compte aussi les pages React et les routes API, qui ne sont pas testées
en unitaire. Ce qui compte vraiment c'est la colonne `src/lib`, la logique pure.

Pourquoi pas 100 % partout ? Dans `auth.ts`, la fonction `getAuthFromRequest`
(lignes 39-43) prend en paramètre un objet `NextRequest`, propre au runtime
Next.js, que je ne peux pas créer dans un test Vitest classique : il faudrait un
test d'intégration. Et `prisma.ts` ouvre une vraie connexion à la base, donc le
tester en unitaire n'a pas de sens, il faudrait mocker tout Prisma.

*Capture à fournir : sortie de `npm run test:coverage`.*

---

## Étape 3 — Tests de montée en charge avec k6

L'application tournait dans le conteneur sur le port 3004, j'ai donc lancé les
tests k6 avec `-e BASE_URL=http://localhost:3004`.

### 3.1 Smoke test

```bash
k6 run -e BASE_URL=http://localhost:3004 k6/smoke-test.js
```

Ce test envoie des requêtes avec un seul utilisateur virtuel pendant 10 secondes,
juste pour confirmer que l'app répond avant de lancer le vrai test de charge.

| Métrique | Valeur | Seuil |
|----------|--------|-------|
| Latence p(95) | 6,19 ms | < 200 ms |
| Taux d'erreur | 0,00 % | < 1 % |
| Requêtes | 2 499 (~250/s) | — |

Tout passe, l'application répond très bien à faible charge.

### 3.2 Test de charge

```bash
k6 run -e BASE_URL=http://localhost:3004 k6/load-test.js
```

Le scénario monte progressivement : 0 à 10 utilisateurs virtuels en 30 s, puis
jusqu'à 50 en une minute, un palier de 2 minutes à 50, et une descente de 30 s.

Quelques définitions utiles pour lire les résultats :

- **p(95)** : 95 % des requêtes sont traitées en moins de cette valeur. C'est
  plus parlant que la moyenne, qui peut masquer les requêtes lentes.
- **RPS** : nombre de requêtes traitées par seconde.
- **Taux d'erreur** : pourcentage de requêtes en échec (4xx, 5xx, timeout).

Résultats obtenus :

| Métrique | Valeur | Seuil |
|----------|--------|-------|
| Requêtes totales | 6 253 | — |
| Débit | 25,9 req/s | — |
| Taux d'erreur | 0,00 % | < 1 % |
| Checks réussis | 8 336 / 8 336 | — |
| Latence médiane | 811 ms | — |
| Latence moyenne | 1 071 ms | — |
| Latence p(95) | 3 176 ms | < 500 ms |
| Latence max | 7 485 ms | — |
| p(95) sur `GET /api/tickets` | 3 999 ms | — |

k6 se termine avec le code 99 et affiche `thresholds on metrics
'http_req_duration' have been crossed`. Au début j'ai cru à une panne, mais en
fait c'est normal : le seuil p(95) < 500 ms n'est pas tenu, k6 le signale. C'est
justement le but d'un test de charge, révéler la limite de l'application. Le test
lui-même s'est déroulé sans incident.

Ce qui est intéressant, c'est que l'application reste **correcte**
fonctionnellement (0 % d'erreur, aucun crash, les 8 336 checks passent), mais
elle devient **lente** : la latence p(95) passe de 6 ms avec 1 utilisateur à
3 176 ms avec 50, soit un facteur d'environ 500.

J'ai identifié deux causes :

1. **SQLite n'autorise qu'une écriture à la fois.** Chaque création de ticket
   pose un verrou exclusif sur le fichier de base. Avec 50 utilisateurs qui en
   créent en parallèle, les écritures font la queue.
2. **La route `GET /api/tickets` ne pagine pas.** En regardant le code
   (`src/app/api/tickets/route.ts`), le `findMany()` n'a ni `take` ni `skip` :
   il renvoie tous les tickets, chacun avec trois jointures. Or le test crée à
   peu près 2 000 tickets au fil de l'eau, donc plus le test avance, plus cette
   requête renvoie de données et plus elle ralentit. C'est elle la plus lente.

Pour corriger ça il faudrait paginer la liste des tickets et, à plus long terme,
remplacer SQLite par PostgreSQL qui gère la concurrence.

*Captures à fournir : résumé console k6 + le fichier `k6-summary.json`.*

### 3.3 Test de rupture (bonus)

Non réalisé. Si je le faisais, je m'attendrais à voir des timeouts et des 503
apparaître bien avant 200 utilisateurs, le goulot d'étranglement SQLite étant
déjà visible à 50.

---

## Étape 4 — Sécurité

### 4.1 Audit des dépendances

```bash
npm audit --audit-level=high
```

L'audit remonte **11 vulnérabilités** : 0 critique, 4 hautes, 7 modérées.

Les failles hautes touchent `next`, `eslint-config-next`,
`@next/eslint-plugin-next` et `glob`. Les modérées concernent surtout des
dépendances de développement (`vitest`, `vite`, `esbuild`, `postcss`).

La principale concerne Next.js lui-même (version 14.2.33) : plusieurs avis de
sécurité, notamment des dénis de service sur les Server Components. Le correctif
complet impose de passer à `next@16`, ce qui est un changement majeur. En vrai
projet je planifierais cette montée de version plutôt que de lancer
`npm audit fix --force` à l'aveugle, qui casserait le build.

*Capture à fournir : sortie de `npm audit`.*

### 4.2 Scan de l'image avec Trivy

```bash
trivy image helpdesk:dev --severity HIGH,CRITICAL
```

| Couche scannée | CRITICAL | HIGH |
|----------------|----------|------|
| OS Alpine (paquets système) | 0 | 0 |
| Paquets Node.js (dépendances) | 0 | 18 |

Le résultat que je trouve intéressant : la couche système (Alpine Linux) est
totalement propre, aucune vulnérabilité. Les 18 failles hautes sont toutes dans
les dépendances npm embarquées (`next`, `tar`…). Choisir `node:20-alpine` comme
image de base était donc un bon choix, Alpine est minimaliste et contient très
peu de paquets exploitables. Le risque vient uniquement du code applicatif, ce
qui rejoint le résultat de `npm audit`.

Le scan d'image est utile parce qu'une image Docker empile deux sources de
risque : les paquets de l'OS de base et les dépendances de l'application. Trivy
compare tout ça aux bases de vulnérabilités connues et signale les CVE.

*Capture à fournir : sortie de Trivy.*

### 4.3 Pentest

**Exercice 4.3.1 — JWT signé avec un secret faible**

Le `.env.example` fourni contient un `JWT_SECRET` trivial. Le `.env` du projet
en a un autre, mais à peine mieux : c'est une suite de touches tapées au clavier,
sans aléa réel. Or la sécurité d'un JWT signé en HS256 repose entièrement sur ce
secret.

J'ai voulu vérifier qu'on pouvait forger un token administrateur. La démarche :

1. Je me connecte en `user@helpdesk.io` et je récupère mon token (rôle USER).
2. Je décode le payload, je change `"role": "USER"` en `"role": "ADMIN"`.
3. Je re-signe le token avec le secret connu.
4. J'appelle `DELETE /api/tickets/<id>` avec ce token forgé.

| Test | Token | Réponse |
|------|-------|---------|
| `DELETE /api/tickets/<id>` | token USER légitime | `403 Forbidden` |
| `DELETE /api/tickets/<id>` | token ADMIN forgé | `200 {"ok":true}` |

La faille est confirmée : avec le token forgé, le ticket est réellement supprimé.
La route `DELETE` vérifie seulement `auth.role !== 'ADMIN'`, et `auth.role` vient
du JWT. Comme je connais le secret, je contrôle le contenu du token et
l'application n'a aucun moyen de le distinguer d'un vrai.

Trois mitigations possibles :

- Utiliser un vrai secret aléatoire de 256 bits (`openssl rand -base64 32`),
  impossible à deviner ou à brute-forcer.
- Faire tourner le secret régulièrement (par exemple tous les 90 jours, ou après
  un incident), idéalement stocké dans un coffre comme Azure Key Vault.
- Passer à un algorithme asymétrique (RS256) : la clé privée signe, la clé
  publique vérifie. Même en récupérant la clé publique, on ne peut pas forger de
  token.

**Exercice 4.3.2 — Tentative d'accès aux données d'un autre utilisateur**

J'ai créé un ticket au nom de `agent@helpdesk.io`, puis essayé de le lire avec le
token de `user@helpdesk.io` :

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3004/api/tickets/<id>
```

Réponse : `403 Forbidden`. Sur ce point l'application est correcte. La route
`GET /api/tickets/[id]` contient bien le contrôle
`if (auth.role === 'USER' && ticket.authorId !== auth.userId)`. C'est la
distinction entre authentification (qui es-tu) et autorisation (as-tu le droit).
Cela dit, ce contrôle reste contournable via la faille précédente : un token
forgé en ADMIN n'est pas soumis au filtre `role === 'USER'`.

**Exercice 4.3.3 — Headers de sécurité manquants**

J'ai inspecté les headers de la page d'accueil avec `curl -I http://localhost:3004/`.
Aucun header de sécurité n'était présent : pas de `Content-Security-Policy`, pas
de `X-Frame-Options`, pas de `Strict-Transport-Security`, pas de
`X-Content-Type-Options`, pas de `Referrer-Policy`, pas de `Permissions-Policy`.
Seul point positif, `X-Powered-By` est absent (désactivé via `poweredByHeader:
false` dans `next.config.js`).

Rôle de chacun :

| Header | Ce qu'il protège |
|--------|------------------|
| `Content-Security-Policy` | limite les sources de scripts/styles, contre le XSS |
| `X-Frame-Options` | empêche d'afficher le site dans une iframe (clickjacking) |
| `Strict-Transport-Security` | force le HTTPS |
| `X-Content-Type-Options` | empêche le navigateur de deviner le type de fichier |
| `Referrer-Policy` | limite les infos envoyées dans le header `Referer` |
| `Permissions-Policy` | coupe l'accès caméra/micro/géoloc |

J'ai corrigé la faille en ajoutant un middleware Next.js (`src/middleware.ts`)
qui pose ces headers sur toutes les pages, puis j'ai reconstruit l'image. Après
correction, `curl -I` montre bien les 6 headers.

```typescript
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(_request: NextRequest) {
  const response = NextResponse.next();

  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload'
  );
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
  );

  return response;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
```

*Capture à fournir : `curl -I` avant / après correction.*

### 4.4 Un bug que j'ai corrigé au passage

Pendant les tests, le conteneur Docker apparaissait tout le temps en statut
`unhealthy` alors que l'application fonctionnait. J'ai cherché un moment. La
sonde `HEALTHCHECK` appelait `http://localhost:3000/...`, et dans le conteneur
`localhost` est résolu d'abord en IPv6 (`::1`). Or le serveur Next.js standalone
n'écoute qu'en IPv4. La sonde tapait donc une adresse sur laquelle personne
n'écoutait, d'où le `Connection refused`.

J'ai remplacé `localhost` par `127.0.0.1` dans le `Dockerfile` et le
`docker-compose.yml`. Après reconstruction, le conteneur passe `healthy`. Ce
détail compte : sur Azure App Service, un conteneur `unhealthy` se fait
redémarrer ou retirer du routage.

---

## Étape 5 — Pipeline CI/CD GitHub Actions

### 5.1 Structure du pipeline

Le fichier `.github/workflows/ci-cd.yml` définit 4 jobs qui s'enchaînent :

```
push sur master / preProd
        │
   ┌────┴─────┐
   ▼          ▼
 test     security      (en parallèle)
   └────┬─────┘
        ▼
     docker              (attend test + security)
        ▼
     deploy              (uniquement sur master)
```

- **test** : installe Node 20, lance le lint et les tests avec couverture, et
  publie le rapport en artefact.
- **security** : `npm audit` et un scan Trivy du système de fichiers, en mode
  informatif (`continue-on-error`), donc sans bloquer le pipeline.
- **docker** : construit l'image Docker (avec cache) et la scanne avec Trivy.
- **deploy** : ne s'exécute que sur `master`.

### 5.2 Corrections que j'ai dû faire pour que le pipeline tourne

Le workflow fourni ne fonctionnait pas tel quel, j'ai dû régler trois choses.

**Les branches.** Le déclencheur écoutait `main` et `develop`. Mon dépôt utilise
`master` et `preProd`. Tel quel, aucun `git push` ne lançait quoi que ce soit.
J'ai changé le déclencheur en `[master, preProd]` et la condition du job `deploy`
en `refs/heads/master`.

**ESLint.** Le projet n'avait aucun fichier de configuration ESLint. Du coup
`npm run lint` (`next lint`) devenait interactif, il demandait de choisir une
config — impossible en CI puisqu'il n'y a personne pour répondre. J'ai ajouté un
fichier `.eslintrc.json` (`extends: next/core-web-vitals`). Maintenant le lint
se termine proprement avec le code 0 (3 warnings, 0 erreur).

**Image introuvable par Trivy.** Au premier vrai run, le job `docker` a échoué
avec `No such image: helpdesk:<sha>`. La raison : `docker/build-push-action`
utilise Buildx, qui construit l'image dans son propre cache et pas dans le magasin
d'images du démon Docker. Avec `push: false` et sans `load: true`, l'image
n'existe nulle part de visible, donc Trivy ne la trouve pas. J'ai ajouté
`load: true` à l'étape de build pour charger l'image dans le démon.

Avant de pousser, j'ai vérifié en local : `npm run lint` (code 0),
`npm run test:coverage` (57 tests OK) et `npm run build` (build réussi).

### 5.3 Résultat

Après ces corrections, les jobs `test`, `security` et `docker` passent au vert.

*Capture à fournir : onglet Actions avec les jobs au vert.*

---

## Étape 6 — Déploiement sur Azure for Students

Application en ligne : **https://helpdesk-mks.azurewebsites.net**

### 6.1 Installation d'Azure CLI

L'installation via le script officiel `InstallAzureCLIDeb` a échoué. Ma machine
tourne sous Ubuntu 25.10 « Questing », une version trop récente pour laquelle
Microsoft n'a pas encore publié de paquet apt (le dépôt renvoie une 404). J'ai
contourné en installant Azure CLI dans un environnement Python isolé
(`python3 -m venv` puis `pip install azure-cli`), ce qui est une méthode
officiellement supportée. J'ai obtenu Azure CLI 2.86.0 sans avoir besoin de
`sudo`.

### 6.2 Création des ressources

| Ressource | Nom | Détail |
|-----------|-----|--------|
| Resource Group | `helpdesk-rg` | région `francecentral` |
| Container Registry | `helpdeskacrmks` | SKU Basic |
| App Service Plan | `helpdesk-plan` | B1 Linux |
| Web App | `helpdesk-mks` | conteneur Linux |

Premier obstacle : sur une souscription neuve, les *resource providers*
`Microsoft.ContainerRegistry` et `Microsoft.Web` ne sont pas activés. La création
de l'ACR échouait avec `MissingSubscriptionRegistration`. Je les ai activés avec
`az provider register`.

### 6.3 Envoi de l'image vers l'ACR

```bash
docker tag helpdesk:dev helpdeskacrmks.azurecr.io/helpdesk:v1
docker push helpdeskacrmks.azurecr.io/helpdesk:v1
```

Après un `docker login` sur l'ACR avec les identifiants admin du registre.

### 6.4 Création de la Web App

Là j'ai eu un piège avec `az webapp create`. Si on passe `--container-image-name`
avec le nom du registre déjà dedans, *et* `--container-registry-url`, la CLI
préfixe le registre une deuxième fois et on obtient un chemin double
(`helpdeskacrmks.azurecr.io/helpdeskacrmks.azurecr.io/helpdesk:v1`), qui ne
correspond à rien. À l'inverse, `az webapp config container set` ne préfixe pas,
il faut lui donner le chemin complet. J'ai fini avec la bonne configuration :

```
linuxFxVersion = DOCKER|helpdeskacrmks.azurecr.io/helpdesk:v1
```

Variables d'environnement définies sur la Web App :

| Variable | Valeur |
|----------|--------|
| `DATABASE_URL` | `file:/app/data/prod.db` |
| `JWT_SECRET` | un secret généré avec `openssl rand -base64 32` |
| `NODE_ENV` | `production` |
| `WEBSITES_PORT` | `3000` |

### 6.5 Initialisation de la base de données

Le TP prévoyait d'initialiser la base via SSH dans le conteneur
(`npx prisma migrate deploy`). Ça ne marche pas ici : l'image standalone ne
contient ni le CLI Prisma ni `tsx`, et `npx prisma` télécharge alors la version 7
de Prisma, qui refuse le schéma écrit pour la version 5.

J'ai donc choisi une autre approche : créer et seeder la base **pendant le build
Docker**, dans l'étape `builder`, qui dispose elle du CLI Prisma 5 et de `tsx`.
La base SQLite déjà remplie (les 3 utilisateurs de démo) est copiée dans l'image
finale à `/app/data/prod.db`. L'application est donc prête dès le démarrage du
conteneur, sans manipulation.

Limite que j'assume : comme la base est dans l'image, elle revient à son état de
départ à chaque redéploiement. Pour une vraie persistance il faudrait une base
externe (voir la synthèse).

### 6.6 Vérification

```bash
$ curl https://helpdesk-mks.azurewebsites.net/api/health
{"status":"ok","timestamp":"...","uptime":...}
```

La connexion fonctionne (compte admin, rôle ADMIN), et les 6 headers de sécurité
sont bien présents sur la réponse HTTPS. L'application est publique et
fonctionnelle.

*Captures à fournir : `curl /api/health` + le dashboard dans le navigateur.*

### 6.7 Connexion de la CI au déploiement (bonus)

C'est l'étape qui m'a demandé le plus de débogage, parce que je n'ai pas pu
suivre la méthode du TP.

**Pas de service principal.** Le TP voulait authentifier GitHub Actions avec un
service principal créé par `az ad sp create-for-rbac`. La commande échoue :
`Insufficient privileges to complete the operation`. Le tenant Entra ID de
l'école interdit aux comptes étudiants de créer des identités d'annuaire.

**Le publish profile ne suffit pas pour un conteneur.** J'ai d'abord essayé de
contourner avec un *publish profile* passé à `azure/webapps-deploy`. Le job a
quand même échoué à cette étape. En cherchant, j'ai compris : un publish profile
donne accès au endpoint SCM/Kudu, qui sert à déployer du *code*, mais changer
l'*image* d'un conteneur est une opération ARM, que le publish profile ne couvre
pas.

**Solution finale : déploiement continu par webhook.** L'idée est que la CI n'a
plus du tout besoin de droits sur Azure, juste de pouvoir pousser sur l'ACR :

1. La Web App est configurée pour surveiller le tag `helpdesk:latest`, et
   j'active le déploiement continu (`az webapp deployment container config
   --enable-cd true`), ce qui me donne une URL de webhook.
2. Je crée un webhook sur l'ACR (`az acr webhook create`, limité au tag
   `helpdesk:latest`) : à chaque push de ce tag, l'ACR appelle l'URL de la
   Web App.
3. Le job `deploy` se limite donc à : se connecter à l'ACR, construire l'image,
   pousser les tags `:latest` et `:<sha>`. Le push de `:latest` déclenche le
   webhook, et la Web App va chercher la nouvelle image toute seule.
4. Un dernier *smoke test* vérifie que `/api/health` répond bien.

Un détail au passage : le webhook renvoyait d'abord `401 Unauthorized`.
L'authentification basique du endpoint SCM était désactivée sur la Web App, je
l'ai réactivée et le webhook a ensuite renvoyé `202 Accepted`.

Secrets configurés dans GitHub (Settings → Secrets and variables → Actions) :
`ACR_LOGIN_SERVER`, `ACR_USERNAME`, `ACR_PASSWORD` et `AZURE_WEBAPP_NAME`.

Un push sur `master` déclenche bien les 4 jobs, `deploy` compris.

*Capture à fournir : onglet Actions avec les 4 jobs au vert.*

---

## Synthèse

### Architecture finale

```
 Développeur
   │  git push
   ▼
 GitHub  (branches master / preProd)
   │  déclenche
   ▼
 GitHub Actions
   ├─ test      : lint + tests unitaires + couverture
   ├─ security  : npm audit + scan Trivy
   ├─ docker    : build image + scan Trivy
   └─ deploy    : build + push image  (master uniquement)
                       │
                       ▼
            Azure Container Registry (helpdeskacrmks)
                       │  webhook sur push de :latest
                       ▼
            Azure App Service (helpdesk-mks, plan B1)
                       │
                       ▼
            https://helpdesk-mks.azurewebsites.net
```

### Trois améliorations DevSecOps que je mettrais en place avec plus de temps

1. **Azure Key Vault pour les secrets.** Aujourd'hui le `JWT_SECRET` et les
   identifiants de l'ACR sont dans des secrets GitHub et des app settings Azure
   en clair. Un coffre comme Key Vault les chiffrerait, permettrait de les faire
   tourner sans redéployer, et l'application les lirait via une identité managée
   sans avoir à gérer de credentials.

2. **Monitoring avec Application Insights.** Pour l'instant je n'ai aucune
   visibilité en production : je ne sais pas combien d'erreurs 500 se produisent
   ni quelles routes sont lentes. Application Insights instrumenterait
   l'application et donnerait des traces, des alertes sur le taux d'erreur et un
   tableau de bord de performance.

3. **Passage à PostgreSQL.** SQLite convient en développement mais le test de
   charge a bien montré sa limite : une seule écriture à la fois. Une base
   PostgreSQL (Azure Database for PostgreSQL) gérerait la concurrence et
   permettrait de faire tourner plusieurs instances de l'App Service.

### Coût Azure

Deux ressources sont facturées : l'ACR Basic (environ 5 $/mois) et l'App Service
Plan B1 (environ 13 $/mois), soit à peu près 18 $/mois. Le resource group et la
Web App ne coûtent rien en eux-mêmes. Sur les 100 $ de crédit Azure for Students,
ça tient environ 5 mois. Le déploiement réalisé pour ce TP, sur quelques heures,
n'a entamé le crédit que de quelques centimes.

*Capture à fournir : coût réel dans Azure Cost Management.*

### Ce qui m'a posé problème

| Problème | Cause | Solution |
|----------|-------|----------|
| Conteneur `unhealthy` | `localhost` résolu en IPv6, serveur en IPv4 | `localhost` → `127.0.0.1` dans le healthcheck |
| Login en erreur dans le conteneur | connexion Prisma mise en cache avant la base | redémarrer le conteneur |
| `next lint` bloquant en CI | pas de config ESLint, commande interactive | ajout de `.eslintrc.json` |
| Workflow jamais déclenché | écoutait `main`/`develop`, dépôt en `master`/`preProd` | correction des branches |
| Trivy ne trouve pas l'image | Buildx ne charge pas l'image dans le démon | `load: true` à l'étape de build |
| `MissingSubscriptionRegistration` | resource providers non activés | `az provider register` |
| Chemin d'image Azure doublé | double préfixe du registre par `az webapp create` | chemin complet via `config container set` |
| Base non initialisable sur Azure | l'image standalone n'a ni Prisma CLI ni `tsx` | base seedée pendant le build, embarquée |
| Azure CLI non installable | Ubuntu 25.10 trop récent | installation via `pip` dans un venv |
| Pas de service principal | tenant Entra ID restreint | déploiement continu par webhook ACR |
| `azure/webapps-deploy` en échec | le publish profile ne couvre pas l'ARM | webhook ACR, la Web App re-pull seule |
| Webhook en `401` | auth basique SCM désactivée | réactivation de `basicPublishingCredentialsPolicies` |
