# Helpdesk — Plateforme de gestion de tickets

Application web fullstack de gestion de tickets de support, utilisée comme
support du TP DevSecOps (conteneurisation, tests, sécurité, CI/CD, déploiement
Azure).

**Application déployée :** https://helpdesk-mks.azurewebsites.net

> L'énoncé complet du TP se trouve dans [`TP-ENONCE.md`](./TP-ENONCE.md).
> Le compte rendu détaillé du travail réalisé est dans [`RAPPORT.md`](./RAPPORT.md).

---

## Stack technique

| Domaine | Technologie |
|---------|-------------|
| Framework | Next.js 14 (App Router) + TypeScript |
| Style | Tailwind CSS |
| Base de données | SQLite via Prisma ORM |
| Authentification | JWT (jsonwebtoken) + bcrypt |
| Tests unitaires | Vitest |
| Tests de charge | k6 |
| Conteneurisation | Docker (multi-stage) + Docker Compose |
| Sécurité | npm audit, Trivy, middleware de headers |
| CI/CD | GitHub Actions |
| Hébergement | Azure App Service + Azure Container Registry |

## Structure du projet

```
support-tickets/
├── src/
│   ├── app/              # Pages et routes API (App Router)
│   │   ├── api/          # health, auth, tickets
│   │   ├── dashboard/    # tableau de bord
│   │   └── ...           # login, register, tickets/[id]
│   ├── components/       # composants React
│   ├── lib/              # logique métier (auth, validators, permissions, prisma)
│   └── middleware.ts     # headers de sécurité HTTP
├── prisma/
│   ├── schema.prisma     # modèle de données (User, Ticket, Comment)
│   ├── migrations/       # migrations SQL
│   └── seed.ts           # données de démo
├── tests/unit/           # tests Vitest
├── k6/                   # scripts de test de charge
├── Dockerfile            # build multi-stage
├── docker-compose.yml
└── .github/workflows/    # pipeline CI/CD
```

## Démarrage en local (sans Docker)

```bash
npm install                              # dépendances
cp .env.example .env                     # variables d'environnement
npx prisma migrate dev --name init       # base de données
npx prisma db seed                       # données de démo
npm run dev                              # serveur de développement
```

L'application est ensuite disponible sur http://localhost:3000.

## Lancement avec Docker

```bash
# Build de l'image
docker build -t helpdesk:dev .

# Lancement du conteneur
docker run -d -p 3000:3000 \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  --name helpdesk-container helpdesk:dev

# Vérification
curl http://localhost:3000/api/health
```

Ou avec Docker Compose :

```bash
docker compose up -d --build
docker compose logs -f app
```

L'image utilise un build multi-stage (`deps`, `builder`, `runner`) et embarque
une base SQLite déjà initialisée. Elle fait environ 235 Mo et tourne sous un
utilisateur non-root.

## Comptes de démonstration

| Rôle  | Email             | Mot de passe |
|-------|-------------------|--------------|
| ADMIN | admin@helpdesk.io | Password123! |
| AGENT | agent@helpdesk.io | Password123! |
| USER  | user@helpdesk.io  | Password123! |

## Endpoints API

| Méthode | Route                | Auth | Description                  |
|---------|----------------------|------|------------------------------|
| GET     | `/api/health`        | Non  | Sonde de santé               |
| POST    | `/api/auth/register` | Non  | Inscription                  |
| POST    | `/api/auth/login`    | Non  | Connexion, renvoie un JWT    |
| GET     | `/api/tickets`       | Oui  | Liste des tickets            |
| POST    | `/api/tickets`       | Oui  | Création d'un ticket         |
| GET     | `/api/tickets/[id]`  | Oui  | Détail d'un ticket           |
| PATCH   | `/api/tickets/[id]`  | Oui  | Modification d'un ticket     |
| DELETE  | `/api/tickets/[id]`  | Oui  | Suppression (ADMIN seulement)|

## Tests

```bash
npm test                 # tests unitaires (57 tests)
npm run test:coverage    # tests + rapport de couverture
```

Les tests couvrent la logique métier de `src/lib` : authentification (JWT,
hachage bcrypt), validation des schémas (Zod) et permissions RBAC.

## Tests de charge (k6)

```bash
k6 run k6/smoke-test.js     # vérification rapide (1 VU, 10s)
k6 run k6/load-test.js      # montée en charge (jusqu'à 50 VUs sur 4 min)
```

Si l'application tourne sur un autre port que 3000 :

```bash
k6 run -e BASE_URL=http://localhost:3004 k6/load-test.js
```

## Sécurité

```bash
npm audit --audit-level=high          # audit des dépendances npm
trivy image helpdesk:dev --severity HIGH,CRITICAL   # scan de l'image
```

Un middleware (`src/middleware.ts`) ajoute les headers de sécurité HTTP
(Content-Security-Policy, X-Frame-Options, HSTS, X-Content-Type-Options,
Referrer-Policy, Permissions-Policy).

## CI/CD

Le pipeline GitHub Actions (`.github/workflows/ci-cd.yml`) exécute 4 jobs :

1. **test** — lint ESLint + tests unitaires avec couverture
2. **security** — `npm audit` + scan Trivy du système de fichiers
3. **docker** — build de l'image Docker + scan Trivy de l'image
4. **deploy** — build, push sur l'ACR et redéploiement de la Web App
   (uniquement sur la branche `master`)

## Déploiement Azure

L'application tourne sur Azure App Service à partir d'une image stockée dans
Azure Container Registry. Le déploiement continu se fait via un webhook ACR :
chaque push de l'image taggée `:latest` déclenche un redéploiement automatique
de la Web App.

## Scripts npm

```bash
npm run dev              # serveur de développement
npm run build            # build de production
npm run start            # serveur de production
npm run lint             # ESLint
npm test                 # tests unitaires
npm run test:coverage    # tests + couverture
npm run prisma:migrate   # migrations de la base
npm run prisma:seed      # données de démo
```
