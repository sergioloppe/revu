import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildLanguages, renderLanguages, languagesCommand } from '../src/commands/languages.js';
import { LANGUAGES, PACKS } from '../src/packs.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'revu-languages-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function initRepo(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root });
}

/** Captures console.log output for the duration of `fn`. */
function capture(fn: () => number): { out: string; code: number } {
  const chunks: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  });
  try {
    return { code: fn(), out: chunks.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

describe('buildLanguages', () => {
  it('lists every registered pack, derived from PACKS', () => {
    const { languages } = buildLanguages(null);
    expect(languages.map((l) => l.id)).toEqual([...LANGUAGES]);
    for (const l of languages) {
      expect(l.label).toBe(PACKS[l.id].label);
      expect(l.markers).toEqual([...PACKS[l.id].markers]);
      expect(l.beats).toEqual([...(PACKS[l.id].beats ?? [])]);
    }
  });

  it('reports no detection when there is no repo to inspect', () => {
    expect(buildLanguages(null).detected).toBeNull();
  });

  it('detects the pack matching the repo markers', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    expect(buildLanguages(dir).detected).toBe('go');
  });

  it('resolves an ambiguous repo through the beats relationship', () => {
    // A Laravel app also ships package.json for its asset pipeline; laravel outranks ts.
    writeFileSync(join(dir, 'artisan'), '#!/usr/bin/env php\n');
    writeFileSync(join(dir, 'package.json'), '{}\n');
    expect(buildLanguages(dir).detected).toBe('laravel');
  });

  it('stays null when two unrelated packs both match', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    writeFileSync(join(dir, 'package.json'), '{}\n');
    expect(buildLanguages(dir).detected).toBeNull();
  });
});

describe('renderLanguages', () => {
  it('shows every id, label, and marker', () => {
    const out = renderLanguages(buildLanguages(null), false);
    for (const id of LANGUAGES) {
      expect(out).toContain(id);
      expect(out).toContain(PACKS[id].label);
      for (const marker of PACKS[id].markers) expect(out).toContain(marker);
    }
  });

  it('names the detected pack and omits ANSI when color is off', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    const out = renderLanguages(buildLanguages(dir), false);
    expect(out).toContain('detected in this repo: go');
    expect(out).not.toContain(String.fromCharCode(27));
  });

  it('says so when nothing is detected', () => {
    expect(renderLanguages(buildLanguages(dir), false)).toContain('detected in this repo: none');
  });

  it('surfaces the outranks note for a pack that beats another', () => {
    expect(renderLanguages(buildLanguages(null), false)).toContain('(outranks: ts)');
  });
});

describe('languagesCommand', () => {
  it('exits 0 and lists packs outside a git repo', () => {
    const { out, code } = capture(() => languagesCommand(dir));
    expect(code).toBe(0);
    for (const id of LANGUAGES) expect(out).toContain(id);
  });

  it('emits the documented JSON shape under --json', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    const { out, code } = capture(() => languagesCommand(dir, { json: true }));
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as ReturnType<typeof buildLanguages>;
    expect(parsed.detected).toBe('go');
    expect(parsed.languages.map((l) => l.id)).toEqual([...LANGUAGES]);
    expect(parsed.languages[0]).toHaveProperty('label');
    expect(parsed.languages[0]).toHaveProperty('markers');
    expect(parsed.languages[0]).toHaveProperty('beats');
  });

  it('detects from the repo root, not the cwd, when run from a subdirectory', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    const sub = join(dir, 'internal', 'deep');
    execFileSync('mkdir', ['-p', sub]);
    const { out } = capture(() => languagesCommand(sub, { json: true }));
    expect((JSON.parse(out) as ReturnType<typeof buildLanguages>).detected).toBe('go');
  });
});
