Feature: Gateway Pub/Sub Push Review Results
  As Google Cloud Pub/Sub
  I want to push review results to GitHub Gateway via HTTP POST
  So that Gateway serverless instances wake up from 0 instances and post reviews to GitHub

  Scenario: Pub/Sub pushes review results to Gateway
    When PubSub pushes review results for "usermeme/test-repo" PR #50 with summary "Push review completed" and comments:
      | path        | position | body                      |
      | src/util.ts | 5        | Improve naming convention |
    Then the push request responds with HTTP 200
    And review summary is posted to GitHub PR #50 containing "Push review completed"
    And inline comment is posted to GitHub PR #50 at "src/util.ts" line 5
