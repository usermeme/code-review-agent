# Code Review Agent Architecture

This monorepo contains a custom, automated Code Review system that uses `@google/adk` to power two main autonomous agents (Context Builder & Code Reviewer) alongside a central Fastify Gateway.

## High-Level Architecture

The system coordinates between GitHub Webhooks, the Gateway, and Pub/Sub queues to safely build code context and generate expert code reviews.

```mermaid
sequenceDiagram
    participant GitHub
    participant Gateway
    participant PubSub
    participant ContextBuilder
    participant DB as Firestore
    participant CodeReviewer

    %% Webhook Ingress
    GitHub->>Gateway: Webhook (Pull Request opened)
    Gateway->>Gateway: Verify Signature
    Gateway->>DB: Save PR status (queued)
    Gateway->>PubSub: publish (build-context-topic)

    %% Context Builder Flow
    PubSub->>ContextBuilder: trigger via adk/PubSub ingress
    ContextBuilder->>GitHub: Git Clone / Fetch Diff
    ContextBuilder->>ContextBuilder: Chunk files & Summarize
    ContextBuilder->>ContextBuilder: Synthesize Context Document
    ContextBuilder->>Gateway: POST /api/v1/internal/pubsub (context ready)
    
    %% Gateway routes Context to Reviewer
    Gateway->>DB: saveContext & updatePRStatus(reviewing)
    Gateway->>PubSub: publish (review-code-topic)

    %% Code Reviewer Flow
    PubSub->>CodeReviewer: trigger via adk/PubSub ingress
    CodeReviewer->>Gateway: GET /api/v1/context/:prKey
    Gateway-->>CodeReviewer: Returns Synthesized Context
    CodeReviewer->>CodeReviewer: Generate Review Comments
    CodeReviewer->>Gateway: POST /api/v1/review/results
    Gateway->>DB: updatePRStatus(completed)
    Gateway->>GitHub: POST Inline Comments (Octokit)
```

## Context Builder Agent Details

The Context Builder Agent is responsible for maintaining a baseline understanding of the repository and extracting changes incrementally.

```mermaid
flowchart TD
    Start([PubSub payload received]) --> IsIncremental{isIncrementalUpdate?}
    
    IsIncremental -- Yes --> FetchContext[fetch_context tool: Pull existing baseline from Gateway]
    IsIncremental -- No --> PrepareFull[prepare_repository tool: Shallow clone full repo]
    
    FetchContext --> FetchDiff[prepare_repository tool: Fetch changed files via Octokit diff]
    
    PrepareFull --> Chunk[Chunk files into tokens]
    FetchDiff --> Chunk
    
    Chunk --> Summarize[summarize_chunks tool: Run LLM over each chunk concurrently]
    
    Summarize --> IsIncremental2{isIncrementalUpdate?}
    
    IsIncremental2 -- Yes --> PatchContext[synthesize_context tool: Patch existing context with new diff summaries]
    IsIncremental2 -- No --> SynthesizeNew[synthesize_context tool: Generate brand new baseline context]
    
    PatchContext --> Store[store_context tool: Send to Gateway]
    SynthesizeNew --> Store
    
    Store --> End([Done])
```

## Running the Project

```sh
# Start the Gateway
npm run start gateway
```
