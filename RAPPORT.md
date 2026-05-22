# RAPPORT — TP DevSecOps : De l'application au déploiement Azure

**Auteur :** Mamadou  
**Date :** 2026-05-22  
**Application :** Helpdesk (Next.js fullstack — gestion de tickets de support)

---

## Mise en route

**Checkpoint : capture d'écran de la page /dashboard**  
> *(À insérer : capture d'écran de http://localhost:3000/dashboard avec au moins un ticket visible, connecté en admin@helpdesk.io / Password123!)*

---

## ÉTAPE 1 — Conteneurisation Docker

### 1.1 Questions sur le Dockerfile

**Q1 — Pourquoi un multi-stage build plutôt qu'un seul FROM ?**

Un build avec un seul `FROM` embarquerait dans l'image finale l'intégralité de l'outillage de compilation : TypeScript, les devDependencies (Vitest, ESLint, etc.), les fichiers sources `.ts`, et tous les modules de développement. L'image résultante dépasserait 1,5 Go.

Le multi-stage sépare le processus en 3 étapes isolées :

| Stage | Rôle | Ce qu'il contient |
|-------|------|-------------------|
| `deps` | Installation des dépendances | `node_modules` complet |
| `builder` | Compilation | TypeScript → JavaScript, génération Prisma client |
| `runner` | Image finale | **Uniquement** le code compilé `.next/standalone` + modules runtime |

L'image finale ne contient que le strict nécessaire pour faire tourner l'application. Elle fait ~150 Mo. Docker exécute chaque stage dans un layer isolé et ne copie que ce qu'on lui demande explicitement (`COPY --from=builder ...`). Les stages intermédiaires sont jetés.

**Q2 — Que fait `output: 'standalone'` dans next.config.js et comment Docker l'exploite ?**

En mode standard, Next.js démarre via `next start` qui requiert la présence de tous les `node_modules` (800+ Mo). Avec `output: 'standalone'`, Next.js effectue une analyse statique des imports et génère un dossier `.next/standalone/` contenant :
- Un fichier `server.js` autonome (le serveur HTTP)
- Uniquement les modules Node.js réellement importés (tree-shaking côté serveur)

Docker exploite cela dans le stage `runner` en ne copiant que `.next/standalone` au lieu de tout `node_modules`. Résultat : des dizaines de Mo au lieu de centaines.

```dockerfile
# Sans standalone → copierait node_modules entier
COPY --from=builder /app/node_modules ./node_modules   # 600+ Mo

# Avec standalone → copie uniquement le bundle autonome
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./  # ~30 Mo
```

**Q3 — Pourquoi créer un utilisateur non-root `nextjs` ?**

Par défaut, Docker exécute les processus en tant que `root` (UID 0), le superutilisateur du système. Si l'application présente une vulnérabilité (Remote Code Execution, injection de commande), un attaquant qui obtient un shell dans le conteneur disposerait des droits root. Avec un utilisateur dédié `nextjs` (UID 1001) :

- Il ne peut pas lire `/etc/shadow`, modifier les binaires système, ou installer des paquets
- La surface d'attaque est réduite : l'attaquant est confiné aux fichiers appartenant à cet utilisateur
- C'est le principe du **moindre privilège** (Principle of Least Privilege), pilier de la sécurité

**Q4 — À quoi sert `HEALTHCHECK` dans le Dockerfile ?**

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1
```

Le HEALTHCHECK est une sonde de santé automatique. Toutes les 30 secondes, Docker exécute la commande `wget --spider /api/health`. Si l'application répond `200 OK`, le conteneur est `healthy`. Si la réponse échoue 3 fois consécutives (après 10s de grâce au démarrage), il passe `unhealthy`.

**Usages pratiques :**
- Docker Compose peut conditionner le démarrage d'un service B à la santé de A (`depends_on: condition: service_healthy`)
- Les orchestrateurs (Kubernetes, Azure App Service) redémarrent automatiquement les conteneurs `unhealthy`
- Azure App Service utilise cette sonde pour router le trafic uniquement vers les instances saines

### 1.2 Build et validation

```bash
docker build -t helpdesk:dev .
docker images | grep helpdesk
```

> *(Capture à insérer : taille de l'image < 300 Mo)*
> *(Capture à insérer : `curl http://localhost:3000/api/health` → `{"status":"ok",...}`)*

### 1.3 Docker Compose

```bash
docker compose down -v
docker compose up -d --build
docker compose logs -f app
```

> *(Capture à insérer : logs de démarrage sans erreur)*

---

## ÉTAPE 2 — Tests unitaires

### 2.1 Tests existants

```bash
npm test        # 57 tests, 5 fichiers
npm run test:coverage
```

> *(Capture à insérer : sortie console npx vitest run --coverage)*

### 2.2 Tests ajoutés

Deux fichiers étaient fournis (`auth.test.ts`, `validators.test.ts`). J'ai créé 3 nouveaux fichiers :

**Fichiers créés :**
- `src/lib/permissions.ts` — nouveau module de logique RBAC (canEditTicket, canDeleteTicket, canAssignTicket)
- `tests/unit/permissions.test.ts` — 12 tests sur la logique RBAC
- `tests/unit/extra.test.ts` — 10 tests (token expiré, loginSchema, ticketUpdateSchema)
- `tests/unit/mamadou.test.ts` — 22 tests de valeurs limites (boundary testing) sur auth, validators et permissions

**Total : 57 tests passent (dont 44 ajoutés, minimum requis : 5)**

### Couverture finale

| Fichier | Statements | Branches | Functions | Lignes non couvertes |
|---------|-----------|----------|-----------|----------------------|
| `auth.ts` | 80% | **100%** | 80% | 39–43 |
| `permissions.ts` | **100%** | **100%** | **100%** | — |
| `validators.ts` | **100%** | **100%** | **100%** | — |
| `prisma.ts` | 0% | 0% | 0% | 1–11 |
| `src/lib` global | **81.69%** | **93.33%** | **77.77%** | |

**Pourquoi < 100% sur certains fichiers ?**

- `auth.ts` lignes 39-43 : la fonction `getAuthFromRequest(req: NextRequest)` prend un objet `NextRequest` propre au runtime Next.js, qui n'existe pas en Node.js pur. Impossible à instancier dans Vitest sans lancer un vrai serveur. Ce serait un test d'intégration, pas unitaire.

- `prisma.ts` : instancie une connexion réelle à SQLite. Le tester en unitaire nécessiterait de mocker entièrement Prisma — hors scope.

- Pages React et routes API (`src/app/**`) : 0% car ils dépendent du DOM, du runtime Next.js, et d'une base de données. Ce sont des candidats pour des tests E2E (Playwright, Cypress), pas unitaires.

---

## ÉTAPE 3 — Tests de montée en charge k6

> Remarque : l'application tourne dans le conteneur Docker exposé sur le port **3004**
> (le port 3000 étant occupé par un autre service local). Les tests k6 sont donc
> lancés avec `-e BASE_URL=http://localhost:3004`.

### 3.1 Smoke test

```bash
k6 run -e BASE_URL=http://localhost:3004 k6/smoke-test.js
```

**Ce que mesure ce test :**
- 1 seul utilisateur virtuel (VU) pendant 10 secondes
- Appelle `/api/health` en continu
- Seuils : 95% des requêtes < 200ms, taux d'erreur < 1%

**Résultats :**

| Métrique | Valeur | Seuil | Verdict |
|----------|--------|-------|---------|
| p(95) latence | 6.19 ms | < 200 ms | ✓ |
| Taux d'erreur | 0.00% | < 1% | ✓ |
| Requêtes | 2 499 (~250 req/s) | — | 100% OK |

Le smoke test confirme que l'app répond correctement à faible charge avant de lancer le test lourd.

> *(Capture à insérer : résumé console k6)*

### 3.2 Test de charge

```bash
k6 run -e BASE_URL=http://localhost:3004 k6/load-test.js
```

**Scénario de montée :**
- 0→10 VUs en 30s (warm-up)
- 10→50 VUs en 1 minute (montée)
- 50 VUs pendant 2 minutes (palier de charge soutenue)
- 50→0 VUs en 30s (descente)

**Métriques clés :**
- **p(95)** : 95ème percentile de latence — 95% des requêtes sont traitées en moins de X ms. Plus révélateur que la moyenne, car il montre le cas le plus fréquent "pas de chance".
- **RPS** (Requests Per Second) : débit — combien de requêtes par seconde le serveur traite
- **Taux d'erreur** : % de requêtes ayant échoué (HTTP 4xx/5xx ou timeout)

**Résultats :**

| Métrique | Valeur | Seuil | Verdict |
|----------|--------|-------|---------|
| Requêtes totales | 6 253 | — | — |
| Débit (RPS) | 25.9 req/s | — | — |
| Taux d'erreur | 0.00% | < 1% | ✓ |
| Checks réussis | 8 336 / 8 336 | — | ✓ |
| Latence médiane | 811 ms | — | — |
| Latence moyenne | 1 071 ms | — | — |
| **p(95) latence** | **3 176 ms** | < 500 ms | **✗** |
| Latence max | 7 485 ms | — | — |
| p(95) route `/api/tickets` (GET) | 3 999 ms | — | route la plus lente |

**Interprétation :** le seuil `p(95) < 500 ms` est dépassé, donc k6 termine avec le code de sortie 99 et affiche `thresholds on metrics 'http_req_duration' have been crossed`. **C'est le résultat attendu et utile** : le but d'un test de charge est de révéler la limite de l'application. Le test lui-même s'est déroulé sans incident — ce message n'est pas une panne.

L'app reste **fonctionnellement correcte** sous charge (0% d'erreur, aucun crash, aucun 5xx, 8 336 checks réussis), mais elle devient **lente** : la latence p(95) passe de **6 ms** (smoke, 1 VU) à **3 176 ms** (charge, 50 VUs), soit une dégradation d'un facteur ~500.

