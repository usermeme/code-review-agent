# code-review-agent

Multi-agent GitHub code-review system built on [adk-js](https://github.com/google/adk-js) (`@google/adk`).

A parent **core review agent** orchestrates three reviewer sub-agents, grounded in a
whole-repo context document and a vector memory of past review discussions:

- **ticket_comparison_agent** — verifies the PR implements every requirement of its linked
  Jira/ClickUp ticket (pluggable `TicketProvider` interface).
- **code_problems_agent** — hunts defects: logic bugs, race conditions, performance,
  data leaks, security, error handling.
- **code_quality_agent** — enforces the repo's own patterns and conventions; flags
  antipatterns, smells, and new patterns introduced where an internal one already exists.

## How it works

1. A GitHub App delivers webhooks to `/webhook`. Reviews run automatically when a PR opens
   or leaves draft, and on demand via a `/review` comment.
2. `getRepoContext` returns a whole-repo context document (architecture, modules, internal
   patterns, error-handling/testing conventions, AGENTS.md/CLAUDE.md verbatim). It is built
   by a map-reduce pass with a thinking model over a shallow clone of the **base branch**,
   cached in **Redis**, shared across PRs, and rebuilt once the cached doc is older than
   `cache.repoContextMaxAgeSeconds` (default 24h; hard TTL `cache.repoContextTtlSeconds`,
   default 7 days). Sections are written into session state, and each sub-agent reads
   exactly the slices it needs.
3. The PR head is shallow-cloned for the duration of the review. Reviewer agents see the
   **full changed files** (1-based line numbers; windowed around the hunks for huge files,
   budgets under `context.*`) alongside a diff **annotated with NEW-side line numbers** —
   so anchors are copied, not derived. The orchestrator additionally gets `readFile` /
   `searchRepo` tools over the checkout to check callers or guards outside the diff before
   keeping a finding. Clone failure (e.g. inaccessible fork) degrades to a diff-only review.
4. Every human PR comment webhook is embedded (`gemini-embedding-001`) into **Postgres +
   pgvector**. The orchestrator's `getDiscussion` tool searches this memory to drop findings
   the team has previously rejected; `storeDiscussion` and published findings write back.
   `npm run backfill -- --repo owner/name` ingests all historical PR discussions.
5. Findings that survive the orchestrator go through an **adversarial verification pass**
   (`verification.*`, `models.agents.verifier`): a skeptic model re-checks each finding
   against the real file content — not the diff — and refuted findings are dropped (LLM
   failures fail open; refuting needs positive evidence). Confirmed findings can get
   corrected line anchors.
6. The orchestrator merges/deduplicates findings and posts **one GitHub review**: inline
   comments anchored to diff lines plus a summary (always `COMMENT`, never blocks merges).
   Multi-line ranges that span hunks demote to single-line anchors, and if GitHub still
   rejects the inline comments (422), the review republishes with all findings in the
   summary rather than being lost.

Every agent's model is selectable in `config/default.yaml` (`models.agents.*` → named tiers).
Gemini works natively; Claude models run through a custom `ClaudeLlm` adapter
(`src/models/claude-llm.ts`) with adaptive thinking and structured outputs.

## Local development

### Option A: Running natively on host (fastest for development)

1. Copy `.env.example` to `.env` and fill in your API keys and GitHub App credentials.
2. Start the Postgres and Redis databases:
   ```sh
   docker compose up -d redis postgres
   ```
3. Install dependencies, run migrations, and start the app:
   ```sh
   npm install
   npm run migrate
   npm run dev
   ```

### Option B: Running everything in Docker

1. Copy `.env.example` to `.env` and fill in your API keys and GitHub App credentials.
2. Run the entire stack (Postgres, Redis, and the code-review-agent):
   ```sh
   docker compose up --build
   ```

### Testing reviews

Webhook tunneling for a dev GitHub App: create a channel on https://smee.io, set it as the
App's webhook URL, then:

```sh
npx smee-client --url https://smee.io/<channel> --target http://localhost:8080/webhook
```

Fastest iteration loop — review a PR directly, no webhook involved:

```sh
npm run review -- --repo owner/name --pr 3
```

GitHub App permissions needed: Pull requests (read/write), Contents (read), Metadata (read);
webhook events: `pull_request`, `issue_comment`, `pull_request_review`,
`pull_request_review_comment`.

## Tests

```sh
npm run typecheck
npm test
```

## Deploy: Split-Repository Setup

For a cost-effective, secure setup, you can split this system into two repositories:

1. **Repo A (This Repository - Code & Builder)**: Publishes the Docker image to GitHub Container Registry (GHCR).
2. **Repo B (Your Private Deployment Repository)**: Holds only `docker-compose.yml` and `.env` to deploy the agent privately on any VPS or local machine.

### 1. Repo A Setup (Build & Publish to GHCR)
An automated GitHub Action workflow is configured in [.github/workflows/publish.yml](.github/workflows/publish.yml). When code is pushed to `main`, it builds the production container and pushes it to `ghcr.io/<your-owner>/code-review-agent:latest`.

*Note: The container runs securely as the non-root `node` user.*

#### Permissions & GHCR Package Setup:
1. Ensure your repository settings allow GitHub Actions to write packages (under **Settings** ➔ **Actions** ➔ **General** ➔ **Workflow permissions** select **Read and write permissions**).
2. Once the first image is pushed, go to your GitHub profile/organization ➔ **Packages** ➔ Click on the `code-review-agent` package ➔ **Package settings**.
3. Under **Manage Actions Access**, add this repository and assign it **Write** permissions. Change package visibility to **Public** (or keep it **Private** and configure a Personal Access Token with `read:packages` to pull from your deployment server).

### 2. Repo B Setup (Private Deployment)
Create a new, private repository or directory on your server. Add a `docker-compose.yml` that pulls the pre-built image:

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
    volumes:
      - redisdata:/data

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: reviews
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data

  agent:
    image: ghcr.io/<your-github-username-or-org>/code-review-agent:latest
    ports:
      - '8080:8080'
    env_file:
      - .env
    depends_on:
      - redis
      - postgres

volumes:
  pgdata:
  redisdata:
```

Create a `.env` file next to it with your real credentials:
```env
GITHUB_APP_ID=your_app_id
GITHUB_PRIVATE_KEY="your_base64_encoded_private_key"
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GOOGLE_API_KEY=your_gemini_api_key
# ANTHROPIC_API_KEY=your_anthropic_key_if_used
# Required only to use POST /admin/backfill; the endpoint stays disabled (503) until set.
# ADMIN_TOKEN=a_long_random_secret
```

Run `docker compose up -d` to launch the entire stack!

---

*Note: The manual Google Cloud Platform setup guide is still available in **[docs/deploy.md](docs/deploy.md)** if you prefer to deploy to GCP Cloud Run/Cloud SQL.*

## Configuration

`config/default.yaml`, env-interpolated (`${VAR}`) and overridable per key with
`CRA__section__key=value` env vars. Highlights:

| Key                                                                | Meaning                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models.tiers` / `models.agents`                                   | named model tiers and per-agent assignment                                                                                                                                                                                                                    |
| `verification.enabled` / `verification.concurrency`                | adversarial re-check of findings against real file content before publishing                                                                                                                                                                                  |
| `context.maxChangedFileTokens` / `context.changedFilesTokenBudget` | budgets for full changed-file content shown to reviewers                                                                                                                                                                                                      |
| `cache.repoContextTtlSeconds`                                      | repo-context cache hard TTL (default 1 week)                                                                                                                                                                                                                  |
| `cache.repoContextMaxAgeSeconds`                                   | age after which the repo context is rebuilt (default 24h)                                                                                                                                                                                                     |
| `github.reposAllowlist`                                            | glob allowlist, empty = all installed repos                                                                                                                                                                                                                   |
| `triggers.reviewCommand`                                           | comment command to re-run a review                                                                                                                                                                                                                            |
| `tickets.jira` / `tickets.clickup`                                 | ticket provider credentials                                                                                                                                                                                                                                   |
| `skills.codeReviewDir`                                             | path to the `code-review` skill folder from [usermeme/skills](https://github.com/usermeme/skills) — its SKILL.md and security checklist are injected into the reviewer agents' prompts, so editing the skill retunes the bot; empty uses an embedded snapshot |
