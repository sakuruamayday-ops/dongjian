/** `deliverables` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'deliverables'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'draft.title': '待核验文案',
  'draft.warning': '以下文案尚未完成核验。请先处理检查结果中的缺口，不要作为正式材料使用。',
  'draft.copy': '复制文案',
  'draft.copied': '已复制',
  'draft.footnotes': '注脚',
  'produced.label': '已生成文件',
  'produced.formal': '已通过',
  'produced.draft': '待完善',
  'produced.running': '待检查',
  'produced.paused': '已暂停',
  'produced.waiting-user': '待补充',
  'produced.failed': '检查失败',
  'produced.diagnostics': '检查结果',
  'produced.moreOne': '+ 1 个文件',
  'produced.more': '+ {count} 个文件',
  'produced.open': '打开 {name}',
  'produced.openAction': '打开文件',
  'produced.openWith': '打开方式',
  'produced.openWithLabel': '选择打开 {name} 的应用',
  'produced.menuLabel': '{name} 的打开方式',
  'produced.defaultApp': '默认应用',
  'produced.saveCopy': '保存副本',
  'produced.loading': '正在读取可用应用…',
  'produced.actionFailed': '操作未完成，请确认文件仍存在或重试',
  'produced.file': '文件',
  'produced.chooseOther': '选择其他应用…',
  'produced.showInFinder': '在 Finder 中显示',
  'produced.showInExplorer': '在文件资源管理器中显示',
  'produced.showInFolder': '在文件夹中显示',
}

/** English dictionary (same key set). */
export const en: Record<DeliverablesKey, string> = {
  'draft.title': 'Unverified draft',
  'draft.warning': 'This draft has not passed verification. Resolve the reported issues before using it as a final deliverable.',
  'draft.copy': 'Copy draft',
  'draft.copied': 'Copied',
  'draft.footnotes': 'Footnotes',
  'produced.label': 'Produced',
  'produced.formal': 'Checked',
  'produced.draft': 'Draft',
  'produced.running': 'Unchecked',
  'produced.paused': 'Paused',
  'produced.waiting-user': 'Needs input',
  'produced.failed': 'Check failed',
  'produced.diagnostics': 'Check details',
  'produced.moreOne': '+ 1 file',
  'produced.more': '+ {count} files',
  'produced.open': 'Open {name}',
  'produced.openAction': 'Open file',
  'produced.openWith': 'Open with',
  'produced.openWithLabel': 'Choose an application for {name}',
  'produced.menuLabel': 'Open {name} with',
  'produced.defaultApp': 'Default app',
  'produced.saveCopy': 'Save a copy',
  'produced.loading': 'Loading applications…',
  'produced.actionFailed': 'Could not complete the action. Check the file and try again.',
  'produced.file': 'File',
  'produced.chooseOther': 'Choose another app…',
  'produced.showInFinder': 'Show in Finder',
  'produced.showInExplorer': 'Show in File Explorer',
  'produced.showInFolder': 'Show in folder',
}

/** Union of this namespace's dictionary keys. */
export type DeliverablesKey = keyof typeof zh
