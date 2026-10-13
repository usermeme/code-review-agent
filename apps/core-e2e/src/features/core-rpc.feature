Feature: Core IngestPREvent Service

  Scenario: PR opened without a baseline queues a build and is reviewed once it is ready
    Given repository "usermeme/test-repo" has no baseline context
    When Gateway calls IngestPREvent for "usermeme/test-repo" PR #10 with action "opened"
    Then the IngestPREvent RPC response status is "queued"
    And the PR status for "github:usermeme:test-repo:10" is marked as "building_context"
    And a baseline context build is queued for "usermeme/test-repo"
    When Pub/Sub delivers the queued context build
    Then the push request responds with HTTP 200
    And repository "usermeme/test-repo" has a baseline context in the database
    And a review result message is published to topic "test-review-results-topic" with repo "test-repo" and prNumber 10
    And the PR status for "github:usermeme:test-repo:10" is marked as "completed"

  Scenario: Ingesting PR opened event when baseline context already exists
    Given repository "usermeme/test-repo" has a baseline context with architecture "Microservices architecture"
    When Gateway calls IngestPREvent for "usermeme/test-repo" PR #12 with action "opened"
    Then the IngestPREvent RPC response is accepted
    And a review result message is published to topic "test-review-results-topic" with repo "test-repo" and prNumber 12
    And the PR status for "github:usermeme:test-repo:12" is marked as "completed"

  Scenario: Merged PR is folded into the existing baseline context
    Given repository "usermeme/test-repo" has a baseline context with architecture "Event-driven system"
    When Gateway calls IngestPREvent for merged PR "usermeme/test-repo" PR #15
    Then the IngestPREvent RPC response status is "queued"
    And a incremental context build is queued for "usermeme/test-repo"
    When Pub/Sub delivers the queued context build
    Then the push request responds with HTTP 200
    And the baseline context of "usermeme/test-repo" has merged PR #15 applied

  Scenario: Merged PR without a baseline context does not create one
    Given repository "usermeme/test-repo" has no baseline context
    When Gateway calls IngestPREvent for merged PR "usermeme/test-repo" PR #16
    Then the IngestPREvent RPC response status is "ignored"
    And no context build is queued
    And repository "usermeme/test-repo" still has no baseline context

  Scenario: Triggering manual review via issue comment
    Given repository "usermeme/test-repo" has a baseline context with architecture "Event-driven system"
    When Gateway calls IngestPREvent for manual review on "usermeme/test-repo" PR #20
    Then the IngestPREvent RPC response is accepted
    And a review result message is published to topic "test-review-results-topic" with repo "test-repo" and prNumber 20
    And the PR status for "github:usermeme:test-repo:20" is marked as "completed"
