import { MockDecisionModel } from '../decisions/mock-decision-model.js';
import { MockLlm, type MockLlmOptions } from '../providers/mock.llm.js';
import type { AgentModels } from './agent-models.js';

/**
 * Test double for {@link AgentModels}: a `MockDecisionModel` for triage (it
 * gives the most cautious answers, i.e. a deep review) and a `MockLlm` per
 * agent, with any role replaced by `overrides`.
 */
export function createMockAgentModels(
  overrides: Partial<AgentModels> = {},
  options: Omit<MockLlmOptions, 'model'> = {},
): AgentModels {
  return {
    triage: new MockDecisionModel(undefined, 'mock-triage'),
    reviewer: new MockLlm({ ...options, model: 'mock-reviewer' }),
    verifier: new MockLlm({ ...options, model: 'mock-verifier' }),
    ...overrides,
  };
}
