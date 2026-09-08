/**
 * `slash.menu` namespace dictionaries: group titles keyed by source name
 * (the lookup chain returns the key itself, so an unknown source shows its
 * raw name), the pending row, and the listbox and header aria labels.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'command': '指令',
  'skill': '技能',
  'subagent': '子智能体',
  'loading': '正在加载…',
  'drill.aria': '进入目录',
  'drill.hint': '进入目录',
  'drill.key': 'Tab',
  'crumbs.aria': '目录导航',
  'suggestions.aria': '触发候选建议',
  'command.export.name': '导出',
  'command.export.description': '将本会话日志导出为 ZIP 压缩包',
  'command.feedback.name': '反馈',
  'command.feedback.description': '记录对本会话的反馈',
  'command.goal.name': '目标',
  'command.goal.description': '设置或查看长期任务的目标',
  'command.permission.name': '权限',
  'command.permission.description': '切换权限预设，包括沙箱模式和审批策略',
  'command.model.name': '模型',
  'command.model.description': '选择本会话使用的模型',
} satisfies Record<string, string>

/** The slash.menu namespace key union. */
export type MenuKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'command': 'Commands',
  'skill': 'Skills',
  'subagent': 'Subagents',
  'loading': 'Loading…',
  'drill.aria': 'Browse folder',
  'drill.hint': 'Browse folder',
  'drill.key': 'Tab',
  'crumbs.aria': 'Folder navigation',
  'suggestions.aria': 'Trigger suggestions',
  'command.export.name': 'export',
  'command.export.description': 'Download this Session log as a ZIP archive',
  'command.feedback.name': 'feedback',
  'command.feedback.description': 'record feedback about this session',
  'command.goal.name': 'goal',
  'command.goal.description': 'set or view the goal for a long-running task',
  'command.permission.name': 'permission',
  'command.permission.description': 'Switch the permission preset (sandbox mode + approval policy)',
  'command.model.name': 'model',
  'command.model.description': 'Choose the model for this session',
} satisfies Record<MenuKey, string>
