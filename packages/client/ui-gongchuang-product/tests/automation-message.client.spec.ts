import { describe, expect, it } from 'vitest'
import type { AutomationClaim, AutomationRunId, AutomationTaskId } from '@deepseek-ai/dsh-api-remotes/client'
import { buildAutomationDispatchMessage } from '../src/client/automation-message.ts'

describe('automation dispatch message', () => {
  it('keeps generic automations open while applying professional defaults only when relevant', () => {
    const claim: AutomationClaim = {
      runId: 'run-00000000-0000-4000-8000-000000000002' as AutomationRunId,
      runToken: 'one-time-token',
      taskId: 'automation-00000000-0000-4000-8000-000000000001' as AutomationTaskId,
      taskName: '本机定时验收',
      prompt: '只报告任务名称，不修改文件。',
      workspaceId: 'workspace-1',
      conversationSessionId: null,
      scheduledAt: '2026-08-15T12:40:00.000Z',
      manual: false,
    }

    const message = buildAutomationDispatchMessage(claim)
    expect(message).toContain('普通任务保持通用处理')
    expect(message).toContain('首次输出默认使用对应专业技能与模板')
    expect(message).toContain('后续按用户修改意见继续调整')
    expect(message).toContain('以客户端实际读取到的状态为准')
    expect(message).not.toContain('共创专业校验')
    expect(message).not.toContain('门禁')
    expect(message).toContain(claim.prompt)
  })
})
