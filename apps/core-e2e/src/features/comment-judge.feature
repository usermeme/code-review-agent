Feature: Comment judge
  As a PR author whose review comments are fixed automatically
  I want every resolved comment checked against the code
  So that a wrong resolution is re-opened instead of silently closed

  Background:
    Given "acme/payments" PR #9 has a review thread "PRRT_1" on "src/index.ts" commented at commit "comment-sha"

  Scenario: A wrong resolution is re-opened with the reason
    Given the comment judge finds threads "not_fixed" because "b is still 2 at src/index.ts:2."
    When GitHub reports thread "PRRT_1" resolved on "acme/payments" PR #9 at head "head-sha"
    Then the push response reports status "completed"
    And the adapter is asked to re-open thread "PRRT_1" saying "b is still 2 at src/index.ts:2."
    And the judgment of thread "PRRT_1" on "github:acme:payments:9" is "not_fixed"

  Scenario: A resolution before the fix is pushed waits for the push
    Given the comment judge finds threads "fixed" because "b is 3 now."
    When GitHub reports thread "PRRT_1" resolved on "acme/payments" PR #9 at head "comment-sha"
    Then no thread judgments are published
    And the judgment of thread "PRRT_1" on "github:acme:payments:9" is "pending"
    When "acme/payments" PR #9 is pushed to head "head-sha"
    Then the adapter is asked to confirm thread "PRRT_1"
    And the judgment of thread "PRRT_1" on "github:acme:payments:9" is "fixed"
