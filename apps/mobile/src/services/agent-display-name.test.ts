import { resolveAgentDisplayName } from './agent-display-name';

describe('resolveAgentDisplayName', () => {
  it('prefers identity name when it is not a placeholder', () => {
    expect(resolveAgentDisplayName({
      id: 'writer',
      name: 'Writer Config',
      identity: { name: 'Writer Identity' },
    })).toBe('Writer Identity');
  });

  it('falls back to config name when identity name is Assistant', () => {
    expect(resolveAgentDisplayName({
      id: 'writer',
      name: 'Writer Config',
      identity: { name: 'Assistant' },
    })).toBe('Writer Config');
  });

  it('falls back to id when both names are Assistant', () => {
    expect(resolveAgentDisplayName({
      id: 'writer',
      name: 'Assistant',
      identity: { name: 'Assistant' },
    })).toBe('writer');
  });

  it('returns id when it is the only usable value', () => {
    expect(resolveAgentDisplayName({
      id: 'writer',
      name: '   ',
      identity: { name: '   ' },
    })).toBe('writer');
  });
});

