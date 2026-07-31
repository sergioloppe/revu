import { describe, it, expect } from 'vitest';
import { createReporter, silentReporter } from '../src/progress.js';

function capture() {
  const lines: string[] = [];
  const reporter = createReporter({
    color: false, heartbeat: false, write: (l) => { lines.push(l); },
  });
  return { reporter, lines, text: () => lines.join('\n') };
}

describe('createReporter', () => {
  it('announces the run, the diff mode, and the reviewer plan', () => {
    const { reporter, text } = capture();
    reporter.runStart('1.2.3', '/repo');
    reporter.diff({ mode: 'staged changes', base: 'abc1234def', head: 'abc1234def', files: 106 });
    reporter.plan({ reviewers: ['security', 'testing'], skipped: ['perf'], maxParallel: 4, rules: 12 });
    reporter.done();

    expect(text()).toContain('revu 1.2.3');
    expect(text()).toContain('staged changes');
    expect(text()).toContain('106 file(s)');
    expect(text()).toContain('2 to run');
    expect(text()).toContain('12 applicable rule(s)');
    expect(text()).toContain('up to 4 in parallel');
    expect(text()).toContain('skipped (no applicable rules): perf');
  });

  it('names the changed paths, not just how many there were', () => {
    const { reporter, text } = capture();
    reporter.diff({
      mode: 'uncommitted changes', base: 'abc1234', head: 'abc1234', files: 2,
      paths: ['.gitignore', 'TECHNICAL_DOCUMENTATION.md'],
    });
    reporter.done();
    expect(text()).toContain('.gitignore, TECHNICAL_DOCUMENTATION.md');
  });

  it('caps a long path list so it cannot bury the message it belongs to', () => {
    const { reporter, text } = capture();
    const paths = Array.from({ length: 40 }, (_, i) => `app/File${i}.php`);
    reporter.diff({ mode: 'range', base: 'a', head: 'b', files: 40, paths });
    reporter.done();
    expect(text()).toContain('app/File0.php');
    expect(text()).toContain('… and 32 more');
    expect(text()).not.toContain('app/File39.php');
  });

  it('explains an unmatched diff: which paths, and what the catalog covers', () => {
    const { reporter, text } = capture();
    reporter.plan({
      reviewers: [], skipped: ['security', 'eloquent'], maxParallel: 4, rules: 0,
      coverage: {
        paths: ['.gitignore', 'TECHNICAL_DOCUMENTATION.md'],
        globs: ['app/**/*.php', 'routes/**/*.php'],
      },
    });
    reporter.done();
    expect(text()).toContain('no catalog rule matched these paths');
    expect(text()).toContain('.gitignore, TECHNICAL_DOCUMENTATION.md');
    expect(text()).toContain('this catalog covers: app/**/*.php, routes/**/*.php');
    expect(text()).toContain('revu doctor');
  });

  it('falls back to the plain message when there is no coverage detail', () => {
    const { reporter, text } = capture();
    reporter.plan({ reviewers: [], skipped: [], maxParallel: 4, rules: 3 });
    reporter.done();
    expect(text()).toContain('no reviewers to run (no configured reviewer matched an applicable rule)');
  });

  it('abbreviates a base..head range and collapses base === head to one sha', () => {
    const { reporter, text } = capture();
    reporter.diff({ mode: 'branch commits vs merge base', base: 'a'.repeat(40), head: 'b'.repeat(40), files: 2 });
    reporter.diff({ mode: 'staged changes', base: 'c'.repeat(40), head: 'c'.repeat(40), files: 1 });
    expect(text()).toContain(`${'a'.repeat(7)}..${'b'.repeat(7)}`);
    expect(text()).toContain('ccccccc ·');
    expect(text()).not.toContain('ccccccc..ccccccc');
  });

  it('marks each reviewer as it starts and finishes, and flags cache hits', () => {
    const { reporter, text } = capture();
    reporter.reviewerStart('security', 'claude-opus-4-8', 3);
    reporter.reviewerDone('security', 'FAIL', 41_200, false);
    reporter.reviewerDone('testing', 'PASS', 0, true);
    reporter.reviewerDone('docs', 'NEEDS_HUMAN_REVIEW', 120_000, false);

    expect(text()).toContain('→ security started (claude-opus-4-8, 3 rule(s))');
    expect(text()).toContain('✗ security FAIL (41.2s)');
    expect(text()).toContain('✓ testing PASS (cached)');
    expect(text()).toContain('? docs NEEDS_HUMAN_REVIEW');
  });

  it('reports tier-0 checks one at a time rather than only at the end', () => {
    const { reporter, lines } = capture();
    reporter.tier0Start(2);
    reporter.tier0Check({ id: 'build', status: 'PASS', duration_ms: 1822 });
    reporter.tier0Check({ id: 'vet', status: 'FAIL', duration_ms: 391 });
    expect(lines[0]).toContain('running 2 check(s)');
    expect(lines[1]).toContain('✓ build (1.8s)');
    expect(lines[2]).toContain('✗ vet (391ms)');
  });

  it('says so when no reviewer had anything to do', () => {
    const { reporter, text } = capture();
    reporter.plan({ reviewers: [], skipped: ['security'], maxParallel: 4, rules: 0 });
    expect(text()).toContain('no reviewers to run');
  });

  it('heartbeats the in-flight reviewers, and stops once they finish', async () => {
    const lines: string[] = [];
    const reporter = createReporter({
      color: false, heartbeat: true, intervalMs: 10, write: (l) => { lines.push(l); },
    });
    reporter.plan({ reviewers: ['security'], skipped: [], maxParallel: 1, rules: 1 });
    reporter.reviewerStart('security', 'claude-sonnet-5', 1);
    await new Promise((r) => setTimeout(r, 45));
    const beats = lines.filter((l) => l.includes('still running')).length;
    expect(beats).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('still running: security'))).toBe(true);

    reporter.reviewerDone('security', 'PASS', 45, false);
    reporter.done();
    const after = lines.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(lines.length).toBe(after); // no beats after done()
  });

  it('silentReporter writes nothing', () => {
    // Any throw here (or output) would surface as a failing assertion downstream.
    expect(() => {
      silentReporter.runStart('1.0.0', '/repo');
      silentReporter.reviewerStart('a', 'm', 1);
      silentReporter.done();
    }).not.toThrow();
  });
});
