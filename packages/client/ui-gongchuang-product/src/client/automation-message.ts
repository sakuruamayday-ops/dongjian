import type { AutomationClaim } from '@deepseek-ai/dsh-api-remotes/client'

/** Build the ordinary user message used by a locally scheduled automation run.
 * @param claim - The claim value.
 * @returns The build automation dispatch message result.
 */
export function buildAutomationDispatchMessage(claim: AutomationClaim): string {
  return `【本机自动化任务】${claim.taskName}\n计划时间：${claim.scheduledAt}\n`
    + '请按任务内容使用合适的已安装技能和工具执行。普通任务保持通用处理；属于项目申报等专业业务时，首次输出默认使用对应专业技能与模板，后续按用户修改意见继续调整。\n'
    + '涉及本机安装数量、技能来源或连接状态时，以客户端实际读取到的状态为准；无法读取时明确说明。\n'
    + claim.prompt
}
