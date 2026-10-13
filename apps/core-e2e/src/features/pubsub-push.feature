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

  Scenario: Context build for a repo whose lease is held is retried later
    Given another instance holds the context build lease for "facebook/react"
    When Pub/Sub pushes a baseline context build for "facebook/react"
    Then the push request responds with HTTP 503
    And repository "facebook/react" still has no baseline context
