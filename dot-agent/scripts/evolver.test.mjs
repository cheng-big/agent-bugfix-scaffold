import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEvolutionContext } from './lib/evolver.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('Evolver bridge injects bounded Coding guidance for root-cause', () => {
  const text = buildEvolutionContext({ phaseId: 'root-cause', action: 'phase-start', root: repoRoot });
  assert.match(text, /历史交付质量反馈/);
  assert.match(text, /CODING/);
  assert.match(text, /Stage 3/);
  assert.ok(text.length <= 12500, `injected context should remain bounded, got ${text.length}`);
});

test('Evolver bridge is optional when module is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'bugfix-evolver-absent-'));
  mkdirSync(join(root, '.agent'), { recursive: true });
  writeFileSync(join(root, '.agent', 'PROJECT.md'), '# test\n');
  assert.equal(buildEvolutionContext({ phaseId: 'root-cause', root }), '');
});
