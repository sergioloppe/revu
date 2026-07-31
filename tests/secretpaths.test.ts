import { describe, it, expect } from 'vitest';
import { isSecretPath, partitionWithheldPaths } from '../src/secretpaths.js';

describe('isSecretPath', () => {
  it.each([
    '.env', '.env.prestage', '.env.local', '.env.production', 'config/.env',
    'certs/server.pem', 'tls/server.key', 'ssh/id_rsa', 'ssh/id_ed25519',
    'deploy/secrets.yaml', 'deploy/secrets.json', '.npmrc', '.netrc',
    'aws/credentials', 'clusters/prod.kubeconfig',
  ])('withholds %s', (p) => expect(isSecretPath(p)).toBe(true));

  it.each(['.env.example', '.env.sample', '.env.template', '.env.dist', 'config/.env.example'])(
    'allows the template %s — it carries names, not values', (p) => expect(isSecretPath(p)).toBe(false));

  // Dockerfiles and compose files are code: reviewing them is how SEC-003-style rules
  // catch a secret being baked into an image. Withholding them would delete that check.
  it.each([
    'Dockerfile', 'Dockerfile_multistaged', 'docker-compose.yml', '.github/workflows/ci.yml',
    'internal/config/config.go', 'internal/api/server.go', 'docs/env.md', 'Makefile',
  ])('reviews %s normally', (p) => expect(isSecretPath(p)).toBe(false));

  it('partitions a changed-file list', () => {
    const { kept, excluded } = partitionWithheldPaths([
      'internal/api/server.go', '.env.prestage', '.env.example', 'Dockerfile', 'tls/server.key',
    ]);
    expect(kept).toEqual(['internal/api/server.go', '.env.example', 'Dockerfile']);
    expect(excluded).toEqual(['.env.prestage', 'tls/server.key']);
  });
});
