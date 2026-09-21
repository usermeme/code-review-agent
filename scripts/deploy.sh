#!/usr/bin/env bash
set -e

echo "========================================="
echo "🤖 AI Code Review Agent Deployment Script"
echo "========================================="
echo ""

# 1. Gather Environment Variables (only prompt if missing)
if [ -z "$PROJECT_ID" ]; then
  read -r -p "Enter your Google Cloud Project ID: " PROJECT_ID
fi
if [ -z "$PROJECT_ID" ]; then
  echo "Error: Project ID is required."
  exit 1
fi

if [ -z "$REGION" ]; then
  read -r -p "Enter Google Cloud Region [us-central1]: " input
  REGION=${input:-us-central1}
fi

echo ""
echo "--- Git Provider Setup ---"
if [ -z "$GIT_ADAPTER" ]; then
  read -r -p "Enter Git Adapter [github]: " input
  GIT_ADAPTER=${input:-github}
fi

if [ -z "$GIT_ADAPTER_WEBHOOK_SECRET" ]; then
  read -r -p "Enter Git Webhook Secret (random string): " GIT_ADAPTER_WEBHOOK_SECRET
fi
if [ -z "$GIT_ADAPTER_WEBHOOK_SECRET" ]; then
  echo "Error: Webhook secret is required."
  exit 1
fi

if [ -z "$GIT_ADAPTER_TOKEN" ]; then
  read -r -p "Enter Git Personal Access Token (e.g. ghp_...): " GIT_ADAPTER_TOKEN
fi
if [ -z "$GIT_ADAPTER_TOKEN" ]; then
  echo "Error: Git token is required."
  exit 1
fi

echo ""
echo "--- AI & Internal Secrets ---"
if [ -z "$GEMINI_API_KEY" ]; then
  read -r -p "Enter Google Gemini API Key: " GEMINI_API_KEY
fi
if [ -z "$GEMINI_API_KEY" ]; then
  echo "Error: Gemini API Key is required."
  exit 1
fi

if [ -z "$PUBSUB_SECRET_TOKEN" ]; then
  read -r -p "Enter internal Pub/Sub Secret Token (random string): " PUBSUB_SECRET_TOKEN
fi
if [ -z "$PUBSUB_SECRET_TOKEN" ]; then
  echo "Error: Pub/Sub Secret Token is required."
  exit 1
fi

if [ -z "$REVIEW_MODEL" ]; then
  read -r -p "Enter Review Model [gemini-3.1-pro]: " input
  REVIEW_MODEL=${input:-gemini-3.1-pro}
fi

echo ""
echo "========================================="
echo "🚀 Starting Deployment to $PROJECT_ID..."
echo "========================================="

# Set active project
gcloud config set project "$PROJECT_ID"

echo ""
echo "--> 1. Provisioning Infrastructure with Terraform..."
cd infra
terraform init
terraform apply -var="project_id=$PROJECT_ID" -var="region=$REGION" -auto-approve
cd ..

echo ""
echo "--> 2. Injecting Secrets into Secret Manager..."
# Helper function to only add a new secret version if the value has changed
inject_secret_if_changed() {
  local secret_name=$1
  local new_value=$2
  
  local existing_value=""
  if gcloud secrets versions describe latest --secret="$secret_name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    existing_value=$(gcloud secrets versions access latest --secret="$secret_name" --project="$PROJECT_ID")
  fi
  
  if [ "$existing_value" != "$new_value" ]; then
    echo "Updating secret $secret_name (creating new version)..."
    echo -n "$new_value" | gcloud secrets versions add "$secret_name" --data-file=-
  else
    echo "Secret $secret_name is already up to date (no changes detected)."
  fi
}

inject_secret_if_changed "git-adapter-webhook-secret" "$GIT_ADAPTER_WEBHOOK_SECRET"
inject_secret_if_changed "git-adapter-token-secret" "$GIT_ADAPTER_TOKEN"
inject_secret_if_changed "google-api-key" "$GEMINI_API_KEY"

