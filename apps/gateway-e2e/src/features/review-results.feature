Feature: Review Results Ingestion & Publishing

  Scenario: Ingesting review plan and posting inline comments
    Given PR "github:usermeme:test-repo:40" is reviewing
    When a PubSub push message arrives at "/api/v1/review/results" with token "secure-pubsub-token" containing findings:
      | path        | position | body                                |
      | src/auth.ts | 12       | Missing token validation on request |
    Then the response status is 200
    And inline comment is posted to "usermeme/test-repo" PR #40 at "src/auth.ts" line 12
    And the PR status for "github:usermeme:test-repo:40" is marked as "completed"

  Scenario: Rejecting review results push message without token
    When a PubSub push message arrives at "/api/v1/review/results" without token
    Then the response status is 401
