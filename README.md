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

## How to Use & Deploy

Deploy the code-review-agent stack using Docker Compose and connect it to your GitHub App.

### 1. GitHub App Setup & Webhook Configuration

To enable automated reviews, you must register a GitHub App:

1. Go to your GitHub Profile/Organization **Settings** ➔ **Developer settings** ➔ **GitHub Apps** ➔ **New GitHub App**.
2. Configure **Webhook**:
   - Set **Webhook URL** to your deployment's endpoint (e.g., `https://your-domain.com/webhook`).
   - Set a secure **Webhook Secret**.
3. Configure the following **Permissions**:
   - **Pull requests**: Read & write (needed to inspect PR files and publish review comments)
   - **Repository contents**: Read (needed to clone codebases and inspect repository structure)
   - **Metadata**: Read (default and required)
4. Enable the following **Webhook events**:
   - `Pull request`
   - `Issue comment`
   - `Pull request review`
   - `Pull request review comment`
5. Generate a **Private Key** under the App settings, download the `.pem` file, and keep it secure.
6. Install the App on the repositories you want the agent to review.

### 2. Deployment via Docker Compose

Run the entire service stack (Postgres + pgvector, Redis, and the Code Review Agent) on your deployment host.

Create a `docker-compose.yml` file:

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
    image: ghcr.io/usermeme/code-review-agent:latest
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

Create a `.env` file in the same directory:

```env
GITHUB_APP_ID=your_app_id
GITHUB_PRIVATE_KEY="your_base64_encoded_private_key"
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GOOGLE_API_KEY=your_gemini_api_key
# ANTHROPIC_API_KEY=your_anthropic_key_if_used
# Required only to use POST /admin/backfill; the endpoint stays disabled (503) until set.
# ADMIN_TOKEN=a_long_random_secret
```

Launch the stack:

```sh
docker compose up -d
```

*Note: The manual Google Cloud Platform setup guide is still available in **[docs/deploy.md](docs/deploy.md)** if you prefer to deploy to GCP Cloud Run/Cloud SQL.*

## Local Development

Follow these options to run the application locally for active development.

### Option A: Running Natively on Host (Fastest for development)

1. Copy `.env.example` to `.env` and fill in your API keys and GitHub App credentials.
2. Start the Postgres and Redis databases:
   ```sh
   docker compose up -d redis postgres
   ```
3. Install dependencies, run database migrations, and start the app:
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

### Webhook Tunneling (Smee Client)

To test the GitHub App webhooks locally without exposing public endpoints, you can use Smee:
1. Create a webhook channel on https://smee.io.
2. Set it as the App's Webhook URL in your GitHub App settings page.
3. Start the Smee client locally:
   ```sh
   npx smee-client --url https://smee.io/<channel> --target http://localhost:8080/webhook
   ```

### Direct CLI Review Testing

To review a PR directly from the command line without sending webhooks or running the server:
```sh
npm run review -- --repo owner/name --pr 3
```

### Running Tests

Ensure your TypeScript types are correct and all tests pass:
```sh
npm run typecheck
npm test
```

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
