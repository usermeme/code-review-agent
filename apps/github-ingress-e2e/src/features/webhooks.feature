Feature: GitHub Webhook Ingestion & PubSub Publishing

  Scenario: Ingesting PR opened event and publishing to PubSub
    When GitHub sends a "pull_request" event for "usermeme/test-repo" PR #10 with action "opened"
    Then the webhook response status is 200
    And PubSub receives a PR event with action "opened", repo "test-repo", and prNumber 10

  Scenario: Ingesting merged PR event and publishing to PubSub
    When GitHub sends a merged PR event for "usermeme/test-repo" PR #15
    Then the webhook response status is 200
    And PubSub receives a PR event with isIncrementalUpdate true and prNumber 15

  Scenario: Ingesting issue comment /review and publishing to PubSub
    When GitHub sends an issue comment on PR #20 with body "/review please check security"
    Then the webhook response status is 200
    And PubSub receives a PR event with action "manual_trigger" and prNumber 20

  Scenario: Rejecting webhook requests with invalid HMAC signature
    When GitHub sends a webhook with an invalid HMAC signature
    Then the webhook response status is 401
    And PubSub receives no PR events
