// Local, unsigned approval material for the current independent product candidate.
import { createHash, verify } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join, relative, dirname } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const source = resolve(process.argv[2])
const output = resolve(process.argv[3])
const candidate = join(root, 'product/dongjian/skill-source')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const indexBytes = readFileSync(join(source, 'skill-bundle-index.json'))
const index = JSON.parse(indexBytes)
const pub = readFileSync(join(source, 'skill-bundle-index.pub.pem'))
if (hash(pub) !== '1fd8ab82ab5d6cd413f611cf7923df79e6e4eaaaab016d5c9df88927f75fddd2'
  || !verify(null, indexBytes, pub, Buffer.from(readFileSync(join(source, 'skill-bundle-index.sig'), 'utf8').trim(), 'base64'))
  || index.skillBundleVersion !== '1.6.19') throw new Error('Upstream snapshot identity is not verified')
for (const [name, expected] of Object.entries(index.files)) {
  if (hash(readFileSync(join(source, 'skills', name))) !== expected) throw new Error(`Upstream drift: ${name}`)
}
if (existsSync(output)) throw new Error('Use a new approval directory for each candidate')
mkdirSync(output, { recursive: true })
const snapshot = join(output, 'upstream-snapshot.tar.gz')
execFileSync('tar', ['-czf', snapshot, '-C', source, '.'])
const walk = (directory, base = directory) => readdirSync(directory).flatMap(name => {
  if (name === '__pycache__' || name.endsWith('.pyc') || name === '.DS_Store') return []
  const path = join(directory, name), info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error(`Unexpected candidate symlink: ${path}`)
  return info.isDirectory() ? walk(path, base) : [relative(base, path)]
})
const targets = [], patch = []
for (const name of [...new Set([...Object.keys(index.files), ...walk(candidate)])].sort()) {
  const oldPath = join(source, 'skills', name), newPath = join(candidate, name)
  const before = existsSync(oldPath) ? hash(readFileSync(oldPath)) : null
  const after = existsSync(newPath) ? hash(readFileSync(newPath)) : null
  targets.push({ path: name, beforeSha256: before, afterSha256: after, impact: before === after ? '不受影响' : '需要修改' })
  if (before === after) continue
  const diff = spawnSync('git', ['diff', '--no-index', '--binary', oldPath && before ? oldPath : '/dev/null', newPath && after ? newPath : '/dev/null'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (diff.status !== 1) throw new Error(`Could not create candidate diff: ${name}`)
  patch.push(diff.stdout)
}
writeFileSync(join(output, 'skill-diff.patch'), patch.join('\n'))
writeFileSync(join(output, 'target-files.json'), JSON.stringify(targets, null, 2) + '\n')
writeFileSync(join(output, 'client-diff.patch'), execFileSync('git', ['diff', '--binary', '--', 'apps', 'packages', 'product/gongchuang-client'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }))
const logs = [
  ['candidate-tests.log', '/private/tmp/dongjian-final-candidate-tests.log', /Tests\s+\d+ passed \(\d+\)/],
  ['python-tests.log', '/private/tmp/dongjian-python-regression.log', /56 passed/],
  ['gui-tests.log', '/private/tmp/dongjian-gui-tests-final.log', /4433 passed/],
]
const tests = []
for (const [name, path, passed] of logs) {
  const value = readFileSync(path, 'utf8')
  if (!passed.test(value) || /^ FAIL /m.test(value) || /\d+ failed/.test(value)) throw new Error(`Test evidence not passing: ${path}`)
  writeFileSync(join(output, name), value)
  tests.push({ name, status: 'pass', sha256: hash(value) })
}
writeFileSync(join(output, 'test-report.json'), JSON.stringify({ tests, exclusions: ['签名制品和安装后的真实启动验收尚未执行'] }, null, 2) + '\n')
const impacts = index.skills.map(skill => ({ skill, impact: targets.some(t => t.path.startsWith(skill + '/') && t.impact === '需要修改') ? '需要修改' : '仅需回归' }))
writeFileSync(join(output, 'impact-report.json'), JSON.stringify({
  scope: '洞见独立内置技能候选，不修改原版正式安装或主线',
  protectedChanges: ['移除默认出版者标识及水印，保留正文、结构、来源和文件完整性检查', '独立产品身份与签名锚，保留签名强制验证'],
  skills: impacts, files: 'target-files.json',
  sharedRuntime: { path: '_runtime/gongchuang-branding', impact: '需要修改', tests: 'python-tests.log' },
}, null, 2) + '\n')
const file = name => ({ path: name, sha256: hash(readFileSync(join(output, name))) })
const batch = {
  batch_id: 'dongjian-0.1.0-' + new Date().toISOString().replaceAll(/[:.]/g, '-'),
  state: 'tested', risk_level: 'protected',
  snapshot: file('upstream-snapshot.tar.gz'), impact_report: file('impact-report.json'),
  diff: file('skill-diff.patch'), test_report: file('test-report.json'),
  target_files: file('target-files.json'), client_diff: file('client-diff.patch'), tests,
  approval: null,
}
writeFileSync(join(output, 'evolution-batch.json'), JSON.stringify(batch, null, 2) + '\n')
console.log(JSON.stringify({ path: join(output, 'evolution-batch.json'), state: batch.state, diffSha256: batch.diff.sha256, changedFiles: targets.filter(t => t.impact === '需要修改').length, approval: 'pending' }, null, 2))
