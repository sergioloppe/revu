import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15000,
    // `.claude/worktrees/**` holds full checkouts of this repo, so the default include
    // pattern picked up their (stale) copies of these same tests and ran the suite
    // twice — doubling runtime and reporting results from code nobody is editing.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
