Feature: Pub/Sub Push PR Event Ingestion
  As Google Cloud Pub/Sub
  I want to push PR event messages to Core via HTTP POST
  So that Core serverless instances wake up from 0 instances and process PR events

  Scenario: Pub/Sub pushes a PR opened event to Core
    When PubSub pushes a PR event for "facebook/react" PR #42 with action "opened"
    Then the push request responds with HTTP 200
    And the push response reports status "completed"
    And the PR status for "github:facebook:react:42" is marked as "completed"
    And a review result message was published for "facebook/react" PR #42

  Scenario: Pub/Sub pushes a closed PR event and Core ignores it
    When PubSub pushes a PR event for "usermeme/test-repo" PR #15 with action "closed"
    Then the push request responds with HTTP 200
    And the push response reports status "ignored"
