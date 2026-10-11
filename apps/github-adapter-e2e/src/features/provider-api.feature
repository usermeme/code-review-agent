Feature: GitHub Adapter Provider REST API

  Scenario: Fetching PR diff and changed files
    When a client requests GET "/api/v1/repos/test-org/test-repo/pulls/42/diff"
    Then the response status is 200
    And the response contains diff and changed files

  Scenario: Searching code in repository
    When a client requests GET "/api/v1/repos/test-org/test-repo/search?q=answer"
    Then the response status is 200
    And the response contains search results with totalCount 1

  Scenario: Getting file content from repository
    When a client requests GET "/api/v1/repos/test-org/test-repo/files/src/index.ts"
    Then the response status is 200
    And the response file content is "export const answer = 42;"
