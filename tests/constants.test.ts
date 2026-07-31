import { describe, it, expect } from 'vitest';
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, MAX_TURNS, EXIT, DEFAULT_MODEL } from '../src/constants.js';

describe('security constants', () => {
  it('pins the read-only toolset', () => {
    expect(ALLOWED_TOOLS).toBe('Read,Grep,Glob');
    expect(DISALLOWED_TOOLS).toBe('Write,Edit,Bash,WebFetch,WebSearch,Task');
    expect(MAX_TURNS).toBe(12);
  });
  it('pins exit codes to the spec', () => {
    expect(EXIT).toEqual({ PASS: 0, FAIL: 1, NEEDS_HUMAN: 2, TOOL_ERROR: 3, TIER0: 4 });
  });
  it('has a current default model', () => {
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5');
  });
});
