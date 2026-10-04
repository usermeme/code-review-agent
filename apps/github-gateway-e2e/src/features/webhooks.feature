Feature: GitHub Webhook Ingestion & Core Forwarding

  Scenario: Ingesting PR opened event and forwarding to Core
    When GitHub sends a "pull_request" event for "usermeme/test-repo" PR #10 with action "opened"
    Then the webhook response status is 200
    And Core receives an IngestPREvent RPC with action "opened", repo "test-repo", and prNumber 10
    And the forwarded event contains the fetched PR diff and changed files

  Scenario: Ingesting merged PR event and forwarding to Core
    When GitHub sends a merged PR event for "usermeme/test-repo" PR #15
    Then the webhook response status is 200
    And Core receives an IngestPREvent RPC with isIncrementalUpdate true and prNumber 15

  Scenario: Ingesting issue comment /review and forwarding to Core
    When GitHub sends an issue comment on PR #20 with body "/review please check security"
    Then the webhook response status is 200
    And Core receives an IngestPREvent RPC with action "manual_trigger" and prNumber 20

  Scenario: Rejecting webhook requests with invalid HMAC signature
    When GitHub sends a webhook with an invalid HMAC signature
    Then the webhook response status is 401
    And Core receives no IngestPREvent RPC
