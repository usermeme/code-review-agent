Feature: Gateway PostReview ConnectRPC Endpoint

  Scenario: Posting review with inline comments to GitHub via Octokit
    When Core calls PostReview RPC for "usermeme/test-repo" PR #40 with summary "Found critical security issue" and comments:
      | path        | position | body                                |
      | src/auth.ts | 12       | Missing token validation on request |
    Then the PostReview RPC succeeds
    And review summary is posted to GitHub PR #40 containing "Found critical security issue"
    And inline comment is posted to GitHub PR #40 at "src/auth.ts" line 12

  Scenario: Posting clean review with zero inline comments to GitHub via Octokit
    When Core calls PostReview RPC for "usermeme/test-repo" PR #42 with summary "All checks passed cleanly" and zero findings
    Then the PostReview RPC succeeds
    And review summary is posted to GitHub PR #42 containing "All checks passed cleanly"
