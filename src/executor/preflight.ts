import { execFileSync } from 'node:child_process';
import { ToolError } from '../errors.js';

export type AuthMode = 'subscription' | 'api_key';

export function detectAuthMode(env: NodeJS.ProcessEnv): AuthMode {
  return env.ANTHROPIC_API_KEY ? 'api_key' : 'subscription';
}

export function preflight(claudeBin: string, env: NodeJS.ProcessEnv): { authMode: AuthMode } {
  try {
    execFileSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 15000 });
  } catch (err) {
    throw new ToolError(
      `cannot run "${claudeBin} --version" — is Claude Code installed and on PATH? (${(err as Error).message})`,
    );
  }
  return { authMode: detectAuthMode(env) };
}
