Feature: Internal PubSub Push Endpoints

  Scenario: Context Builder notifies baseline context ready for pending PR
    Given PR "github:usermeme:test-repo:30" is queued
    When a PubSub push message arrives at "/api/v1/internal/pubsub" with token "secure-pubsub-token" containing:
      | provider | owner    | repo      | prNumber | architecture         |
      | github   | usermeme | test-repo | 30       | Fastify & ADK Agents |
    Then the response status is 200
    And repository "usermeme/test-repo" has a baseline context in the database
    And a message is published to topic "review-code-topic" with repo "test-repo" and prNumber 30

  Scenario: Rejecting unauthenticated PubSub push messages
    When a PubSub push message arrives at "/api/v1/internal/pubsub" without token
    Then the response status is 401
