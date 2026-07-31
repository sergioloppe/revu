import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { makeTmpRepo } from './helpers/tmprepo.js';

const SHIM = resolve('tests/fixtures/fake-claude.mjs');
const CLI = resolve('src/cli.ts');
const TSX = resolve('node_modules/.bin/tsx');

let repo: ReturnType<typeof makeTmpRepo>;

function runCli(
  cwd: string, mode: string, args: string[] = [], extraEnv: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  // spawnSync (not execFileSync) so stderr is captured on success too — execFileSync
  // only surfaces it via the thrown error, and lets it inherit otherwise, which both
  // hides progress output from assertions and floods the test runner.
  const res = spawnSync(TSX, [CLI, ...args], {
    cwd, encoding: 'utf8',
    env: {
      PATH: process.env.PATH!, HOME: process.env.HOME!,
      REVU_CLAUDE_BIN: SHIM, REVU_CONFIG_HOME: '/nonexistent-global',
      FAKE_CLAUDE_MODE: mode, ...extraEnv,
    },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function setupReviewDir(root: string) {
  const rd = join(root, '.review');
  mkdirSync(join(rd, 'rules', 'security'), { recursive: true });
  mkdirSync(join(rd, 'reviewers'), { recursive: true });
  writeFileSync(join(rd, 'config.yaml'),
    'schema_version: 1\nreviewers:\n  - id: security\n    tier: 1\n    rules: rules/security/**\n    min_confidence_to_block: 0.7\n');
  writeFileSync(join(rd, 'rules', 'security', 'SEC-001.md'),
    '---\nid: SEC-001\ntitle: No eval\ndomain: security\nseverity: high\nblocking: true\nstatus: active\n---\n\nNever eval user input.\n');
  writeFileSync(join(rd, 'reviewers', 'security.md'),
    '---\nid: security\n---\n\nSecurity only.\n');
}

beforeEach(() => {
  repo = makeTmpRepo();
  repo.commit('src/a.ts', 'const x = 1;\n', 'base');
  setupReviewDir(repo.root);
  repo.commitAll('review config');
  repo.branch('feature');
  repo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');
});
afterEach(() => repo.cleanup());

describe('revu CLI end-to-end', () => {
  it('exits 1 and writes the report on a blocking finding', () => {
    const res = runCli(repo.root, 'fail');
    expect(res.code).toBe(1);
    const reportPath = join(repo.root, '.review-report.json');
    expect(existsSync(reportPath)).toBe(true);
    const envelope = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(envelope.status).toBe('FAIL');
    expect(envelope.auth_mode).toBe('subscription');
    expect(envelope.reviews[0].issues[0].rule).toBe('SEC-001');
  });

  it('exits 0 on a pass', () => {
    expect(runCli(repo.root, 'pass').code).toBe(0);
  });

  it('exits 3 with a SECURITY error when the reviewer mutates the repo', () => {
    const res = runCli(repo.root, 'mutate');
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('SECURITY');
    expect(res.stderr).toContain('security');
  });

  it('exits 0 with a vacuous PASS when no reviewers are configured', () => {
    const bare = makeTmpRepo();
    try {
      bare.commit('a.ts', 'x\n', 'c1');
      bare.branch('f');
      bare.commit('a.ts', 'y\n', 'c2');
      const res = runCli(bare.root, 'pass');
      expect(res.code).toBe(0); // no reviewers configured: vacuous PASS
    } finally { bare.cleanup(); }
  });
});

function setupMultiReviewerDir(root: string) {
  const rd = join(root, '.review');
  mkdirSync(join(rd, 'rules', 'security'), { recursive: true });
  mkdirSync(join(rd, 'reviewers'), { recursive: true });
  writeFileSync(join(rd, 'config.yaml'), [
    'schema_version: 1',
    'reviewers:',
    '  - id: security',
    '    tier: 1',
    '    rules: rules/security/**',
    '    min_confidence_to_block: 0.7',
    '  - id: testing',
    '    tier: 2',
    '    rules: rules/security/**',
    '    min_confidence_to_block: 0.7',
  ].join('\n'));
  writeFileSync(join(rd, 'rules', 'security', 'SEC-001.md'),
    '---\nid: SEC-001\ntitle: No eval\ndomain: security\nseverity: high\nblocking: true\nstatus: active\n---\n\nNever eval user input.\n');
  writeFileSync(join(rd, 'reviewers', 'security.md'), '---\nid: security\n---\n\nSecurity only.\n');
  writeFileSync(join(rd, 'reviewers', 'testing.md'), '---\nid: testing\n---\n\nTesting only.\n');
}

describe('revu CLI reviewer selection flags', () => {
  let mrepo: ReturnType<typeof makeTmpRepo>;
  beforeEach(() => {
    mrepo = makeTmpRepo();
    mrepo.commit('src/a.ts', 'const x = 1;\n', 'base');
    setupMultiReviewerDir(mrepo.root);
    mrepo.commitAll('review config');
    mrepo.branch('feature');
    mrepo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');
  });
  afterEach(() => mrepo.cleanup());

  it('--only runs a single named reviewer', () => {
    const res = runCli(mrepo.root, 'pass', ['--only', 'security']);
    expect(res.code).toBe(0);
    const envelope = JSON.parse(readFileSync(join(mrepo.root, '.review-report.json'), 'utf8'));
    expect(envelope.reviews.map((r: { reviewer: string }) => r.reviewer)).toEqual(['security']);
  });

  it('--tier 1 excludes tier-2 reviewers', () => {
    const res = runCli(mrepo.root, 'pass', ['--tier', '1']);
    expect(res.code).toBe(0);
    const envelope = JSON.parse(readFileSync(join(mrepo.root, '.review-report.json'), 'utf8'));
    expect(envelope.reviews.map((r: { reviewer: string }) => r.reviewer)).toEqual(['security']);
  });

  it('--skip excludes a named reviewer while running the rest', () => {
    const res = runCli(mrepo.root, 'fail', ['--skip', 'testing']);
    expect(res.code).toBe(1);
    const envelope = JSON.parse(readFileSync(join(mrepo.root, '.review-report.json'), 'utf8'));
    expect(envelope.reviews.map((r: { reviewer: string }) => r.reviewer)).toEqual(['security']);
  });

  it.each(['3', '-1', 'abc', '1.5'])('--tier %s is rejected with exit 3 and no report written', (bad) => {
    const res = runCli(mrepo.root, 'pass', ['--tier', bad]);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('--tier must be 0, 1, or 2');
    expect(existsSync(join(mrepo.root, '.review-report.json'))).toBe(false);
  });

  it('--tier 0, 1, and 2 are all accepted', () => {
    for (const t of ['0', '1', '2']) {
      const res = runCli(mrepo.root, 'pass', ['--tier', t]);
      expect(res.code).toBe(0);
    }
  });
});

function setupTier0Dir(root: string, checkCommand: string) {
  const rd = join(root, '.review');
  mkdirSync(join(rd, 'rules', 'security'), { recursive: true });
  mkdirSync(join(rd, 'reviewers'), { recursive: true });
  writeFileSync(join(rd, 'config.yaml'), [
    'schema_version: 1',
    'tiers:',
    '  "0":',
    '    checks:',
    '      - id: precheck',
    `        command: ${checkCommand}`,
    'reviewers:',
    '  - id: security',
    '    tier: 1',
    '    rules: rules/security/**',
    '    min_confidence_to_block: 0.7',
  ].join('\n'));
  writeFileSync(join(rd, 'rules', 'security', 'SEC-001.md'),
    '---\nid: SEC-001\ntitle: No eval\ndomain: security\nseverity: high\nblocking: true\nstatus: active\n---\n\nNever eval user input.\n');
  writeFileSync(join(rd, 'reviewers', 'security.md'), '---\nid: security\n---\n\nSecurity only.\n');
}

describe('revu CLI tier 0', () => {
  // A silent check (test -z "$(...)") gives the user nothing; the command must be
  // reported so the failure is reproducible by hand.
  it('names the command when a failing check produces no output', () => {
    const trepo = makeTmpRepo();
    try {
      trepo.commit('src/a.ts', 'const x = 1;\n', 'base');
      setupTier0Dir(trepo.root, 'test -z "nonempty"');
      trepo.commitAll('review config');
      trepo.branch('feature');
      trepo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');

      const res = runCli(trepo.root, 'pass');
      expect(res.code).toBe(4);
      expect(res.stderr).toContain('command: test -z "nonempty"');
      expect(res.stderr).toContain('the command produced no output');
      expect(res.stderr).toContain('exited 1');
    } finally { trepo.cleanup(); }
  });

  it('exits 4 with zero reviewer spend when a tier-0 check fails, via the real CLI wiring', () => {
    const trepo = makeTmpRepo();
    try {
      trepo.commit('src/a.ts', 'const x = 1;\n', 'base');
      setupTier0Dir(trepo.root, 'exit 1');
      trepo.commitAll('review config');
      trepo.branch('feature');
      trepo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');

      const res = runCli(trepo.root, 'fail');
      expect(res.code).toBe(4);
      expect(res.stderr).toContain('tier 0 check "precheck"');
      const envelope = JSON.parse(readFileSync(join(trepo.root, '.review-report.json'), 'utf8'));
      expect(envelope.tier_0).toEqual({ status: 'FAIL', checks: [{ id: 'precheck', status: 'FAIL', blocking: true, duration_ms: expect.any(Number) }] });
      expect(envelope.reviews).toEqual([]);
    } finally { trepo.cleanup(); }
  });

  it('--baseline does not mask a tier-0 failure: no baseline written, exit 4 propagated', () => {
    const trepo = makeTmpRepo();
    try {
      trepo.commit('src/a.ts', 'const x = 1;\n', 'base');
      setupTier0Dir(trepo.root, 'exit 1');
      trepo.commitAll('review config');
      trepo.branch('feature');
      trepo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');

      const res = runCli(trepo.root, 'fail', ['--baseline']);
      expect(res.code).toBe(4); // propagated, not masked to 0
      expect(res.stderr).toContain('baseline NOT written');
      expect(existsSync(join(trepo.root, '.review', 'baseline.json'))).toBe(false);
    } finally { trepo.cleanup(); }
  });

  it('--tier 0 runs only tier-0 checks through the real CLI, even when the fake reviewer would fail', () => {
    const trepo = makeTmpRepo();
    try {
      trepo.commit('src/a.ts', 'const x = 1;\n', 'base');
      setupTier0Dir(trepo.root, 'exit 0');
      trepo.commitAll('review config');
      trepo.branch('feature');
      trepo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');

      const res = runCli(trepo.root, 'fail', ['--tier', '0']);
      expect(res.code).toBe(0);
      const envelope = JSON.parse(readFileSync(join(trepo.root, '.review-report.json'), 'utf8'));
      expect(envelope.reviews).toEqual([]);
      expect(envelope.tier_0).toEqual({ status: 'PASS', checks: [{ id: 'precheck', status: 'PASS', blocking: true, duration_ms: expect.any(Number) }] });
    } finally { trepo.cleanup(); }
  });
});

describe('revu CLI review cache', () => {
  it('caches across CLI invocations, and --no-cache forces a fresh run', () => {
    const crepo = makeTmpRepo();
    try {
      crepo.commit('src/a.ts', 'const x = 1;\n', 'base');
      setupReviewDir(crepo.root);
      crepo.commitAll('review config');
      crepo.branch('feature');
      crepo.commit('src/a.ts', 'const x = 1;\nconst y = 2;\n', 'benign change');

      const scratchDir = mkdtempSync(join(tmpdir(), 'revu-cli-cache-'));
      const markerFile = join(scratchDir, 'markers.log');
      const startCount = () => existsSync(markerFile)
        ? readFileSync(markerFile, 'utf8').trim().split('\n').filter((l) => l.startsWith('start,')).length
        : 0;
      try {
        expect(runCli(crepo.root, 'pass', [], { FAKE_MARKER_FILE: markerFile }).code).toBe(0);
        expect(startCount()).toBe(1);

        const second = runCli(crepo.root, 'pass', [], { FAKE_MARKER_FILE: markerFile });
        expect(second.code).toBe(0);
        expect(startCount()).toBe(1); // cache hit: no new spawn
        const envelope = JSON.parse(readFileSync(join(crepo.root, '.review-report.json'), 'utf8'));
        expect(envelope.reviews[0].cached).toBe(true);

        const third = runCli(crepo.root, 'pass', ['--no-cache'], { FAKE_MARKER_FILE: markerFile });
        expect(third.code).toBe(0);
        expect(startCount()).toBe(2); // --no-cache forced a re-run
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
      }
    } finally { crepo.cleanup(); }
  });
});

describe('revu CLI baseline and dismissals', () => {
  let brepo: ReturnType<typeof makeTmpRepo>;
  beforeEach(() => {
    brepo = makeTmpRepo();
    brepo.commit('src/a.ts', 'const x = 1;\n', 'base');
    setupReviewDir(brepo.root);
    brepo.commitAll('review config');
    brepo.branch('feature');
    brepo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');
  });
  afterEach(() => brepo.cleanup());

  it('--baseline records every finding and exits 0 even though the run itself FAILs', () => {
    const res = runCli(brepo.root, 'fail', ['--baseline']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('baseline recorded (1 findings)');
    const baseline = JSON.parse(readFileSync(join(brepo.root, '.review', 'baseline.json'), 'utf8'));
    expect(baseline.findings).toHaveLength(1);
    expect(baseline.findings[0].rule).toBe('SEC-001');
  });

  it('a subsequent run PASSes once the finding is baselined, with it visible under suppressed', () => {
    expect(runCli(brepo.root, 'fail', ['--baseline']).code).toBe(0);

    const res = runCli(brepo.root, 'fail');
    expect(res.code).toBe(0);
    const envelope = JSON.parse(readFileSync(join(brepo.root, '.review-report.json'), 'utf8'));
    expect(envelope.status).toBe('PASS');
    expect(envelope.reviews[0].issues).toEqual([]);
    expect(envelope.suppressed).toHaveLength(1);
    expect(envelope.suppressed[0].suppressed_by).toBe('baseline');
  });

  it('--dismiss appends a dismissal (approved_by from git config, expires +180d) and exits 0', () => {
    expect(runCli(brepo.root, 'fail').code).toBe(1);
    const envelope = JSON.parse(readFileSync(join(brepo.root, '.review-report.json'), 'utf8'));
    const id = envelope.reviews[0].issues[0].id;

    const res = runCli(brepo.root, 'fail', ['--dismiss', id, '--reason', 'accepted risk, tracked in JIRA-123']);
    expect(res.code).toBe(0);

    const dismissals = parseYaml(readFileSync(join(brepo.root, '.review', 'dismissals.yaml'), 'utf8'));
    expect(dismissals).toHaveLength(1);
    expect(dismissals[0].id).toBe(id);
    expect(dismissals[0].rule).toBe('SEC-001');
    expect(dismissals[0].reason).toBe('accepted risk, tracked in JIRA-123');
    expect(dismissals[0].approved_by).toBe('revu test'); // set by makeTmpRepo's git config user.name
    expect(dismissals[0].expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // and the dismissed finding no longer fails a subsequent run
    const rerun = runCli(brepo.root, 'fail');
    expect(rerun.code).toBe(0);
  });

  it('--dismiss falls back to approved_by "unknown" when git user.name is unset', () => {
    expect(runCli(brepo.root, 'fail').code).toBe(1);
    const envelope = JSON.parse(readFileSync(join(brepo.root, '.review-report.json'), 'utf8'));
    const id = envelope.reviews[0].issues[0].id;

    // makeTmpRepo sets user.name; unset it to exercise the fallback path (git()
    // throws — a nonzero `git config user.name` exit — rather than returning "").
    // GIT_CONFIG_GLOBAL/SYSTEM point at /dev/null so the real machine's global
    // ~/.gitconfig (which has a user.name) can't mask the unset local value.
    execFileSync('git', ['config', '--unset', 'user.name'], { cwd: brepo.root });

    const res = runCli(brepo.root, 'fail', ['--dismiss', id, '--reason', 'no git identity configured'],
      { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    expect(res.code).toBe(0);

    const dismissals = parseYaml(readFileSync(join(brepo.root, '.review', 'dismissals.yaml'), 'utf8'));
    expect(dismissals[0].approved_by).toBe('unknown');
  });

  it('--dismiss refuses (exit 3) when the id is not in .review-report.json', () => {
    expect(runCli(brepo.root, 'fail').code).toBe(1);
    const res = runCli(brepo.root, 'fail', ['--dismiss', 'not-a-real-id', '--reason', 'x']);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('not-a-real-id');
    expect(existsSync(join(brepo.root, '.review', 'dismissals.yaml'))).toBe(false);
  });

  it('--dismiss without --reason fails with exit 3', () => {
    expect(runCli(brepo.root, 'fail').code).toBe(1);
    const envelope = JSON.parse(readFileSync(join(brepo.root, '.review-report.json'), 'utf8'));
    const id = envelope.reviews[0].issues[0].id;
    const res = runCli(brepo.root, 'fail', ['--dismiss', id]);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('--reason');
  });
});

describe('revu CLI init scaffold (7-reviewer committee)', () => {
  // Every starter rule's `applies_to` glob is hit by one of these two files (verified
  // against src/templates.ts's ARCH-001/SEC-001/SEC-002/TEST-001/STD-001/PERF-001/
  // MAINT-001/DOC-001): OrderController.ts alone satisfies all six non-testing
  // domains (architecture, security, company-standards, performance,
  // maintainability, documentation), and its paired *.test.ts satisfies testing's
  // TEST-001 (which the exceptions on the others deliberately exclude). So with the
  // full `revu init` scaffold, none of the 7 reviewers is skipped for lacking an
  // applicable rule — this exercises the full committee, not a subset.
  it('scaffolds via `revu init`, then a diff touching every domain runs all 7 reviewers green', () => {
    const irepo = makeTmpRepo();
    try {
      irepo.commit('README.md', 'hi\n', 'init');
      expect(runCli(irepo.root, 'pass', ['init']).code).toBe(0);
      irepo.commitAll('scaffold .review/');
      irepo.branch('feature');
      irepo.commit('src/orders/OrderController.ts',
        'export class OrderController {\n  submit() { return true; }\n}\n', 'add controller');
      irepo.commit('src/orders/OrderController.test.ts',
        "import { describe, it } from 'vitest';\n" +
        "describe('OrderController', () => { it('submits', () => {}); });\n",
        'add controller test');

      const res = runCli(irepo.root, 'pass');
      expect(res.code).toBe(0);
      const envelope = JSON.parse(readFileSync(join(irepo.root, '.review-report.json'), 'utf8'));
      expect(envelope.status).toBe('PASS');
      expect(envelope.reviews.map((r: { reviewer: string }) => r.reviewer).sort()).toEqual(
        ['architecture', 'company-standards', 'documentation', 'maintainability',
          'performance', 'security', 'testing'].sort(),
      );
    } finally { irepo.cleanup(); }
  });
});

describe('revu CLI discoverability and progress', () => {
  let drepo: ReturnType<typeof makeTmpRepo>;
  beforeEach(() => {
    drepo = makeTmpRepo();
    drepo.commit('src/a.ts', 'const x = 1;\n', 'base');
    setupReviewDir(drepo.root);
    drepo.commitAll('review config');
    drepo.branch('feature');
  });
  afterEach(() => drepo.cleanup());

  it('--help explains what each mode reviews and lists the other commands', () => {
    const res = runCli(drepo.root, 'pass', ['--help']);
    expect(res.code).toBe(0);
    for (const expected of [
      'What gets reviewed', '--staged', '--working', '--range', '--files',
      'Exit codes', 'revu init', '--tier 0',
    ]) expect(res.stdout).toContain(expected);
  });

  it('--version reports the package.json version', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const res = runCli(drepo.root, 'pass', ['--version']);
    expect(res.stdout.trim()).toBe(pkg.version);
  });

  it('an empty default diff names the working-tree state and the flag to use', () => {
    writeFileSync(join(drepo.root, 'src/b.ts'), 'const y = 2;\n');
    execFileSync('git', ['add', 'src/b.ts'], { cwd: drepo.root });
    const res = runCli(drepo.root, 'pass');
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('1 staged');
    expect(res.stderr).toContain('revu --staged');
    expect(res.stderr).toContain('revu --help');
  });

  it('--working reviews uncommitted changes', () => {
    writeFileSync(join(drepo.root, 'src/a.ts'), 'const x = 1;\neval(input);\n');
    const res = runCli(drepo.root, 'pass', ['--working']);
    expect(res.code).toBe(0);
    const envelope = JSON.parse(readFileSync(join(drepo.root, '.review-report.json'), 'utf8'));
    expect(envelope.reviews.map((r: { reviewer: string }) => r.reviewer)).toEqual(['security']);
  });

  it('rejects two diff-mode flags at once instead of silently picking one', () => {
    const res = runCli(drepo.root, 'pass', ['--staged', '--working']);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('mutually exclusive');
    expect(existsSync(join(drepo.root, '.review-report.json'))).toBe(false);
  });

  it('streams per-reviewer progress to stderr, and -q silences it', () => {
    drepo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');
    const loud = runCli(drepo.root, 'pass', ['--no-cache']);
    expect(loud.code).toBe(0);
    expect(loud.stderr).toContain('→ security started');
    expect(loud.stderr).toContain('✓ security PASS');
    expect(loud.stdout).not.toContain('→ security started'); // report stream stays clean

    const quiet = runCli(drepo.root, 'pass', ['--no-cache', '-q']);
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe('');
  });
});

describe('revu CLI secret handling', () => {
  let srepo: ReturnType<typeof makeTmpRepo>;
  beforeEach(() => {
    srepo = makeTmpRepo();
    srepo.commit('src/a.ts', 'const x = 1;\n', 'base');
    setupReviewDir(srepo.root);
    srepo.commitAll('review config');
    srepo.branch('feature');
  });
  afterEach(() => srepo.cleanup());

  // The load-bearing guarantee: a credential value must never exist in any prompt
  // handed to a model, no matter that git says the file changed.
  it('never puts a credential file in a reviewer prompt', () => {
    const dump = mkdtempSync(join(tmpdir(), 'revu-prompts-'));
    try {
      writeFileSync(join(srepo.root, '.env.prestage'), 'DB_PASSWORD=S3cr3tP4ssw0rd\n');
      writeFileSync(join(srepo.root, '.env.example'), 'DB_PASSWORD=\n');
      writeFileSync(join(srepo.root, 'src/a.ts'), 'const x = 1;\neval(input);\n');
      // Must be tracked, or they are absent from `git diff HEAD` and the test proves
      // nothing — the exclusion has to be what keeps the secret out, not gitignore.
      execFileSync('git', ['add', '-f', '.env.prestage', '.env.example'], { cwd: srepo.root });

      const res = runCli(srepo.root, 'pass', ['--working', '--no-cache'],
        { FAKE_PROMPT_DUMP_DIR: dump });
      expect(res.code).toBe(0);

      const prompts = readdirSync(dump);
      expect(prompts.length).toBeGreaterThan(0);
      for (const f of prompts) {
        const prompt = readFileSync(join(dump, f), 'utf8');
        expect(prompt).not.toContain('S3cr3tP4ssw0rd');
        expect(prompt).not.toContain('.env.prestage');
        expect(prompt).toContain('.env.example'); // the template is still reviewable
      }

      const envelope = JSON.parse(readFileSync(join(srepo.root, '.review-report.json'), 'utf8'));
      expect(envelope.excluded_paths).toEqual(['.env.prestage']);
      expect(res.stderr).toContain('withheld (secret-bearing or revu-generated): .env.prestage');
    } finally { rmSync(dump, { recursive: true, force: true }); }
  });

  it('reports an empty diff rather than reviewing nothing silently', () => {
    writeFileSync(join(srepo.root, '.env'), 'TOKEN=abc123\n');
    execFileSync('git', ['add', '-f', '.env'], { cwd: srepo.root }); // tracked, so it is in the diff
    const res = runCli(srepo.root, 'pass', ['--working']);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('secret-bearing');
    expect(res.stderr).not.toContain('abc123');
  });
});

describe('revu CLI output format', () => {
  it('honors an explicit --format pretty even when stdout is piped', () => {
    const res = runCli(repo.root, 'fail', ['--format', 'pretty']);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('revu FAIL');
    expect(res.stdout).not.toContain('"schema_version"');
  });

  it('defaults to json when piped and there is no explicit --format', () => {
    const res = runCli(repo.root, 'fail');
    expect(res.stdout).toContain('"schema_version"');
  });

  it('rejects an unknown --format instead of silently falling back', () => {
    const res = runCli(repo.root, 'fail', ['--format', 'yaml']);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('--format must be pretty or json');
  });

  it('shows the suggested change as a before/after block in pretty output', () => {
    const res = runCli(repo.root, 'fail', ['--format', 'pretty']);
    expect(res.stdout).toContain('suggested change (line 2):');
    expect(res.stdout).toContain('- eval(input);');
    expect(res.stdout).toContain('+ JSON.parse(input);');
  });

  it('carries the resolved fix into the JSON envelope', () => {
    runCli(repo.root, 'fail');
    const envelope = JSON.parse(readFileSync(join(repo.root, '.review-report.json'), 'utf8'));
    expect(envelope.reviews[0].issues[0].fix).toEqual({
      line: 2, line_end: 2, replacement: 'JSON.parse(input);', original: 'eval(input);',
    });
  });
});

describe('revu CLI --skip-tier', () => {
  let trepo: ReturnType<typeof makeTmpRepo>;
  beforeEach(() => {
    trepo = makeTmpRepo();
    trepo.commit('src/a.ts', 'const x = 1;\n', 'base');
    setupTier0Dir(trepo.root, 'exit 1'); // a tier-0 check that always fails
    trepo.commitAll('review config');
    trepo.branch('feature');
    trepo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'introduce eval');
  });
  afterEach(() => trepo.cleanup());

  // The reported case: a pre-existing tier-0 failure in code the diff never touched
  // blocks the review entirely, with no way past it.
  it('runs the reviewers even when a tier-0 check would fail', () => {
    expect(runCli(trepo.root, 'pass').code).toBe(4); // blocked without the flag

    const res = runCli(trepo.root, 'pass', ['--skip-tier', '0']);
    expect(res.code).toBe(0);
    const envelope = JSON.parse(readFileSync(join(trepo.root, '.review-report.json'), 'utf8'));
    expect(envelope.tier_0).toBeNull();
    expect(envelope.skipped_tiers).toEqual([0]);
    expect(envelope.reviews.length).toBeGreaterThan(0);
  });

  it('says loudly that the gate did not run', () => {
    const res = runCli(trepo.root, 'pass', ['--skip-tier', '0', '--format', 'pretty']);
    expect(res.stderr).toContain('tier 0: SKIPPED');
    expect(res.stdout).toContain('tier 0 SKIPPED');
  });

  it('skips advisory reviewers with --skip-tier 2', () => {
    const mrepo = makeTmpRepo();
    try {
      mrepo.commit('src/a.ts', 'const x = 1;\n', 'base');
      setupMultiReviewerDir(mrepo.root);
      mrepo.commitAll('cfg');
      mrepo.branch('feature');
      mrepo.commit('src/a.ts', 'const x = 1;\neval(input);\n', 'eval');
      const res = runCli(mrepo.root, 'pass', ['--skip-tier', '2']);
      expect(res.code).toBe(0);
      const envelope = JSON.parse(readFileSync(join(mrepo.root, '.review-report.json'), 'utf8'));
      expect(envelope.reviews.map((r: { reviewer: string }) => r.reviewer)).toEqual(['security']);
      expect(envelope.skipped_tiers).toEqual([2]);
    } finally { mrepo.cleanup(); }
  });

  it.each([
    [['--skip-tier', '3'], '--skip-tier takes 0, 1, or 2'],
    [['--tier', '1', '--skip-tier', '1'], 'cancel out'],
    [['--skip-tier', '0,1,2'], 'skips everything'],
  ])('rejects %j', (args, expected) => {
    const res = runCli(trepo.root, 'pass', args);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain(expected);
  });
});
