#!/usr/bin/env bash
# ==============================================================================
# Code Review Agent - Google Cloud Production Infrastructure Setup
# ==============================================================================
# This script provisions the required GCP APIs, Firestore database, and Pub/Sub
# topics and push subscriptions for production Google Cloud Run deployment.
# ==============================================================================

set -euo pipefail

# 1. Validation
if ! command -v gcloud &> /dev/null; then
  echo "Error: gcloud CLI is required but not installed." >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [ -z "$PROJECT_ID" ]; then
  echo "Error: PROJECT_ID is not set. Run 'gcloud config set project <ID>' or export PROJECT_ID=<ID>." >&2
  exit 1
fi

REGION="${REGION:-us-central1}"
PUBSUB_SECRET_TOKEN="${PUBSUB_SECRET_TOKEN:-$(openssl rand -hex 20)}"
GATEWAY_URL="${GATEWAY_URL:-}"

echo "=========================================================="
echo " Setting up Code Review Agent GCP Production Infrastructure"
echo " Project: $PROJECT_ID"
echo " Region:  $REGION"
echo "=========================================================="

# 2. Enable Required APIs
echo "--> Enabling Google Cloud APIs..."
gcloud services enable \
  run.googleapis.com \
  pubsub.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  --project="$PROJECT_ID"

# 3. Create Firestore Native Database
echo "--> Ensuring Firestore (Native Mode) exists..."
if ! gcloud firestore databases describe --project="$PROJECT_ID" &>/dev/null; then
  echo "Creating Firestore database in $REGION..."
  gcloud firestore databases create \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --type=firestore-native || true
else
  echo "Firestore database already exists."
fi

# 4. Create Pub/Sub Topics
echo "--> Creating Pub/Sub topics..."
TOPICS=(
  "build-context-topic"
  "context-ready-topic"
  "review-code-topic"
  "review-result-topic"
)

for topic in "${TOPICS[@]}"; do
  if ! gcloud pubsub topics describe "$topic" --project="$PROJECT_ID" &>/dev/null; then
    echo "Creating topic: $topic"
    gcloud pubsub topics create "$topic" --project="$PROJECT_ID"
  else
    echo "Topic $topic already exists."
  fi
done

# 5. Wire Push Subscriptions if Gateway URL is provided
if [ -n "$GATEWAY_URL" ]; then
  echo "--> Wiring Pub/Sub Push Subscriptions to Gateway ($GATEWAY_URL)..."
  
  CONTEXT_PUSH_ENDPOINT="${GATEWAY_URL}/api/v1/internal/pubsub?token=${PUBSUB_SECRET_TOKEN}"
  if gcloud pubsub subscriptions describe context-ready-sub --project="$PROJECT_ID" &>/dev/null; then
    echo "Updating context-ready-sub push endpoint..."
    gcloud pubsub subscriptions update context-ready-sub \
      --project="$PROJECT_ID" \
      --push-endpoint="$CONTEXT_PUSH_ENDPOINT" \
      --ack-deadline=600
  else
    echo "Creating context-ready-sub..."
    gcloud pubsub subscriptions create context-ready-sub \
      --project="$PROJECT_ID" \
      --topic=context-ready-topic \
      --push-endpoint="$CONTEXT_PUSH_ENDPOINT" \
      --ack-deadline=600
  fi

  REVIEW_PUSH_ENDPOINT="${GATEWAY_URL}/api/v1/review/results?token=${PUBSUB_SECRET_TOKEN}"
  if gcloud pubsub subscriptions describe review-result-sub --project="$PROJECT_ID" &>/dev/null; then
    echo "Updating review-result-sub push endpoint..."
    gcloud pubsub subscriptions update review-result-sub \
      --project="$PROJECT_ID" \
      --push-endpoint="$REVIEW_PUSH_ENDPOINT" \
      --ack-deadline=600
  else
    echo "Creating review-result-sub..."
    gcloud pubsub subscriptions create review-result-sub \
      --project="$PROJECT_ID" \
      --topic=review-result-topic \
      --push-endpoint="$REVIEW_PUSH_ENDPOINT" \
      --ack-deadline=600
  fi
else
  echo ""
  echo "NOTE: GATEWAY_URL was not set."
  echo "Once Gateway is deployed, wire the push subscriptions by running:"
  echo "  GATEWAY_URL=<YOUR_GATEWAY_URL> PUBSUB_SECRET_TOKEN=$PUBSUB_SECRET_TOKEN bash scripts/setup-gcp-infra.sh"
fi

echo ""
echo "=========================================================="
echo " Infrastructure Setup Complete!"
echo " Save your PUBSUB_SECRET_TOKEN for your deployment:"
echo " PUBSUB_SECRET_TOKEN=$PUBSUB_SECRET_TOKEN"
echo "=========================================================="
