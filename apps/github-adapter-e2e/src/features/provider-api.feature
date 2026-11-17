Feature: GitHub Adapter Provider REST API

  Scenario: Fetching PR diff and changed files
    When a client requests GET "/api/v1/repos/test-org/test-repo/pulls/42/diff"
    Then the response status is 200
    And the response contains diff and changed files

  Scenario: Listing review-context source files of the base branch
    When a client requests GET "/api/v1/repos/test-org/test-repo/tree-files?ref=main&names=agents.md,skill.md"
    Then the response status is 200
    And the response lists the files "AGENTS.md, .agents/skills/testing/SKILL.md"

  Scenario: Fetching a blob's content
    When a client requests GET "/api/v1/repos/test-org/test-repo/blobs/blob:AGENTS.md"
    Then the response status is 200
    And the response content is "# Rules\nNever log tokens."
