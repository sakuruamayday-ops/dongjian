import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareSemanticVersions,
  legacyPermissionFactsAreCompatible,
  mapPackagedExecutableInventory,
  packagedUpdateProcessTargets,
  sessionEventAffectsRetainedState,
} from '../scripts/packaged-macos-update-acceptance.ts'

const desktopRoot = resolve(import.meta.dirname, '..')
const main = readFileSync(joinDesktop('src/main.ts'), 'utf8')
const packagedUpdateAcceptance = readFileSync(joinDesktop('scripts/packaged-macos-update-acceptance.ts'), 'utf8')
const packagedUpdateAcceptanceGuide = readFileSync(
  joinDesktop('scripts/PACKAGED-MACOS-UPDATE-ACCEPTANCE-zh.md'),
  'utf8',
)
const credentialBackend = readFileSync(
  resolve(desktopRoot, '../../packages/credentials/gongchuang-keychain/src/backend.ts'),
  'utf8',
)
const packageManifest = JSON.parse(readFileSync(joinDesktop('package.json'), 'utf8')) as {
  readonly build: {
    readonly appId: string
    readonly productName: string
    readonly nsis: { readonly deleteAppDataOnUninstall: boolean }
  }
  readonly scripts: Record<string, string>
}

function joinDesktop(path: string): string {
  return resolve(desktopRoot, path)
}