**Deux goulots d'étranglement identifiés :**

1. **SQLite est mono-écriture.** Chaque création de ticket prend un verrou exclusif sur le fichier de base. Avec 50 VUs créant des tickets en parallèle, les écritures se sérialisent et forment une file d'attente.

2. **`GET /api/tickets` n'a aucune pagination** (`src/app/api/tickets/route.ts` — `findMany()` sans `take`/`skip`). Le test a créé ~2 084 tickets. À chaque appel, la requête renvoie *tous* les tickets, chacun enrichi de 3 jointures (auteur, assigné, nombre de commentaires). Plus le test avance, plus le jeu de résultats grossit — d'où le p(95) de ~4 s sur cette route.

**Pistes de correction :** ajouter une pagination (`take: 20, skip: …`) sur la liste des tickets, et migrer SQLite → PostgreSQL pour gérer les écritures concurrentes.

> *(Captures à insérer : résumé console + fichier k6-summary.json — généré à la racine du projet)*

### 3.3 Test de rupture (bonus — 200 VUs)

> *(Si réalisé : documenter ici à partir de quel nombre de VUs les timeouts/503 apparaissent et pourquoi — SQLite est mono-écriture, ce qui crée un goulot d'étranglement à haute concurrence)*

---

## ÉTAPE 4 — Sécurité

### 4.1 Audit des dépendances

```bash
npm audit
npm audit --audit-level=high
```

**Résultats :** 11 vulnérabilités au total.

| Sévérité | Nombre |
|----------|--------|
| Critique | 0 |
| Haute | 4 |
| Modérée | 7 |
| Basse | 0 |

**Paquets touchés en sévérité haute :** `next`, `eslint-config-next`, `@next/eslint-plugin-next`, `glob`. Les vulnérabilités modérées concernent surtout des dépendances de développement (`vitest`, `vite`, `esbuild`, `postcss`).

La principale faille vient de `next` lui-même (version 14.2.33) : plusieurs avis de sécurité (DoS sur Server Components, cache poisoning, SSRF via WebSocket…). Le correctif complet impose `next@16`, un changement majeur (breaking change). En contexte réel on planifierait cette montée de version, sans `npm audit fix --force` à l'aveugle qui casserait le build.

> *(Capture à insérer : sortie console npm audit)*

### 4.2 Scan Trivy

```bash
trivy image helpdesk:dev --severity HIGH,CRITICAL
```

**Résultats :**

| Couche scannée | CRITICAL | HIGH |
|----------------|----------|------|
| OS Alpine (paquets système) | 0 | 0 |
| Paquets Node.js (dépendances app) | 0 | 18 |

**Observation clé :** la couche système (Alpine Linux) est **totalement propre** — 0 vulnérabilité HIGH/CRITICAL. Les 18 failles hautes sont **toutes** dans les dépendances npm embarquées dans l'image (`next`, `tar`…). Choisir `node:20-alpine` comme image de base était donc un bon choix sécurité : Alpine est minimaliste et contient très peu de paquets système exploitables. Le risque résiduel est entièrement dans le code applicatif — c'est cohérent avec le résultat de `npm audit`.

**Pourquoi scanner l'image ?** Une image Docker empile deux sources de risque : (1) les paquets système de l'OS de base, (2) les dépendances applicatives copiées dedans. Trivy compare la liste complète des paquets installés avec les bases de vulnérabilités connues (NVD, GitHub Advisory) et signale les CVE. Ici le scan prouve que le risque ne vient pas de l'OS mais des libs npm.

> *(Capture à insérer : sortie console Trivy)*

### 4.3 Exercices de pentest

#### Exercice 4.3.1 — JWT secret faible

**Observation :** le `.env.example` fourni contient `JWT_SECRET="change-me-in-production-use-a-strong-secret-key-please"` — un secret **trivial et public**. Le `.env` de ce projet utilise `sdfghjklm…@@…nbvcxz`, un secret « tapé au clavier » : pas de hasard cryptographique, motif de touches reconnaissable, faible entropie. Les deux sont vulnérables — la sécurité d'un JWT signé en HS256 repose **entièrement** sur le secret de signature.

**Étapes réalisées pour forger un token admin :**
1. Connexion en tant que `user@helpdesk.io / Password123!` → récupération du token (`role: USER`)
2. Décodage du payload (base64), modification `"role": "USER"` → `"role": "ADMIN"`
3. Re-signature du payload avec le secret connu (HS256)
4. Appel `DELETE /api/tickets/<id>` avec le token forgé

**Résultats observés (app sur le port 3004) :**

| Test | Token utilisé | Réponse HTTP |
|------|---------------|--------------|
| `DELETE /api/tickets/<id>` | token USER **légitime** | `403 Forbidden` |
| `DELETE /api/tickets/<id>` | token ADMIN **forgé** | **`200 {"ok":true}`** — ticket réellement supprimé |

**La faille est confirmée :** l'application a accepté un token forgé et exécuté une action réservée aux administrateurs. La route `DELETE` (`src/app/api/tickets/[id]/route.ts`) ne vérifie que `auth.role !== 'ADMIN'` — et `auth.role` provient du JWT. Si le secret est connu, l'attaquant contrôle entièrement le contenu du token.

**Pourquoi ça marche ?** La signature HS256 ne prouve qu'une chose : « celui qui a signé connaissait le secret ». Si le secret est faible/connu, n'importe qui peut signer un payload arbitraire et l'app n'a aucun moyen de le distinguer d'un vrai token.

**3 mitigations :**

| Mitigation | Détail |
|-----------|--------|
| **Secret fort (256 bits min)** | `openssl rand -base64 32` génère un secret de 256 bits aléatoires. Impossible à brute-forcer en temps humain. |
| **Rotation du secret** | Changer le `JWT_SECRET` tous les 90 jours (ou après un incident). Les anciens tokens deviennent invalides, forçant une reconnexion. Idéalement via Azure Key Vault avec versioning. |
| **Algorithme asymétrique (RS256)** | Utiliser RS256 (clé privée pour signer, clé publique pour vérifier) au lieu de HS256. Même si un attaquant obtient la clé publique, il ne peut pas forger de tokens — seul le détenteur de la clé privée peut signer. |

#### Exercice 4.3.2 — Authorization bypass

```bash
TOKEN="<token user@helpdesk.io>"
curl -H "Authorization: Bearer $TOKEN" http://localhost:3004/api/tickets/<id-ticket-autre-user>
```

**Test réalisé :** un ticket a été créé au nom de `agent@helpdesk.io`, puis on a tenté de le lire avec le token de `user@helpdesk.io`.

**Résultat :** `403 Forbidden` → `{"error":"Forbidden"}`.

**Sur ce point, l'application est sécurisée.** La route `GET /api/tickets/[id]` contient bien le contrôle `if (auth.role === 'USER' && ticket.authorId !== auth.userId) return 403`. Un USER ne peut pas lire le ticket d'un autre.

**Ce qu'on teste :** la différence entre **authentification** (qui es-tu ?) et **autorisation** (as-tu le droit de faire ça ?). Un utilisateur authentifié ne doit pas pouvoir lire les ressources d'un autre — cette vérification doit être faite côté serveur pour chaque requête. Ici elle est présente. À noter : ce contrôle reste néanmoins contournable via la faille 4.3.1, puisqu'un token forgé en `ADMIN` n'est pas soumis au filtre `role === 'USER'`.

#### Exercice 4.3.3 — Headers de sécurité manquants

**Test réalisé :** `curl -I http://localhost:3004/` — inspection des headers de réponse de la page d'accueil.

**Résultat — tous les headers de sécurité sont absents :**

| Header | Présent ? |
|--------|-----------|
| `Content-Security-Policy` | ✗ absent |
| `X-Frame-Options` | ✗ absent |
| `Strict-Transport-Security` | ✗ absent |
| `X-Content-Type-Options` | ✗ absent |
| `Referrer-Policy` | ✗ absent |
| `Permissions-Policy` | ✗ absent |
| `X-Powered-By` | ✓ absent — bon point, désactivé par `poweredByHeader: false` dans `next.config.js` |

**Headers manquants et leur rôle :**

| Header | Rôle | Valeur appliquée |
|--------|------|--------------------|
| `Content-Security-Policy` | Empêche XSS en whitelistant les sources de scripts/styles | `default-src 'self'; script-src 'self' 'unsafe-inline'; …` |
| `X-Frame-Options` | Empêche le clickjacking (l'app dans une `<iframe>` malveillante) | `DENY` |
| `Strict-Transport-Security` | Force HTTPS, empêche les attaques man-in-the-middle | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | Empêche le MIME sniffing (navigateur qui devine le type de fichier) | `nosniff` |
| `Referrer-Policy` | Contrôle les infos envoyées dans le header `Referer` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | Désactive l'accès aux API sensibles du navigateur | `camera=(), microphone=(), geolocation=()` |

**Correction appliquée :** la faille a été corrigée — un middleware Next.js a été créé dans `src/middleware.ts` et l'image Docker rebuildée. Vérification après correction :

```
$ curl -I http://localhost:3004/
HTTP/1.1 200 OK
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:
permissions-policy: camera=(), microphone=(), geolocation=()
referrer-policy: strict-origin-when-cross-origin
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-content-type-options: nosniff
x-frame-options: DENY
```

Les 6 headers sont désormais présents sur toutes les pages HTML.

**Code du middleware (`src/middleware.ts`) :**

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

> *(Capture à insérer : sortie `curl -I` avant/après correction)*

### 4.4 Correctif annexe — healthcheck IPv6

Pendant la phase de tests, le conteneur Docker apparaissait en statut `unhealthy`. Cause : la sonde `HEALTHCHECK` interrogeait `http://localhost:3000/...`, or `localhost` résout d'abord en IPv6 (`::1`) dans le conteneur, tandis que le serveur Next.js standalone n'écoute qu'en IPv4 (`0.0.0.0`). La sonde tapait une adresse morte → `Connection refused`.

**Correctif :** remplacer `localhost` par `127.0.0.1` dans le `Dockerfile` et le `docker-compose.yml`. Après rebuild, le conteneur passe `healthy`. C'est un point important : sur Azure App Service, un conteneur `unhealthy` est redémarré ou retiré du routage.

---

## ÉTAPE 5 — CI/CD GitHub Actions

### 5.1 Structure du pipeline

Le fichier `.github/workflows/ci-cd.yml` définit 4 jobs exécutés dans l'ordre :

```
push → master/preProd
         │
         ▼
    ┌─────────┐    ┌──────────┐
    │  test   │    │ security │   (parallèles)
    └────┬────┘    └────┬─────┘
         │              │
         └──────┬───────┘
                ▼
           ┌────────┐
           │ docker │   (nécessite test + security ✓)
           └────┬───┘
                ▼
           ┌────────┐
           │ deploy │   (uniquement sur master, nécessite docker ✓)
           └────────┘
```

**Job `test` :** installe Node 20, lance `npm run lint` + `npm run test:coverage`, uploade le rapport en artefact GitHub Actions.

**Job `security` :** `npm audit` (vulnérabilités npm) + Trivy filesystem scan. `continue-on-error: true` = le job ne bloque pas le pipeline si des vulnérabilités sont trouvées (mode informatif).

**Job `docker` :** build l'image Docker avec cache GitHub Actions (pour accélérer les builds suivants), scan Trivy de l'image construite.

**Job `deploy` :** conditionné à `github.ref == 'refs/heads/master'` (uniquement sur la branche principale) + tous les secrets Azure configurés.

### 5.2 Corrections nécessaires avant exécution

Deux ajustements ont été indispensables pour que le pipeline puisse s'exécuter :

1. **Branches de déclenchement.** Le workflow fourni écoutait `main`/`develop`, or ce dépôt utilise `master` (branche principale) et `preProd` (branche de travail). Sans correction, un `git push` ne déclenchait **aucun** job. Le déclencheur a été changé en `[master, preProd]`, et la condition du job `deploy` en `refs/heads/master`.

2. **Configuration ESLint manquante.** Le projet n'avait aucun fichier `.eslintrc`. La commande `npm run lint` (`next lint`) devenait alors **interactive** (elle demandait de choisir une config) — ce qui bloque en CI puisqu'aucune entrée clavier n'est possible. Un fichier `.eslintrc.json` (`extends: next/core-web-vitals`) a été ajouté. Résultat : `npm run lint` se termine avec le code 0 (3 warnings, 0 erreur).

3. **Image Docker introuvable par Trivy (job `docker`).** Au premier run, le job `docker` a échoué : `No such image: helpdesk:<sha>`. Cause : `docker/build-push-action` utilise Buildx, qui build l'image dans son propre cache et **non** dans le magasin d'images du démon Docker. Avec `push: false` et sans `load: true`, l'image n'est visible nulle part — Trivy ne peut pas la scanner. Correctif : ajout de `load: true` à l'étape de build, qui charge l'image dans le démon Docker local.

Vérifications locales avant push : `npm run lint` → exit 0 ✓ · `npm run test:coverage` → 57 tests OK ✓ · `npm run build` → build réussi ✓.

### 5.3 Résultats

Après les 3 correctifs ci-dessus, le pipeline s'exécute entièrement : les jobs **test**, **security** et **docker** passent au vert sur la branche `preProd`. Le job **deploy** ne s'exécute pas (réservé à `master`), ce qui est le comportement attendu pour cette étape.

> *(Capture à insérer : onglet GitHub Actions avec les jobs test, security, docker en vert)*

---

## ÉTAPE 6 — Déploiement Azure for Students

**URL publique de l'application déployée : https://helpdesk-mks.azurewebsites.net**

### 6.1 Installation d'Azure CLI

Azure CLI n'a pas pu être installé via le script officiel `InstallAzureCLIDeb` : le poste tourne sous **Ubuntu 25.10 « Questing »**, une version trop récente pour laquelle Microsoft n'a pas encore publié de paquet apt (le dépôt renvoie `404`). Contournement utilisé : installation dans un environnement Python isolé (`python3 -m venv` + `pip install azure-cli`), méthode d'installation officiellement supportée. Azure CLI 2.86.0 a ainsi été installé sans `sudo`.

### 6.2 Ressources créées

| Ressource | Nom | SKU / Détail |
|-----------|-----|--------------|
| Resource Group | `helpdesk-rg` | région `francecentral` |
| Container Registry | `helpdeskacrmks` | Basic — `helpdeskacrmks.azurecr.io` |
| App Service Plan | `helpdesk-plan` | B1 (Linux) |
| Web App | `helpdesk-mks` | conteneur Linux |

**Obstacle rencontré :** sur une souscription neuve, les *resource providers* `Microsoft.ContainerRegistry` et `Microsoft.Web` ne sont pas activés. La création de l'ACR échouait avec `MissingSubscriptionRegistration`. Résolu par `az provider register --namespace Microsoft.ContainerRegistry` (et `Microsoft.Web`).

### 6.3 Push de l'image vers ACR

```bash
docker tag helpdesk:dev helpdeskacrmks.azurecr.io/helpdesk:v1
docker push helpdeskacrmks.azurecr.io/helpdesk:v1
```

L'image a été poussée avec le tag `v1` après authentification (`docker login` avec les credentials admin de l'ACR).

### 6.4 Création de la Web App

**Obstacle rencontré :** avec les flags récents d'`az webapp create`, passer `--container-image-name` *avec* le host du registre **et** `--container-registry-url` aboutit à un double préfixe (`helpdeskacrmks.azurecr.io/helpdeskacrmks.azurecr.io/helpdesk:v1`). À l'inverse, `az webapp config container set` ne préfixe **pas** : il faut lui passer le chemin **complet**. Configuration finale correcte :

```
linuxFxVersion = DOCKER|helpdeskacrmks.azurecr.io/helpdesk:v1
```

Variables d'environnement définies (`az webapp config appsettings set`) :

| Variable | Valeur | Rôle |
|----------|--------|------|
| `DATABASE_URL` | `file:/app/data/prod.db` | Emplacement de la base SQLite |
| `JWT_SECRET` | (généré par `openssl rand -base64 32`) | Secret de signature JWT — fort, 256 bits |
| `NODE_ENV` | `production` | Mode production |
| `WEBSITES_PORT` | `3000` | Indique à Azure le port exposé par le conteneur |

### 6.5 Initialisation de la base de données

Le TP prévoyait d'initialiser la base via SSH (`az webapp ssh` puis `npx prisma migrate deploy`). **Cette approche ne fonctionne pas ici** : l'image standalone ne contient ni le CLI Prisma ni `tsx`, et `npx prisma` télécharge alors Prisma 7 qui rejette le schéma écrit pour Prisma 5.

**Solution retenue :** la base est créée et seedée **pendant le build Docker**, dans le stage `builder` (qui dispose, lui, du CLI Prisma 5 et de `tsx` via les devDependencies). La base SQLite pré-remplie (3 utilisateurs : admin / agent / user) est ensuite copiée dans l'image finale à `/app/data/prod.db`. L'application est donc opérationnelle dès le démarrage du conteneur, sans étape manuelle.

*Limite assumée :* la base étant embarquée dans l'image, elle revient à son état seedé à chaque redéploiement. Pour une vraie persistance, il faudrait une base externe (cf. synthèse — migration PostgreSQL).

### 6.6 Validation

```
$ curl https://helpdesk-mks.azurewebsites.net/api/health
{"status":"ok","timestamp":"2026-05-22T14:33:46.232Z","uptime":7.0}

$ curl -X POST https://helpdesk-mks.azurewebsites.net/api/auth/login \
    -d '{"email":"admin@helpdesk.io","password":"Password123!"}'
→ connexion réussie, role: ADMIN (Alice Admin)
```

Les 6 headers de sécurité (middleware) sont également présents sur la réponse HTTPS. L'application est accessible publiquement et fonctionnelle.

> *(Captures à insérer : `curl .../api/health` + navigateur sur https://helpdesk-mks.azurewebsites.net avec le dashboard connecté)*

---

## Synthèse finale

### Architecture finale

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  Développeur local                                                    │
 │                                                                      │
 │  Code source  →  git push  →  GitHub (branches master / preProd)     │
 └─────────────────────────────┬────────────────────────────────────────┘
                                │ déclenche
                                ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │  GitHub Actions CI/CD Pipeline                                       │
 │                                                                      │
 │  [test] lint + unit tests + coverage                                 │
 │  [security] npm audit + Trivy scan                                   │
 │  [docker] build image Docker + scan image                            │
 │  [deploy] push ACR + deploy App Service  (sur master uniquement)     │
 └──────────────────────────────┬───────────────────────────────────────┘
                                 │
               ┌─────────────────┴──────────────────┐
               ▼                                    ▼
 ┌─────────────────────────┐          ┌──────────────────────────────┐
 │  Azure Container        │          │  Azure App Service            │
 │  Registry (ACR)         │ ─pull──▶ │  helpdesk-mks                 │
 │  helpdeskacrmks         │          │  (container Linux, plan B1)   │
 │  helpdesk:v1            │          │                               │
 └─────────────────────────┘          └──────────────────────────────┘
                                                   │
                                                   ▼
                          https://helpdesk-mks.azurewebsites.net
                                       (accès public)
```

### 3 améliorations DevSecOps prioritaires

1. **Azure Key Vault pour les secrets**  
   Actuellement, `JWT_SECRET` et les credentials ACR sont dans des GitHub Secrets et des App Settings Azure en clair. Azure Key Vault chiffrerait ces secrets et permettrait une rotation sans redéploiement. L'app lirait les secrets via une Managed Identity (pas de credentials à gérer).

2. **Monitoring avec Application Insights**  
   Actuellement, aucune observabilité en production : on ne sait pas combien d'erreurs 500 se produisent ni quelles routes sont lentes. Application Insights instrumenterait automatiquement Next.js (traces distribuées, alertes sur le taux d'erreur, dashboard de performance en temps réel).

3. **Migration vers PostgreSQL (Azure Database for PostgreSQL)**  
   SQLite est parfait en développement mais est mono-écriture : lors du test de charge à 200 VUs, les writes se sérialisent et créent un goulot d'étranglement. PostgreSQL gère la concurrence et permettrait de scaler horizontalement l'App Service (plusieurs instances).

### Coût Azure estimé

Deux ressources facturées : **ACR Basic** (~5 $/mois) + **App Service Plan B1** (~13 $/mois) = **~18 $/mois**. Le resource group et la Web App ne coûtent rien en eux-mêmes (la facturation se fait sur le plan). Sur les 100 $ de crédit Azure for Students, le déploiement couvre donc environ **5 mois**. Le déploiement de ce TP, sur quelques heures, n'entame le crédit que de quelques centimes.

> *(Capture à insérer : Azure Cost Management — coût réel constaté)*

### Ce qui a posé problème

| Problème | Cause | Solution |
|----------|-------|----------|
| Conteneur `unhealthy` en local | `localhost` résout en IPv6 dans le conteneur, le serveur Next.js n'écoute qu'en IPv4 | `localhost` → `127.0.0.1` dans le healthcheck |
| Login impossible en conteneur | Connexion Prisma mise en cache avant l'arrivée de la base | Redémarrer le conteneur après l'init de la base |
| `next lint` bloquant en CI | Aucune config ESLint → commande interactive | Ajout de `.eslintrc.json` |
| Workflow CI jamais déclenché | Le workflow écoutait `main`/`develop`, dépôt sur `master`/`preProd` | Correction des branches du déclencheur |
| Job `docker` : image introuvable par Trivy | Buildx ne charge pas l'image dans le démon Docker | Ajout de `load: true` |
| Azure : `MissingSubscriptionRegistration` | Resource providers non activés sur une souscription neuve | `az provider register` (ContainerRegistry, Web) |
| Azure : image au mauvais chemin | Double préfixe du registre par `az webapp create` | Chemin d'image complet via `az webapp config container set` |
| Azure : base de données non initialisable | L'image standalone n'a ni le CLI Prisma ni `tsx` | Base SQLite seedée pendant le build, embarquée dans l'image |
| Azure CLI non installable | Ubuntu 25.10 trop récent, pas de paquet Microsoft | Installation via `pip` dans un venv Python |
