/** Reviewer toolset. Compile-time constants — never configurable (design §3.2). */
export const ALLOWED_TOOLS = 'Read,Grep,Glob';
export const DISALLOWED_TOOLS = 'Write,Edit,Bash,WebFetch,WebSearch,Task';
export const MAX_TURNS = 12;
/**
 * Longest suggested fix kept, in lines of replacement text (and of the range it
 * replaces). A fix is meant to be the few-line edit a reader can apply at a glance;
 * past this it's a redesign, which belongs in `suggestion` prose. Oversized fixes
 * are dropped, never truncated — half an edit is worse than none.
 */
export const MAX_FIX_LINES = 20;
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * Paths whose content is never sent to a reviewer and which reviewers may not open.
 *
 * Compile-time and non-configurable, for the same reason ALLOWED_TOOLS is: a config
 * key that could re-enable secret files would be the first thing a bad diff edits.
 * These files hold credential *values*; nothing a reviewer can usefully say about
 * them is worth putting a live secret into a model prompt. The diff excludes them
 * before compilation (the real guarantee — the content never exists in the prompt),
 * and the reviewer's own settings deny reading them (defense in depth, for the case
 * where a reviewer goes looking on its own).
 *
 * Deliberately NOT here: Dockerfiles, compose files, CI config, and source. Those
 * are code — reviewing them is how revu catches a secret being *baked into* an
 * image, which is a finding worth having.
 */
export const SECRET_PATH_DENY = [
  '**/.env', '**/.env.*',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore',
  '**/id_rsa*', '**/id_ecdsa*', '**/id_ed25519*',
  '**/.npmrc', '**/.netrc', '**/.pypirc', '**/.htpasswd',
  '**/credentials', '**/credentials.*', '**/*.kubeconfig',
  '**/secrets.yaml', '**/secrets.yml', '**/secrets.json',
] as const;

/**
 * Re-included from SECRET_PATH_DENY: env *templates* carry variable names, not
 * values, and rules like "a new env var must land in .env.example in the same diff"
 * can't be checked without them. Only reachable through the diff — a reviewer still
 * cannot open one directly.
 */
export const SECRET_PATH_ALLOW = [
  '**/.env.example', '**/.env.sample', '**/.env.template', '**/.env.dist',
] as const;

/**
 * revu's own generated output, excluded from every diff it reviews.
 *
 * A committed `.review-report.json` quotes prior findings verbatim — including any
 * secret a reviewer cited — so leaving it in the diff feeds last run's findings back
 * into this run's prompts, and re-sends a credential the report was complaining
 * about. These are outputs, never authored source; there is nothing to review.
 * Authored catalog content (`.review/rules/**`, `.review/config.yaml`) is NOT here —
 * that's a change like any other.
 */
export const GENERATED_PATH_DENY = [
  '**/.review-report.json', '**/.review/cache/**',
  '**/.review/baseline.json', '**/.review/dismissals.yaml',
] as const;
// Re-exported for existing importers; the value comes from package.json (see version.ts).
export { REVU_VERSION } from './version.js';

export const EXIT = {
  PASS: 0,
  FAIL: 1,
  NEEDS_HUMAN: 2,
  TOOL_ERROR: 3,
  TIER0: 4,
} as const;