describe('desktop update persistence identity', () => {
  it('orders exact release versions for legacy update cleanup behavior', () => {
    expect(compareSemanticVersions('0.3.3', '0.4.0')).toBe(-1)
    expect(compareSemanticVersions('0.4.0', '0.4.0')).toBe(0)
    expect(compareSemanticVersions('0.4.1', '0.4.0')).toBe(1)
  })

  it('ignores only the repeatable session end seed when comparing retained conversation state', () => {
    expect(sessionEventAffectsRetainedState('session/end-seed')).toBe(false)
    expect(sessionEventAffectsRetainedState('user/message')).toBe(true)
    expect(sessionEventAffectsRetainedState('assistant/message')).toBe(true)
    expect(sessionEventAffectsRetainedState('session/title')).toBe(true)
    expect(sessionEventAffectsRetainedState('permission/preset')).toBe(true)
  })

  it('accepts only the exact one-time DSH permission materialization for a legacy session', () => {
    const base = {
      meta: { version: 0, id: 'legacy' },
      events: [{ type: 'user/message', seq: 1, data: { content: 'retained' } }],
    }
    const exactMigration = {
      ...base,
      events: [
        ...base.events,
        { type: 'permission/preset', seq: 2, data: { preset: 'workspace-write' } },
        { type: 'sandbox/mode', seq: 3, data: { mode: 'workspace-write' } },
        { type: 'approval/policy', seq: 4, data: { policy: 'ask' } },
      ],
    }
    expect(legacyPermissionFactsAreCompatible(JSON.stringify(base), JSON.stringify(exactMigration))).toBe(true)
    expect(legacyPermissionFactsAreCompatible(JSON.stringify(base), JSON.stringify({
      ...exactMigration,
      events: [...base.events, ...exactMigration.events.slice(-3, -1), {
        type: 'approval/policy', seq: 4, data: { policy: 'never' },
      }],
    }))).toBe(false)
    expect(legacyPermissionFactsAreCompatible(JSON.stringify({
      ...base,
      events: [...base.events, { type: 'sandbox/mode', seq: 2, data: { mode: 'read-only' } }],
    }), JSON.stringify(exactMigration))).toBe(false)
  })

  it('keeps one product identity, user-data root, and persistent browser partition across releases', () => {
    expect(packageManifest.build).toMatchObject({
      appId: 'cn.dongjian.desktop',
      productName: '洞见',
      nsis: { deleteAppDataOnUninstall: false },
    })
    expect(main).toContain('app.setName(PRODUCT_NAME)')
    expect(main).toContain('app.setPath(\'userData\', join(app.getPath(\'appData\'), PRODUCT_NAME))')
    expect(main).toContain('session.fromPartition(\'persist:dongjian-v0.1\')')
  })

  it('stores updates below userData while credentials, workspaces, sessions, and partitions remain siblings', () => {
    expect(main).toContain('updateRoot: join(app.getPath(\'userData\'), \'desktop-updates\')')
    expect(main).toContain('process.env.DSH_HOME = join(app.getPath(\'userData\'), \'runtime\')')
    expect(main).toContain('settingsFile: join(app.getPath(\'userData\'), \'enterprise-workspace-root.json\')')
    expect(credentialBackend).toContain("const ENCRYPTED_STORE_FILENAME = 'credentials.secure.v1.json'")
    expect(credentialBackend).toContain("$target = 'cn.dongjian.desktop:' + [string]$request.ref")
    expect(main).not.toContain('app.setPath(\'userData\', join(app.getPath(\'appData\'), `洞见 V')
  })

  it(
    'ships a syntax-valid packaged cross-version acceptance command',
    () => {
      const script = joinDesktop('scripts/packaged-macos-update-acceptance.ts')
      const help = execFileSync('pnpm', ['exec', 'tsx', script, '--help'], {
        cwd: resolve(desktopRoot, '../..'),
        encoding: 'utf8',
      })
      expect(packageManifest.scripts['acceptance:mac-update']).toContain('packaged-macos-update-acceptance.ts')
      expect(help).toContain('--source-archive <old.zip>')
      expect(help).toContain('--target-archive <new.zip>')
      expect(help).toContain('--manifest <desktop-release-index.json>')
      expect(help).toContain('--target-keychain-access required')
      expect(help).toContain('--receipt <new.json>')
      // pnpm 10 会把 `run <script> -- --flag` 中的裸 `--` 继续传给脚本，示例必须省略该分隔符。
      expect(packagedUpdateAcceptanceGuide).toContain('run acceptance:mac-update \\\n')
      expect(packagedUpdateAcceptanceGuide).not.toContain('run acceptance:mac-update -- \\\n')
      expect(packagedUpdateAcceptance).toContain('safeStorage.encryptStringAsync')
      expect(packagedUpdateAcceptance).toContain('safeStorage.decryptStringAsync')
      expect(packagedUpdateAcceptance).toContain('GONGCHUANG_ACCOUNT_AUTO_LOGIN_BLOCKED')
      expect(packagedUpdateAcceptance).not.toContain('GONGCHUANG_ACCOUNT_TOKEN')
      expect(packagedUpdateAcceptance).toContain('GONGCHUANG_CUSTOM_API_ACCEPTANCE')
      expect(packagedUpdateAcceptance).toContain(
        'client could not decrypt the retained credential refs',
      )
      expect(packagedUpdateAcceptance).toContain("'credentials', 'enterpriseSpaces', 'sessions', 'archiveDeletePin', 'attachments'")
      expect(packagedUpdateAcceptance).toContain("'modelConnections', 'skills', 'memory', 'automations'")
      expect(packagedUpdateAcceptance).toContain("record('source-persisted-user-state-loaded'")
      expect(packagedUpdateAcceptance).toContain("record('retained-user-state'")
      expect(packagedUpdateAcceptance).toContain("record('packaged-failure-restores-source-and-user-state'")
      expect(packagedUpdateAcceptance).toContain('failedTargetCleanupDeferredUntilSuccessfulRetry')
      expect(packagedUpdateAcceptance).toContain('V0.4.0 成功启动时会消费该 schema 1 残留')
      expect(packagedUpdateAcceptance).toContain('restored active session title left the compatible title set')
      expect(packagedUpdateAcceptance).toContain('restored archived session title left the compatible title set')
      expect(packagedUpdateAcceptance).toContain('restoredPersistedSessionTitles: restoredSessionTitles')
      expect(packagedUpdateAcceptance).toContain("return type !== 'session/end-seed'")
      expect(packagedUpdateAcceptance).toContain('旧客户端每次重新打开会话都会追加 end-seed')
      expect(packagedUpdateAcceptance).toContain('sessions changed during update: ${JSON.stringify(incompatible)}')
      expect(packagedUpdateAcceptance).toContain('legacyPermissionFactsAreCompatible')
      expect(packagedUpdateAcceptance).toContain('archiveDeletePin changed during update:')
      expect(packagedUpdateAcceptance).toContain('必须在推进到下一帧前复制当前明文')
      expect(packagedUpdateAcceptance).toContain('decodedFrames.push(Buffer.from(frame))')
      expect(packagedUpdateAcceptance).toContain('SIGKILL exact helper-launched target PID before startup commit')
      expect(packagedUpdateAcceptance).toContain('schemaVersion: 5')
      expect(packagedUpdateAcceptance).toContain('deviceBoundTokenVerified: false')
      expect(packagedUpdateAcceptance).toContain('signedInSessionRetained: false')
      expect(packagedUpdateAcceptance).toContain("record('target-saved-account-credentials-migrated'")
      expect(packagedUpdateAcceptance).toContain("join(userDataRoot, 'credentials.keychain.v2.json')")
      expect(packagedUpdateAcceptance).toContain('assertBrokerCredentials(currentApp, brokerState, credentialValues)')
      expect(packagedUpdateAcceptance).not.toContain('deferred-system-authorization')
      expect(packagedUpdateAcceptance).not.toContain('target-keychain-authorization-deferred')
      expect(packagedUpdateAcceptance).toContain('credentialStoreBytesRetained: true')
      expect(packagedUpdateAcceptance).toContain('savedCredentialRefsReadByFrozenBroker: true')
      expect(packagedUpdateAcceptance).toContain('savedPasswordAvailableWithoutRetyping: true')
      expect(packagedUpdateAcceptance).toContain('systemKeychainAuthorizationDeferred: false')
      expect(packagedUpdateAcceptance).toContain('targetParsedCredentialBackedState: true')
      expect(packagedUpdateAcceptance).toContain("'  regionConfirmed: true'")
      expect(packagedUpdateAcceptance).toContain('已经完成首次设置的在用客户端')
      expect(packagedUpdateAcceptance).not.toContain('assertPackagedUserState(sourceWindow, fixture, true)')
      expect(packagedUpdateAcceptance).not.toContain(
        'assertPackagedUserState(rollbackSourceWindow, rollbackFixture, true)',
      )
      expect(packagedUpdateAcceptance).toContain('assertPackagedUpdateSourceState(sourceWindow, fixture)')
      expect(packagedUpdateAcceptance).toContain('模型插件损坏才需要更新')
      expect(packagedUpdateAcceptance).toContain(
        "sourceUiBoundary: 'configured update surface only; model management and session creation are target checks'",
      )
      expect(packagedUpdateAcceptance).toContain('产品窗口使用命名持久分区')
      expect(packagedUpdateAcceptance).not.toContain('page.context().cookies')
      expect(packagedUpdateAcceptance).toContain("rpcId: 'update-acceptance'")
      expect(packagedUpdateAcceptance).toContain("source: { kind: 'fallback' }")
      expect(packagedUpdateAcceptance).toContain('persisted session title changed across update')
      expect(packagedUpdateAcceptance).toContain('expectedSessionTitles?: VisibleSessionTitles')
      expect(packagedUpdateAcceptance).toContain('archived session title changed across update')
      expect(packagedUpdateAcceptance).toContain("activeSessionTitle: '更新保留会话'")
      expect(packagedUpdateAcceptance).toContain("reusableBlankSessionId = 'update-acceptance-reusable-blank-session'")
      expect(packagedUpdateAcceptance).toContain('跨版验收必须预置并跟踪它')
      expect(packagedUpdateAcceptance).toContain("archivedSessionTitle: '已归档验收会话'")
      expect(packagedUpdateAcceptance).toContain('active: fixture.expected.activeSessionTitle')
      expect(packagedUpdateAcceptance).toContain('archived: fixture.expected.archivedSessionTitle')
      expect(packagedUpdateAcceptance).toContain("expectedModelDialogName = '连接自定义 API'")
      expect(packagedUpdateAcceptance).toContain(
        "}, '连接 本地 / 自定义端点')",
      )
      expect(packagedUpdateAcceptance).toContain('身份复核和发信号之间的退出不应伪造失败')
      expect(packagedUpdateAcceptance).toContain('signalled || !running(launchedPid)')
      expect(packagedUpdateAcceptance).toContain("['-ww', '-ax', '-o', 'pid=,command=']")
      expect(packagedUpdateAcceptance).toContain('截断会让仍存活的受控进程看似“身份不符”')
      expect(packagedUpdateAcceptance).not.toContain("getByText('已归档验收会话'")
      expect(packagedUpdateAcceptance).not.toContain("name: '更新保留会话', exact: true")
      expect(packagedUpdateAcceptance).toContain('terminatePackagedDrillProcesses')
      expect(packagedUpdateAcceptance).toContain('signalPackagedProcessIfOwned')
      expect(packagedUpdateAcceptance).toContain('packagedApplicationExecutablesForSlot(')
      expect(packagedUpdateAcceptance).toContain('currentApp, [sourceApp, targetApp],')
      expect(packagedUpdateAcceptance).not.toContain('process.kill(launchedPid as number')
      expect(packagedUpdateAcceptance).toContain("execFileSync('/usr/bin/trash', [drillRoot])")
      expect(packagedUpdateAcceptance).toContain('realpathSync(enterpriseRoot)')
      expect(packagedUpdateAcceptance).toContain('installedSkillFile')
      expect(packagedUpdateAcceptance).toContain('JSON.stringify([`dsh:${activeSessionId}`])')
    },
    20_000,
  )

  it('selects only exact drill executables and helpers carrying a discovered job path', () => {
    const firstExecutable = '/private/tmp/drill/Applications/洞见.app/Contents/MacOS/洞见'
    const secondExecutable = '/private/tmp/drill/rollback-Applications/洞见.app/Contents/MacOS/洞见'
    const firstRoot = '/private/tmp/drill/Applications/洞见.app'
    const secondRoot = '/private/tmp/drill/rollback-Applications/洞见.app'
    const renderer = `${firstRoot}/Contents/Frameworks/洞见 Helper (Renderer).app/Contents/MacOS/洞见 Helper (Renderer)`
    const gpu = `${secondRoot}/Contents/Frameworks/洞见 Helper (GPU).app/Contents/MacOS/洞见 Helper (GPU)`
    const python = `${firstRoot}/Contents/Resources/product/runtime/files/python/bin/python3`
    const targetInventory = '/private/tmp/drill/target/洞见.app'
    const targetOnlyInventoryExecutable = `${targetInventory}/Contents/Resources/product/runtime/files/bin/new-target-helper`
    const mappedTargetExecutables = mapPackagedExecutableInventory(
      targetInventory, firstRoot, [targetOnlyInventoryExecutable],
    )
    const targetOnlyExecutable = mappedTargetExecutables[0]
    expect(mappedTargetExecutables).toEqual([
      `${firstRoot}/Contents/Resources/product/runtime/files/bin/new-target-helper`,
    ])
    const job = '/private/tmp/drill/acceptance-root/Library/Application Support/洞见/desktop-updates/transactions/job.json'
    const otherJob = '/private/tmp/other/transactions/job.json'
    const output = [
      `  101 ${firstExecutable}`,
      `  102 ${firstExecutable} /inside/app.asar/dist/macos-update-helper.js ${job}`,
      `  103 ${renderer} --type=renderer`,
      `  104 ${firstExecutable}-copy /inside/app.asar/dist/macos-update-helper.js ${job}`,
      `  105 ${firstExecutable} /inside/app.asar/dist/macos-update-helper.js ${otherJob}`,
      `  106 /usr/bin/node /inside/app.asar/dist/macos-update-helper.js ${job}`,
      `  107 ${gpu} --type=gpu-process`,
      `  108 ${python} -m gongchuang_mcp`,
      '  109 /private/tmp/other/洞见.app/Contents/MacOS/洞见',
      `  110 ${targetOnlyExecutable} --serve`,
    ].join('\n')

    expect(packagedUpdateProcessTargets(
      output,
      [firstExecutable, secondExecutable, renderer, gpu, python, targetOnlyExecutable],
      [job],
      [firstRoot, secondRoot],
    )).toEqual({
      applicationPids: [101, 102, 103, 105, 107, 108, 110],
      helperPids: [102],
      allPids: [101, 102, 103, 105, 107, 108, 110],
    })
  })

  it('treats macOS /var and /private/var spellings as the same exact temporary process identity', () => {
    const aliasRoot = '/var/folders/test/T/drill/Applications/洞见.app'
    const canonicalRoot = `/private${aliasRoot}`
    const aliasExecutable = `${aliasRoot}/Contents/MacOS/洞见`
    const canonicalExecutable = `${canonicalRoot}/Contents/MacOS/洞见`
    const aliasJob = '/var/folders/test/T/drill/transactions/job.json'
    const canonicalJob = `/private${aliasJob}`
    const output = [
      `  201 ${canonicalExecutable}`,
      `  202 ${canonicalExecutable} /inside/app.asar/dist/macos-update-helper.js ${canonicalJob}`,
      '  203 /private/var/folders/test/T/other/Applications/洞见.app/Contents/MacOS/洞见',
    ].join('\n')

    expect(packagedUpdateProcessTargets(output, [aliasExecutable], [aliasJob], [aliasRoot])).toEqual({
      applicationPids: [201, 202],
      helperPids: [202],
      allPids: [201, 202],
    })
  })
})
