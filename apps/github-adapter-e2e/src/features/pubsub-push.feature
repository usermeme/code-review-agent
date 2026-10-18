Feature: Adapter Pub/Sub Push Review Results
  As Google Cloud Pub/Sub
  I want to push review results to GitHub Adapter via HTTP POST
  So that Adapter serverless instances wake up from 0 instances and post reviews to GitHub

  Scenario: PubSub pushes review results to Adapter
    When PubSub pushes review results for "usermeme/test-repo" PR #50 with summary "Push review completed" and comments:
      | path        | position | body                      |
      | src/util.ts | 5        | Improve naming convention |
    Then the push request responds with HTTP 200
    And the GitHub App installation is resolved for "usermeme/test-repo"
    And review summary is posted to GitHub PR #50 containing "Push review completed"
    And inline comment is posted to GitHub PR #50 at "src/util.ts" line 5

  Scenario: PubSub push is acknowledged without retry when GitHub App is not installed
    Given the GitHub App is not installed on "uninstalled-org/private-repo"
    When PubSub pushes review results for "uninstalled-org/private-repo" PR #12 with summary "Review summary" and comments:
      | path        | position | body   |
      | src/main.ts | 3        | Fix me |
    Then the push request responds with HTTP 200
    And the push response indicates non-retryable error "GitHub App is not installed on uninstalled-org/private-repo"
