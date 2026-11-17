Feature: Review rules from base-branch guidelines
  As a repository owner
  I want reviews to follow the rules in my AGENTS.md, CLAUDE.md and skills
  So that the bot checks project conventions, built once and reused

  Background:
    Given the base branch has "AGENTS.md" with "Never log card numbers."
    And the context builder extracts the rule "Never log card numbers." from "AGENTS.md"

  Scenario: The first review builds and stores the review context
    When PubSub pushes a PR event for "acme/payments" PR #7 with action "opened"
    Then the push response reports status "completed"
    And the review of "github:acme:payments:7" used a "built" context with 1 rule
    And 1 review context is stored for "acme/payments"

  Scenario: A later review reuses the stored context
    When PubSub pushes a PR event for "acme/payments" PR #7 with action "opened"
    And PubSub pushes a PR event for "acme/payments" PR #8 with action "opened"
    Then the review of "github:acme:payments:8" used a "cache" context with 1 rule
    And 1 review context is stored for "acme/payments"
