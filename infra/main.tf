terraform {
  required_version = ">= 1.0.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# 1. Enable Required APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "firestore.googleapis.com"
  ])
  service            = each.key
  disable_on_destroy = false
}

# 2. Firestore Database (Native mode)
resource "google_firestore_database" "database" {
  name        = "(default)"
  # Firestore requires a specific location ID, us-central1 translates to nam5 for multi-region or us-central1 for regional.
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  
  # Ensure APIs are enabled first
  depends_on = [google_project_service.apis]
}

# 3. Pub/Sub Topics
resource "google_pubsub_topic" "topics" {
  for_each = toset([
    "build-context-topic",
    "context-ready-topic",
    "review-code-topic",
    "review-result-topic"
  ])
  name       = each.key
  depends_on = [google_project_service.apis]
}

# 4. Secrets Containers (Empty boxes for enterprise security)
resource "google_secret_manager_secret" "git_adapter_webhook_secret" {
  secret_id = "git-adapter-webhook-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "git_adapter_token_secret" {
  secret_id = "git-adapter-token-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "google_api_key" {
  secret_id = "google-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# Group secrets for IAM
locals {
  secrets = [
    google_secret_manager_secret.git_adapter_webhook_secret.secret_id,
    google_secret_manager_secret.git_adapter_token_secret.secret_id,
    google_secret_manager_secret.google_api_key.secret_id
  ]
}

data "google_project" "project" {}

# Grant default compute service account access to the secrets (so Cloud Run can read them)
resource "google_secret_manager_secret_iam_member" "secret_access" {
  for_each  = toset(local.secrets)
  secret_id = each.key
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"
}
