# Contributing to AI Code Review Agent

Thank you for your interest in contributing to the **AI Code Review Agent** project! We welcome contributions of all kinds: bug fixes, new features, performance improvements, documentation, and git provider integrations.

This document provides guidelines and instructions for setting up your local environment, developing, testing, and submitting your changes.

---

## 🏗️ Architecture Overview

The repository is organized as an **Nx Monorepo**:

```
apps/
  gateway/                # Fastify gateway receiving git webhooks and orchestrating pipelines
  gateway-e2e/            # Cucumber / BDD end-to-end test suite for the gateway
  agent-context-builder/  # Google ADK agent preparing codebase baseline and incremental context
  agent-code-reviewer/    # Google ADK agent executing multi-agent code analysis and posting reviews
libs/
  shared-types/           # Shared TypeScript interfaces (payload contracts, PR state, etc.)
```

---

## 🛠️ Prerequisites

Before you begin, ensure you have the following installed on your machine:

- **Node.js**: `v24.x` or higher (we recommend using `.nvmrc` with `nvm use` or `fnm`)
- **Package Manager**: `pnpm` `v10.29.x` (managed via Node.js Corepack: `corepack enable`)
- **Docker & Docker Compose**: (Optional, for running local emulator stack and testing containers)

---

## 🚀 Getting Started

1. **Fork and Clone the Repository**:
   ```bash
   git clone https://github.com/<your-username>/code-review-agent.git
   cd code-review-agent
   ```

2. **Enable Corepack and Install Dependencies**:
   ```bash
   corepack enable
   pnpm install --frozen-lockfile
   ```

3. **Verify Everything Works**:
   ```bash
   pnpm run typecheck
   pnpm run lint
   pnpm run test
   pnpm run e2e
   pnpm run build
   ```

---

## 💻 Development Workflow

### Available Scripts

We prefer using Nx commands via `pnpm`:

| Command | Description |
|---|---|
| `pnpm run typecheck` | Run TypeScript compiler typecheck across all 5 projects |
| `pnpm run lint` | Run ESLint across all projects |
| `pnpm run test` | Run Vitest unit tests for both agents |
| `pnpm run e2e` | Run Cucumber BDD end-to-end tests for Gateway |
| `pnpm run build` | Build production bundles for all 3 apps via `@nx/esbuild` |

### Running a Specific App or Library

```bash
# Typecheck a single project
pnpm nx typecheck gateway

# Run unit tests for a single project
pnpm nx test agent-code-reviewer

# Build a single project
pnpm nx build agent-context-builder --prod
```

---

## 🧪 Testing Guidelines

We enforce high test coverage and regression testing across the monorepo:

### 1. BDD E2E Testing (`gateway-e2e`)
All gateway routing, webhook signature verification, Firestore tracking, Pub/Sub ingestion, and Git adapter behavior are tested with **Cucumber** and Gherkin features located in `apps/gateway-e2e/src/features/`.

- When adding or changing gateway endpoints, write a `.feature` scenario first.
- Step definitions are located in `apps/gateway-e2e/src/step-definitions/`.
- Test doubles (in-memory database, mock Octokit, mock Pub/Sub) reside in `apps/gateway-e2e/src/support/doubles/`.

### 2. Unit Testing (`vitest`)
Agent tools and services are tested using **Vitest**:
- Unit test files are colocated with source code using the `.spec.ts` naming convention.
- Ensure all mocked calls clean up properly (`vi.restoreAllMocks()`).

---

## 🐳 Docker & Local Stack

To test all services running in containers with the Google Cloud Firestore and Pub/Sub emulators:

```bash
# Copy example environment
cp .env.example .env

# Start all services with emulators
docker compose up --build
```

The stack exposes:
- **Gateway**: `http://localhost:3000` (`/healthz` health check)
- **Agent Context Builder**: `http://localhost:8001`
- **Agent Code Reviewer**: `http://localhost:8002`
- **Firestore Emulator**: `http://localhost:8081`
- **Pub/Sub Emulator**: `http://localhost:8085`

---

## 📝 Coding & Commit Standards

- **TypeScript**: Strict mode is enabled. Avoid `any` where possible.
- **Error Handling**: When catching and rethrowing errors, preserve the cause (`new Error('...', { cause: err })`).
- **Conventional Commits**: We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
  - `feat: ...` for new capabilities or user-facing features
  - `fix: ...` for bug fixes
  - `docs: ...` for documentation updates
  - `chore: ...` for build, dependencies, or configuration changes
  - `refactor: ...` for code restructuring without behavior changes
  - `test: ...` for adding or updating tests

---

## 📬 Submitting a Pull Request

1. **Create a branch**:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. **Make your changes** and add relevant tests.
3. **Run all verification checks**:
   ```bash
   pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run e2e && pnpm run build
   ```
4. **Commit your changes**:
   Our pre-commit hook (Lefthook) will automatically verify your staged files before committing.
5. **Push and Open a PR**:
   Push to your fork and submit a PR against `main`. Provide a clear description of the problem solved and the implementation details.

---

## 📄 License

By contributing to this repository, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
