Feature: GitHub Ingress Health Check

  Scenario: Health check endpoint returns 200 OK
    When a client requests GET "/healthz"
    Then the response status is 200
