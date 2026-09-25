Feature: GitHub Webhook Ingestion & Routing

  Scenario: Ingesting PR opened event when baseline context does not exist
    Given repository "usermeme/test-repo" has no baseline context
    When GitHub sends a "pull_request" event for "usermeme/test-repo" PR #10 with action "opened"
    Then the webhook response status is 200
    And a message is published to topic "build-context-topic" with action "opened" and prNumber 10
    And the PR status for "github:usermeme:test-repo:10" is marked as "queued"

  Scenario: Ingesting PR opened event when baseline context already exists
    Given repository "usermeme/test-repo" has a baseline context with architecture "Microservices architecture"
    When GitHub sends a "pull_request" event for "usermeme/test-repo" PR #12 with action "opened"
    Then the webhook response status is 200
    And a message is published to topic "review-code-topic" with repo "test-repo" and prNumber 12
    And the PR status for "github:usermeme:test-repo:12" is marked as "reviewing"

  Scenario: Triggering incremental context update when PR is merged
    When GitHub sends a merged PR event for "usermeme/test-repo" PR #15
    Then the webhook response status is 200
    And a message is published to topic "build-context-topic" with isIncrementalUpdate true

  Scenario: Triggering manual review via issue comment /review
    Given repository "usermeme/test-repo" has a baseline context with architecture "Event-driven system"
    When GitHub sends an issue comment on PR #20 with body "/review please check security"
    Then the webhook response status is 200
    And a message is published to topic "review-code-topic" with repo "test-repo" and prNumber 20

  Scenario: Rejecting webhook requests with invalid HMAC signature
    When GitHub sends a webhook with an invalid HMAC signature
    Then the webhook response status is 401
