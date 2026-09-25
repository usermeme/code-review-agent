import { describe, expect, it } from 'vitest';
import { parseRepoCoordinates } from './archive.service.js';

describe('archive.service', () => {
  describe('parseRepoCoordinates', () => {
    it('parses owner and repo from standard https clone url', () => {
      const coords = parseRepoCoordinates('https://github.com/my-org/my-repo.git');
      expect(coords).toEqual({ owner: 'my-org', repo: 'my-repo' });
    });

    it('parses owner and repo without .git suffix', () => {
      const coords = parseRepoCoordinates('https://github.com/usermeme/code-review-agent');
      expect(coords).toEqual({ owner: 'usermeme', repo: 'code-review-agent' });
    });

    it('parses ssh-style clone url', () => {
      const coords = parseRepoCoordinates('git@github.com:google/adk.git');
      expect(coords).toEqual({ owner: 'google', repo: 'adk' });
    });

    it('returns empty object when cloneUrl is undefined', () => {
      expect(parseRepoCoordinates(undefined)).toEqual({});
    });
  });
});
