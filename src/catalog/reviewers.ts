import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { ConfigError } from '../errors.js';

export function loadReviewerPersona(sources: Array<{ dir: string }>, id: string): { id: string; body: string } {
  let body: string | null = null;
  for (const { dir } of sources) {
    const path = join(dir, 'reviewers', `${id}.md`);
    if (existsSync(path)) body = matter(readFileSync(path, 'utf8')).content.trim();
  }
  if (body === null) throw new ConfigError(`reviewer persona "${id}" not found in any config layer`);
  return { id, body };
}
