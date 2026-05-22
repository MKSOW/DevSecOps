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

> *(Captures à insérer : résultat npm audit)*

### 4.2 Scan Trivy

```bash
trivy image helpdesk:dev --severity HIGH,CRITICAL
```

> *(Captures à insérer : résultat Trivy)*

**Pourquoi scanner l'image ?** L'image Docker est construite sur `node:20-alpine`. Alpine Linux contient des paquets système (openssl, libc, etc.) qui peuvent avoir des CVE (vulnérabilités connues). Trivy compare la liste des paquets installés avec la base de données NVD (National Vulnerability Database) et signale les failles connues.

### 4.3 Exercices de pentest

#### Exercice 4.3.1 — JWT secret faible

**Observation :** le `.env.example` contient `JWT_SECRET="change-me-in-production-use-a-strong-secret-key-please"` — c'est une clé de sécurité **triviale, publique, et prévisible**.

**Étapes pour forger un token admin :**
1. Se connecter en tant que `user@helpdesk.io / Password123!`
2. Récupérer le token depuis localStorage ou l'onglet Network de DevTools
3. Aller sur [jwt.io](https://jwt.io), coller le token
4. Dans le payload, modifier `"role": "USER"` → `"role": "ADMIN"`
5. Dans "Verify Signature", saisir le secret `change-me-in-production-use-a-strong-secret-key-please`
6. Copier le nouveau token signé
7. Tester : `curl -X DELETE -H "Authorization: Bearer <token_forgé>" http://localhost:3000/api/tickets/<id>`

**Résultat attendu :** Si le secret dans `.env` est le même que dans le `.env.example`, la requête DELETE **réussit**. L'application accepte un token forgé avec des privilèges élevés.

**Pourquoi ça marche ?** La sécurité du JWT repose **entièrement** sur le secret de signature. Si le secret est connu, n'importe qui peut signer un payload arbitraire.

**3 mitigations :**

| Mitigation | Détail |
|-----------|--------|
| **Secret fort (256 bits min)** | `openssl rand -base64 32` génère un secret de 256 bits aléatoires. Impossible à brute-forcer en temps humain. |
| **Rotation du secret** | Changer le `JWT_SECRET` tous les 90 jours (ou après un incident). Les anciens tokens deviennent invalides, forçant une reconnexion. Idéalement via Azure Key Vault avec versioning. |
| **Algorithme asymétrique (RS256)** | Utiliser RS256 (clé privée pour signer, clé publique pour vérifier) au lieu de HS256. Même si un attaquant obtient la clé publique, il ne peut pas forger de tokens — seul le détenteur de la clé privée peut signer. |

#### Exercice 4.3.2 — Authorization bypass

```bash
TOKEN="<votre token user@helpdesk.io>"
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/tickets/<id-ticket-autre-user>
```

> *(Captures + résultat : l'API retourne-t-elle le ticket d'un autre utilisateur ?)*

**Ce qu'on teste :** la différence entre **authentification** (qui es-tu ?) et **autorisation** (as-tu le droit de faire ça ?). Un utilisateur authentifié ne doit pas pouvoir lire les ressources d'un autre utilisateur — c'est une vérification d'autorisation qui doit être faite côté serveur pour chaque requête.

#### Exercice 4.3.3 — Headers de sécurité manquants

> *(Captures à insérer : DevTools → Network → headers de réponse)*

**Headers manquants et leur rôle :**

| Header | Rôle | Valeur recommandée |
|--------|------|--------------------|
| `Content-Security-Policy` | Empêche XSS en whitelistant les sources de scripts/styles | `default-src 'self'; script-src 'self'` |
| `X-Frame-Options` | Empêche le clickjacking (l'app dans une `<iframe>` malveillante) | `DENY` |
| `Strict-Transport-Security` | Force HTTPS, empêche les attaques man-in-the-middle | `max-age=63072000; includeSubDomains` |
| `X-Content-Type-Options` | Empêche le MIME sniffing (navigateur qui devine le type de fichier) | `nosniff` |
| `Referrer-Policy` | Contrôle les infos envoyées dans le header `Referer` | `strict-origin-when-cross-origin` |

**Middleware Next.js pour ajouter ces headers :**

```typescript
// src/middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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

---

## ÉTAPE 5 — CI/CD GitHub Actions

### 5.1 Structure du pipeline

Le fichier `.github/workflows/ci-cd.yml` définit 4 jobs exécutés dans l'ordre :

```
push → main/develop
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
           │ deploy │   (uniquement sur main, nécessite docker ✓)
           └────────┘
```

**Job `test` :** installe Node 20, lance `npm run lint` + `npm run test:coverage`, uploade le rapport en artefact GitHub Actions.

**Job `security` :** `npm audit` (vulnérabilités npm) + Trivy filesystem scan. `continue-on-error: true` = le job ne bloque pas le pipeline si des vulnérabilités sont trouvées (mode informatif).

**Job `docker` :** build l'image Docker avec cache GitHub Actions (pour accélérer les builds suivants), scan Trivy de l'image construite.

**Job `deploy` :** conditionné à `github.ref == 'refs/heads/main'` (uniquement sur la branche principale) + tous les secrets Azure configurés.

### 5.2 Résultats

> *(Capture à insérer : onglet GitHub Actions avec les jobs test, security, docker en vert)*

---

## ÉTAPE 6 — Déploiement Azure for Students

> *(Sections à compléter après le déploiement)*

### 6.1 Ressources créées

| Ressource | Nom | SKU |
|-----------|-----|-----|
| Resource Group | `helpdesk-rg` | N/A |
| Container Registry | `helpdesk-acr<initiales>` | Basic |
| App Service Plan | `helpdesk-plan` | B1 (Linux) |
| Web App | `helpdesk-<initiales>` | — |

### 6.6 Validation

> *(Captures à insérer : `curl https://<url>.azurewebsites.net/api/health` + navigateur avec dashboard)*

---

## Synthèse finale

### Architecture finale

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  Développeur local                                                    │
 │                                                                      │
 │  Code source  →  git push  →  GitHub (main branch)                  │
 └─────────────────────────────┬────────────────────────────────────────┘
                                │ déclenche
                                ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │  GitHub Actions CI/CD Pipeline                                       │
 │                                                                      │
 │  [test] lint + unit tests + coverage                                 │
 │  [security] npm audit + Trivy scan                                   │
 │  [docker] build image Docker + scan image                            │
 │  [deploy] push ACR + deploy App Service                              │
 └──────────────────────────────┬───────────────────────────────────────┘
                                 │
               ┌─────────────────┴──────────────────┐
               ▼                                    ▼
 ┌─────────────────────────┐          ┌──────────────────────────────┐
 │  Azure Container        │          │  Azure App Service            │
 │  Registry (ACR)         │ ─pull──▶ │  helpdesk-<initiales>         │
 │  helpdesk:v1.2.3        │          │  (container Linux)            │
 └─────────────────────────┘          └──────────────────────────────┘
                                                   │
                                                   ▼
                                      https://<nom>.azurewebsites.net
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

> *(À compléter après déploiement : coût dans Azure Cost Management)*
> 
> Estimation : ACR Basic (~5$/mois) + App Service B1 (~13$/mois) = **~18$/mois**. Avec 100$ de crédit étudiant, cela couvre 5 mois.

### Ce qui a posé problème

> *(À compléter avec les obstacles rencontrés et les solutions trouvées)*
