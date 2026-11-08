Feature: GitHub Adapter Provider REST API

  Scenario: Fetching PR diff and changed files
    When a client requests GET "/api/v1/repos/test-org/test-repo/pulls/42/diff"
    Then the response status is 200
    And the response contains diff and changed files
