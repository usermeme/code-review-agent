Feature: Core IngestPREvent RPC Service

  Scenario: Ingesting PR opened event when baseline context does not exist
    Given repository "usermeme/test-repo" has no baseline context
    When Gateway calls IngestPREvent for "usermeme/test-repo" PR #10 with action "opened"
    Then the IngestPREvent RPC response is accepted
    And a message is published to topic "build-context-topic" with action "opened" and prNumber 10
    And the PR status for "github:usermeme:test-repo:10" is marked as "queued"

  Scenario: Ingesting PR opened event when baseline context already exists
    Given repository "usermeme/test-repo" has a baseline context with architecture "Microservices architecture"
    When Gateway calls IngestPREvent for "usermeme/test-repo" PR #12 with action "opened"
    Then the IngestPREvent RPC response is accepted
    And a message is published to topic "review-code-topic" with repo "test-repo" and prNumber 12
    And the PR status for "github:usermeme:test-repo:12" is marked as "reviewing"

  Scenario: Triggering incremental context update when PR is merged
    When Gateway calls IngestPREvent for merged PR "usermeme/test-repo" PR #15
    Then the IngestPREvent RPC response is accepted
    And a message is published to topic "build-context-topic" with isIncrementalUpdate true

  Scenario: Triggering manual review via issue comment
    Given repository "usermeme/test-repo" has a baseline context with architecture "Event-driven system"
    When Gateway calls IngestPREvent for manual review on "usermeme/test-repo" PR #20
    Then the IngestPREvent RPC response is accepted
    And a message is published to topic "review-code-topic" with repo "test-repo" and prNumber 20
