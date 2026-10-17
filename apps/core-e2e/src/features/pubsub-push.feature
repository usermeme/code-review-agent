Feature: Pub/Sub Push PR Event Ingestion
  As Google Cloud Pub/Sub
  I want to push PR event messages to Core via HTTP POST
  So that Core serverless instances wake up from 0 instances and process PR events

  Scenario: Pub/Sub pushes a PR opened event to Core
    Given repository "facebook/react" has a baseline context with architecture "React Architecture"
    When PubSub pushes a PR event for "facebook/react" PR #42 with action "opened"
    Then the push request responds with HTTP 200
    And the PR status for "github:facebook:react:42" is marked as "completed"
    And a review result message is published to topic "test-review-results-topic" with repo "react" and prNumber 42

  Scenario: Pub/Sub redelivers the same PR event and the review runs once
    Given repository "facebook/react" has a baseline context with architecture "React Architecture"
    When PubSub delivers message "msg-dup" for "facebook/react" PR #43 with action "synchronize" 2 times
    Then the push request responds with HTTP 200
    And the review ran 1 time

  Scenario: Pub/Sub pushes a PR opened event when no baseline context exists
    Given repository "usermeme/test-repo" has no baseline context
    When PubSub pushes a PR event for "usermeme/test-repo" PR #10 with action "opened"
    Then the push response reports status "reviewing"
    And repository "usermeme/test-repo" has a baseline context in the database
    And a review result message is published to topic "test-review-results-topic" with repo "test-repo" and prNumber 10
    And the PR status for "github:usermeme:test-repo:10" is marked as "completed"

  Scenario: Pub/Sub pushes a merged PR event and the baseline context is rebuilt
    When PubSub pushes a merged event for "usermeme/test-repo" PR #15
    Then the push response reports status "queued"
    And repository "usermeme/test-repo" has a baseline context in the database
    And the review ran 0 times

  Scenario: Pub/Sub pushes a manual /review trigger
    Given repository "usermeme/test-repo" has a baseline context with architecture "Event-driven system"
    When PubSub pushes a PR event for "usermeme/test-repo" PR #20 with action "manual_trigger"
    Then the push response reports status "reviewing"
    And a review result message is published to topic "test-review-results-topic" with repo "test-repo" and prNumber 20
    And the PR status for "github:usermeme:test-repo:20" is marked as "completed"
