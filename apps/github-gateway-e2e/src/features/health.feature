Feature: GitHub Gateway Health Check

  Scenario: Health check endpoint returns 200 OK
    When a client requests GET "/healthz"
    Then the response status is 200
    And the response service name is "github-gateway"
