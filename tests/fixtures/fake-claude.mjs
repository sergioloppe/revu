#!/usr/bin/env node
// Fake `claude` binary. Modes via FAKE_CLAUDE_MODE:
//   pass | fail | malformed-once | malformed-always | slow | jitter | mutate | mutate-one | crash | exit-early
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  console.log('fake-claude 1.0.0');
  process.exit(0);
}

const mode = process.env.FAKE_CLAUDE_MODE ?? 'pass';
// Exit without reading stdin at all, so a large prompt write hits a genuine EPIPE.
if (mode === 'exit-early') process.exit(3);
const stdin = readFileSync(0, 'utf8'); // consume the prompt

// When FAKE_PROMPT_DUMP_DIR is set, dump the exact prompt each reviewer received to
// <dir>/<reviewerId>.prompt.txt, so a test can assert on prompt *content* (e.g. which
// reviewers got which injected context docs) rather than just pass/fail behavior.
const promptDumpDir = process.env.FAKE_PROMPT_DUMP_DIR;

// Concurrency tracking: when FAKE_MARKER_FILE is set, every invocation appends
// "start,<reviewerId>,<ts>" as soon as it wakes up. Modes that sleep (currently
// 'jitter') also append "end,<reviewerId>,<ts>" right before they respond, so a
// test can reconstruct how many invocations were in flight at once.
const markerFile = process.env.FAKE_MARKER_FILE;
const reviewerIdMatch = stdin.match(/"reviewer" is "([^"]+)"/);
const reviewerId = reviewerIdMatch ? reviewerIdMatch[1] : 'unknown';
if (promptDumpDir) writeFileSync(join(promptDumpDir, `${reviewerId}.prompt.txt`), stdin);

// When FAKE_SETTINGS_DUMP is set, copy the generated --settings file there before the
// orchestrator deletes its temp dir, so a test can assert on the isolation settings
// (permission denies, disabled MCP/hooks) the reviewer actually ran under.
const settingsDump = process.env.FAKE_SETTINGS_DUMP;
if (settingsDump) {
  const i = process.argv.indexOf('--settings');
  if (i !== -1 && process.argv[i + 1]) writeFileSync(settingsDump, readFileSync(process.argv[i + 1], 'utf8'));
}
function mark(event) {
  if (markerFile) appendFileSync(markerFile, `${event},${reviewerId},${Date.now()}\n`);
}
mark('start');

const report = (status, issues) => JSON.stringify({
  schema_version: 1, reviewer: 'security', status,
  confidence: 0.95, severity: issues.length ? 'high' : 'none',
  summary: issues.length ? 'eval on user input' : 'no issues found',
  issues,
});
// The fixture repos all write `const x = 1;\neval(input);\n` to src/a.ts, so this
// fix resolves against line 2 of a real file — exercising the same validation path a
// live reviewer's fix goes through.
const ISSUE = { rule: 'SEC-001', message: 'eval of user input', file: 'src/a.ts',
  line: 2, line_end: 2, severity: 'high', confidence: 0.97,
  suggestion: 'Parse the input instead of evaluating it.',
  fix: { line: 2, line_end: 2, replacement: 'JSON.parse(input);' } };
const envelope = (result) => JSON.stringify({ result, total_cost_usd: 0.05 });

function emit(result) { process.stdout.write(envelope(result)); process.exit(0); }

switch (mode) {
  case 'pass': emit(report('PASS', []));
  case 'fail': emit(report('FAIL', [ISSUE]));
  case 'malformed-always': emit('Here are my findings, in prose.');
  case 'malformed-once': {
    const stateFile = process.env.FAKE_STATE_FILE;
    if (stateFile && !existsSync(stateFile)) {
      writeFileSync(stateFile, '1');
      // A retry prompt must contain the validation error we caused.
      emit('Here are my findings, in prose.');
    }
    if (!stdin.includes('failed schema validation')) {
      process.stderr.write('retry prompt missing validation error');
      process.exit(65);
    }
    emit(report('FAIL', [ISSUE]));
  }
  case 'slow': setTimeout(() => emit(report('PASS', [])), 60_000); break;
  case 'jitter': {
    // Deterministic per-reviewer delay (no real randomness, so runs are reproducible)
    // short enough to keep the suite fast but long enough to create real overlap.
    let hash = 0;
    for (const ch of reviewerId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const delayMs = 5 + (hash % 30);
    setTimeout(() => { mark('end'); emit(report('PASS', [])); }, delayMs);
    break;
  }
  case 'mutate': {
    writeFileSync(process.env.FAKE_MUTATE_PATH ?? 'evil.ts', 'hacked\n');
    emit(report('PASS', []));
  }
  case 'mutate-one': {
    // Only FAKE_MUTATE_REVIEWER_ID mutates (immediately); everyone else behaves like
    // 'jitter' so they stay in flight long enough to overlap with the mutator.
    if (reviewerId === process.env.FAKE_MUTATE_REVIEWER_ID) {
      writeFileSync(process.env.FAKE_MUTATE_PATH ?? 'evil.ts', 'hacked\n');
      emit(report('PASS', []));
    }
    setTimeout(() => { mark('end'); emit(report('PASS', [])); }, 30);
    break;
  }
  case 'crash': {
    process.stderr.write('boom');
    process.exit(7);
  }
  default: process.exit(64);
}
