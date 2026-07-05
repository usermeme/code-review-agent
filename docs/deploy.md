# Deploying to Google Cloud

Target architecture: **Cloud Run** (the webhook service) + **Memorystore Redis** (repo-context
cache) + **Cloud SQL Postgres with pgvector** (discussion memory) + **Secret Manager** (all
credentials) + **Artifact Registry** (images). Deploys run from GitHub Actions
(`.github/workflows/deploy.yml`) via Workload Identity Federation — no service-account JSON
keys stored in GitHub.

All commands below are one-time setup. Replace `PROJECT_ID` and pick a `REGION` (e.g.
`europe-west3`).

## 1. APIs and Artifact Registry

```sh
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  sqladmin.googleapis.com redis.googleapis.com secretmanager.googleapis.com \
  vpcaccess.googleapis.com iamcredentials.googleapis.com

gcloud artifacts repositories create code-review-agent \
  --repository-format=docker --location=REGION
```

## 2. Databases

```sh
# Cloud SQL Postgres (smallest tier; scale later)
gcloud sql instances create cra-postgres \
  --database-version=POSTGRES_16 --tier=db-g1-small --region=REGION
gcloud sql databases create reviews --instance=cra-postgres
gcloud sql users set-password postgres --instance=cra-postgres --password='<DB_PASSWORD>'

# Memorystore Redis + the VPC connector Cloud Run needs to reach it
gcloud redis instances create cra-redis --size=1 --region=REGION
gcloud compute networks vpc-access connectors create cra-connector \
  --region=REGION --range=10.8.0.0/28
gcloud redis instances describe cra-redis --region=REGION --format='value(host,port)'
```

pgvector is available on Cloud SQL Postgres 16 out of the box; the app's boot-time migration
runs `CREATE EXTENSION IF NOT EXISTS vector` itself.

## 3. Secrets

```sh
create() { printf '%s' "$2" | gcloud secrets create "$1" --data-file=-; }

create cra-github-app-id        '<APP_ID>'
create cra-github-private-key   "$(base64 -i app-private-key.pem | tr -d '\n')"
create cra-webhook-secret       '<WEBHOOK_SECRET>'
create cra-google-api-key       '<GOOGLE_API_KEY>'
create cra-anthropic-api-key    '<ANTHROPIC_API_KEY>'
# Cloud SQL over the built-in socket mount (--add-cloudsql-instances in the deploy):
create cra-database-url 'postgres://postgres:<DB_PASSWORD>@/reviews?host=/cloudsql/PROJECT_ID:REGION:cra-postgres'
create cra-redis-url    'redis://<REDIS_HOST>:6379'
```

## 4. Deploy service account + Workload Identity Federation

```sh
gcloud iam service-accounts create cra-deployer
DEPLOY_SA="cra-deployer@PROJECT_ID.iam.gserviceaccount.com"

for role in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member="serviceAccount:$DEPLOY_SA" --role="$role"
done

# Runtime service account (what the Cloud Run service runs as) needs the secrets + SQL:
RUNTIME_SA="$(gcloud iam service-accounts list --filter='compute' --format='value(email)')"
for role in roles/secretmanager.secretAccessor roles/cloudsql.client; do
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member="serviceAccount:$RUNTIME_SA" --role="$role"
done

# WIF pool for GitHub Actions
gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github-oidc \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='usermeme/code-review-agent'"

PROJECT_NUMBER=$(gcloud projects describe PROJECT_ID --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/usermeme/code-review-agent"
```

## 5. GitHub repository variables

Settings → Secrets and variables → Actions → **Variables**:

| Variable           | Value                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `GCP_PROJECT_ID`   | your project id                                                                               |
| `GCP_REGION`       | e.g. `europe-west3`                                                                           |
| `GCP_DEPLOY_SA`    | `cra-deployer@PROJECT_ID.iam.gserviceaccount.com`                                             |
| `GCP_WIF_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-oidc` |

## 6. First deploy and webhook

Push to `main` (or run the Deploy workflow manually). Then take the service URL:

```sh
gcloud run services describe code-review-agent --region=REGION --format='value(status.url)'
```

and set `https://<service-url>/webhook` as the **Webhook URL** in your GitHub App settings.
From then on: PR opened / left draft → automatic review; `/review` comment → re-review.

Notes:

- `--no-cpu-throttling` + `--min-instances 1` matter: the service replies 202 and keeps
  reviewing in the background; throttled CPU would freeze those reviews.
- `--allow-unauthenticated` is required for GitHub webhooks; the HMAC signature check is the
  auth. Set `ADMIN_TOKEN` as an extra secret if you expose `/admin/backfill/...` publicly.
- Migrations run automatically at boot (`buildServices` → `runMigrations`).