echo ""
echo "--> 3. Building Application Workspace..."
pnpm install
pnpm run build

echo ""
echo "--> 4. Deploying Fastify Gateway..."
gcloud run deploy gateway-service \
  --source dist/apps/gateway \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "APP_NAME=gateway,BUILD_CONTEXT_TOPIC=build-context-topic,CONTEXT_READY_TOPIC=context-ready-topic,REVIEW_CODE_TOPIC=review-code-topic,PUBSUB_SECRET_TOKEN=$PUBSUB_SECRET_TOKEN,GIT_ADAPTER=$GIT_ADAPTER" \
  --set-secrets="GIT_ADAPTER_WEBHOOK_SECRET=git-adapter-webhook-secret:latest,GIT_ADAPTER_TOKEN=git-adapter-token-secret:latest" \
  --quiet

GATEWAY_URL=$(gcloud run services describe gateway-service --region "$REGION" --format 'value(status.url)')
echo "Gateway deployed at: $GATEWAY_URL"

echo ""
echo "--> 5. Deploying AI Agents..."
export GEMINI_API_KEY
export GATEWAY_URL
export REVIEW_MODEL
export GIT_ADAPTER

# Workaround removed since @google/adk-devtools is patched natively!

echo "Deploying Context Builder..."
npx adk deploy cloud_run dist/apps/agent-context-builder --project "$PROJECT_ID" --service_name agent-context-builder --region "$REGION"
gcloud run services update agent-context-builder --update-env-vars "GOOGLE_GENAI_USE_VERTEXAI=0,GATEWAY_URL=$GATEWAY_URL,REVIEW_MODEL=$REVIEW_MODEL,GIT_ADAPTER=$GIT_ADAPTER" --set-secrets="GEMINI_API_KEY=google-api-key:latest,GIT_ADAPTER_TOKEN=git-adapter-token-secret:latest" --region "$REGION" --quiet

echo "Deploying Code Reviewer..."
npx adk deploy cloud_run dist/apps/agent-code-reviewer --project "$PROJECT_ID" --service_name agent-code-reviewer --region "$REGION"
gcloud run services update agent-code-reviewer --update-env-vars "GOOGLE_GENAI_USE_VERTEXAI=0,GATEWAY_URL=$GATEWAY_URL,REVIEW_MODEL=$REVIEW_MODEL,GIT_ADAPTER=$GIT_ADAPTER" --set-secrets="GEMINI_API_KEY=google-api-key:latest,GIT_ADAPTER_TOKEN=git-adapter-token-secret:latest" --region "$REGION" --quiet

echo ""
echo "--> 6. Wiring Up Pub/Sub Subscriptions..."
set +e
gcloud pubsub subscriptions create context-ready-sub \
  --topic=context-ready-topic \
  --push-endpoint="$GATEWAY_URL/api/v1/internal/pubsub?token=$PUBSUB_SECRET_TOKEN" \
  --ack-deadline=600 2>/dev/null || gcloud pubsub subscriptions modify-push-config context-ready-sub \
  --push-endpoint="$GATEWAY_URL/api/v1/internal/pubsub?token=$PUBSUB_SECRET_TOKEN" 2>/dev/null

gcloud pubsub subscriptions create review-result-sub \
  --topic=review-result-topic \
  --push-endpoint="$GATEWAY_URL/api/v1/review/results?token=$PUBSUB_SECRET_TOKEN" \
  --ack-deadline=600 2>/dev/null || gcloud pubsub subscriptions modify-push-config review-result-sub \
  --push-endpoint="$GATEWAY_URL/api/v1/review/results?token=$PUBSUB_SECRET_TOKEN" 2>/dev/null
set -e

echo ""
echo "========================================="
echo "✅ Deployment Complete!"
echo "========================================="
echo "Final Step: Configure your Git Provider Webhook"
echo "Payload URL: $GATEWAY_URL/api/v1/webhooks"
echo "Secret:      (the secret you entered above)"
echo "Events:      Pull requests, Issue comments"
echo "========================================="
