Feature: Review Results Ingestion & Gateway RPC Publishing

  Scenario: Ingesting review plan and posting inline comments via Gateway RPC
    Given PR "github:usermeme:test-repo:40" is reviewing
    When a PubSub push message arrives at "/api/v1/review/results" with token "secure-pubsub-token" containing findings:
      | path        | position | body                                |
      | src/auth.ts | 12       | Missing token validation on request |
    Then the response status is 200
    And Gateway receives PostReview RPC for "usermeme/test-repo" PR #40 with 1 comments
    And the PR status for "github:usermeme:test-repo:40" is marked as "completed"

  Scenario: Ingesting review plan with top-level summary and inline comments
    Given PR "github:usermeme:test-repo:41" is reviewing
    When a PubSub push message arrives at "/api/v1/review/results" with token "secure-pubsub-token" containing summary "Found critical security issue" and findings:
      | path        | position | body                        |
      | src/db.ts   | 25       | SQL injection vulnerability |
    Then the response status is 200
    And Gateway receives PostReview RPC for "usermeme/test-repo" PR #41 with summary "Found critical security issue"
    And the PR status for "github:usermeme:test-repo:41" is marked as "completed"

  Scenario: Ingesting clean review plan with summary and zero findings
    Given PR "github:usermeme:test-repo:42" is reviewing
    When a PubSub push message arrives at "/api/v1/review/results" with token "secure-pubsub-token" containing summary "All checks passed cleanly" and zero findings
    Then the response status is 200
    And Gateway receives PostReview RPC for "usermeme/test-repo" PR #42 with summary "All checks passed cleanly"
    And the PR status for "github:usermeme:test-repo:42" is marked as "completed"

  Scenario: Rejecting review results push message without token
    When a PubSub push message arrives at "/api/v1/review/results" without token
    Then the response status is 401
