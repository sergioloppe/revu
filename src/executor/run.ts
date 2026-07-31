import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, MAX_TURNS, SECRET_PATH_DENY } from '../constants.js';
import type { ReviewerReport } from '../report/schema.js';
import type { ValidateResult } from '../report/validate.js';

const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

export function resolveClaudeBin(env: NodeJS.ProcessEnv): string {
  return env.REVU_CLAUDE_BIN ?? 'claude';
}

export interface RunReviewerOpts {
  reviewerId: string; model: string; prompt: string;
  timeoutSeconds: number; repoRoot: string;
  claudeBin: string; env: NodeJS.ProcessEnv;
  validate: (stdout: string) => ValidateResult;
}
export interface RunOutcome { report: ReviewerReport; costUsd: number | null; retried: boolean }

/** Isolation layer (design §3.2): reviewers get no MCP servers, no hooks, no user settings. */
function writeIsolatedSettings(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revu-settings-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify({
    mcpServers: {},
    hooks: {},
    disableAllHooks: true,
    // Second layer over the diff-level exclusion: the reviewer's read tools are also
    // denied these paths, so a reviewer that goes looking on its own (rather than
    // reading the diff it was given) still cannot open a credential file. The diff
    // exclusion is the guarantee; this closes the "reviewer used Grep" gap.
    permissions: {
      deny: SECRET_PATH_DENY.flatMap((p) => [`Read(${p})`, `Grep(${p})`, `Glob(${p})`]),
    },
  }));
  return path;
}

function pickEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) if (env[key] !== undefined) out[key] = env[key];
  // Test hook: FAKE_* variables drive the shim; harmless for the real binary.
  for (const key of Object.keys(env)) if (key.startsWith('FAKE_')) out[key] = env[key];
  return out;
}

interface SpawnResult { stdout: string; stderr: string; code: number | null; timedOut: boolean }

function spawnOnce(opts: RunReviewerOpts, prompt: string, settingsPath: string): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', opts.model,
      '--allowed-tools', ALLOWED_TOOLS,
      '--disallowed-tools', DISALLOWED_TOOLS,
      '--permission-mode', 'dontAsk',
      '--max-turns', String(MAX_TURNS),
      '--settings', settingsPath,
      '--strict-mcp-config',
    ];
    const child = spawn(opts.claudeBin, args, { cwd: opts.repoRoot, env: pickEnv(opts.env) });
    // The child may exit (timeout SIGKILL, bad model, auth error) before stdin has drained;
    // without this handler Node throws an unhandled 'error' (EPIPE) that crashes the process.
    child.stdin.on('error', () => { /* ignored: close handler still resolves */ });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutSeconds * 1000);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ stdout, stderr, code, timedOut }); });
    child.on('error', () => { clearTimeout(timer); resolvePromise({ stdout, stderr, code: null, timedOut }); });
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch { /* ignored: close handler still resolves */ }
  });
}

function humanReview(reviewerId: string, summary: string, debug: string): ReviewerReport {
  return {
    schema_version: 1, reviewer: reviewerId, status: 'NEEDS_HUMAN_REVIEW',
    confidence: 0, severity: 'none', summary, issues: [], debug,
  };
}

function debugWithStderr(stdout: string, stderr: string): string {
  return stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
}

export async function runReviewer(opts: RunReviewerOpts): Promise<RunOutcome> {
  const settingsPath = writeIsolatedSettings();
  const settingsDir = dirname(settingsPath);

  try {
    const first = await spawnOnce(opts, opts.prompt, settingsPath);
    if (first.timedOut) {
      return { report: humanReview(opts.reviewerId, `reviewer timed out after ${opts.timeoutSeconds}s`, debugWithStderr(first.stdout, first.stderr)), costUsd: null, retried: false };
    }
    if (first.code !== 0) {
      return { report: humanReview(opts.reviewerId, `claude exited with code ${first.code}`, debugWithStderr(first.stdout, first.stderr)), costUsd: null, retried: false };
    }
    const v1 = opts.validate(first.stdout);
    if (v1.ok) return { report: v1.report, costUsd: v1.costUsd, retried: false };

    // Retry once with the validation error appended (design §6).
    const retryPrompt = `${opts.prompt}\n\nYour previous response failed schema validation with the following error: ` +
      `${v1.error}. Return only valid JSON matching the schema.`;
    const second = await spawnOnce(opts, retryPrompt, settingsPath);
    if (second.timedOut || second.code !== 0) {
      return { report: humanReview(opts.reviewerId, 'retry failed to execute', debugWithStderr(second.stdout, second.stderr)), costUsd: null, retried: true };
    }
    const v2 = opts.validate(second.stdout);
    if (v2.ok) return { report: v2.report, costUsd: v2.costUsd, retried: true };

    return {
      report: humanReview(opts.reviewerId, `output failed schema validation twice: ${v2.error}`, debugWithStderr(second.stdout, second.stderr)),
      costUsd: null, retried: true,
    };
  } finally {
    rmSync(settingsDir, { recursive: true, force: true });
  }
}
