import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const script = fileURLToPath(new URL('../scripts/deploy-edge-functions.sh', import.meta.url))
function run(mode) {
  const cwd = mkdtempSync(join(tmpdir(), 'edge deploy '))
  try {
    for (const name of ['one', 'two', '_shared']) {
      const dir = join(cwd, 'supabase/functions', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'index.ts'), '')
    }
    const bin = join(cwd, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'supabase'), `#!/bin/bash
echo "$3" >> calls
count=$(wc -l < calls)
if [[ "$3" == one ]]; then
  if [[ "$SMOKE_DEPLOY_MODE" == hard ]]; then echo 'TypeError: compile failed'; exit 7; fi
  if [[ "$SMOKE_DEPLOY_MODE" == exhausted || "$count" -lt 3 ]]; then echo 'Bundle generation timed out'; exit 9; fi
fi
echo deployed
`, { mode: 0o755 })
    const result = spawnSync('bash', [script], {
      cwd, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SUPABASE_PROJECT_REF: 'test-project', SMOKE_DEPLOY_MODE: mode },
    })
    return { status: result.status, calls: readFileSync(join(cwd, 'calls'), 'utf8').trim().split('\n') }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

test('Edge deployment retries only the timed-out function and continues after success', () => {
  assert.deepEqual(run('transient'), { status: 0, calls: ['one', 'one', 'one', 'two'] })
})
test('Edge deployment immediately fails on a non-transient error', () => {
  assert.deepEqual(run('hard'), { status: 7, calls: ['one'] })
})
test('Edge deployment remains failed after three timeouts', () => {
  assert.deepEqual(run('exhausted'), { status: 9, calls: ['one', 'one', 'one'] })
})
