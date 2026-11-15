import { MockLlm, type MockLlmOptions } from '../providers/mock.llm.js';
import type { AgentModels } from './agent-models.js';

/**
 * Test double for {@link AgentModels}: a `MockLlm` per role, named after the
 * role, with any role replaced by `overrides`.
 */
export function createMockAgentModels(
  overrides: Partial<AgentModels> = {},
  options: Omit<MockLlmOptions, 'model'> = {},
): AgentModels {
  return {
    triage: new MockLlm({ ...options, model: 'mock-triage' }),
    reviewer: new MockLlm({ ...options, model: 'mock-reviewer' }),
    verifier: new MockLlm({ ...options, model: 'mock-verifier' }),
    ...overrides,
  };
}
