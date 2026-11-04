import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'docker', 'entrypoint-drop.mjs')

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

test('缺少参数时以 2 退出并打印用法', () => {
  const result = run([])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /用法/)
})

test('uid:gid 非法时以 2 退出', () => {
  for (const spec of ['abc', '1026', '1026:', 'a:b', '-1:1026']) {
    const result = run([spec, process.execPath, '-e', '0'])
    assert.equal(result.status, 2, `spec=${spec} 应被拒绝`)
    assert.match(result.stderr, /无效的 uid:gid/)
  }
})

test('命令不存在时以 127 退出', () => {
  const result = run(['1000:1000', path.join(here, 'no-such-binary')])
  assert.equal(result.status, 127)
  assert.match(result.stderr, /无法启动/)
})

test('原样透传子进程退出码', () => {
  const result = run(['1000:1000', process.execPath, '-e', 'process.exit(3)'])
  assert.equal(result.status, 3)
})

test('原样透传命令行参数（含空格）', () => {
  const result = run([
    '1000:1000',
    process.execPath,
    '-e',
    'console.log(JSON.stringify(process.argv.slice(1)))',
    '--',
    '带 空格 的参数',
  ])
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['带 空格 的参数'])
})
