import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function makeTmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'revu-git-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-b', 'main');
  g('config', 'user.email', 'test@revu.local');
  g('config', 'user.name', 'revu test');
  return {
    root,
    commit(file: string, content: string, msg: string) {
      mkdirSync(join(root, dirname(file)), { recursive: true });
      writeFileSync(join(root, file), content);
      g('add', '-A');
      g('commit', '-m', msg);
    },
    branch(name: string) { g('checkout', '-b', name); },
    stage(file: string, content: string) {
      mkdirSync(join(root, dirname(file)), { recursive: true });
      writeFileSync(join(root, file), content);
      g('add', file);
    },
    commitAll(msg: string) { g('add', '-A'); g('commit', '-m', msg); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}
