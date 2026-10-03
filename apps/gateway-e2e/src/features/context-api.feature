Feature: Context API Endpoints

  Scenario: Successfully fetching baseline repository context
    Given repository "usermeme/test-repo" has a baseline context with architecture "Event-driven system"
    When a client requests GET "/api/v1/context/github:usermeme:test-repo:0"
    Then the response status is 200
    And the returned context contains summary with architecture "Event-driven system"

  Scenario: Fetching non-existent repository context returns 404
    When a client requests GET "/api/v1/context/github:nonexistent:repo:0"
    Then the response status is 404

  Scenario: Health check endpoint returns 200 OK
    When a client requests GET "/healthz"
    Then the response status is 200
