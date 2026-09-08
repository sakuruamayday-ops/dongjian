/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
 * separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'command.description': '选择本会话使用的模型',
  'option.loadError': '目录加载失败：{message}',
  'trigger.fallback': '选择模型',
  'trigger.loading': '正在加载模型…',
  'trigger.selectAria': '选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
  'menu.aria': '模型与推理等级',
  'menu.model': '模型',
  'menu.effort': '推理等级',
  'search.aria': '搜索模型',
  'search.placeholder': '搜索模型',
  'provider.collapse': '收起 {provider}',
  'provider.expand': '展开 {provider}',
  'effort.providerDefault': 'Default',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'error.emptyRefresh': '刷新后没有可用模型，请检查模型连接后重试。',
  'action.reload': '重新加载',
  'action.refreshModels': '刷新模型',
  'warning.groupLoad': '{name} 目录暂不可用：{message}',
  'status.removed': '当前模型已下线，请选择新的模型。',
  'empty.models': '没有可用的模型。',
  'empty.search': '没有匹配的模型。',
  'blocked.composer': '当前模型不可用，请先选择模型',
  'empty.efforts': '当前模型未提供推理等级。',
} satisfies Record<string, string>

/** The model namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'Catalog failed to load: {message}',
  'trigger.fallback': 'Select model',
  'trigger.loading': 'Loading models…',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'menu.aria': 'Model and reasoning effort',
  'menu.model': 'Model',
  'menu.effort': 'Effort',
  'search.aria': 'Search models',
  'search.placeholder': 'Search models',
  'provider.collapse': 'Collapse {provider}',
  'provider.expand': 'Expand {provider}',
  'effort.providerDefault': 'Default',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'error.emptyRefresh': 'No models are available after refresh. Check the model connection and try again.',
  'action.reload': 'Reload',
  'action.refreshModels': 'Refresh models',
  'warning.groupLoad': '{name} catalog is temporarily unavailable: {message}',
  'status.removed': 'The current model is no longer available. Select a replacement.',
  'empty.models': 'No models available.',
  'empty.search': 'No matching models.',
  'blocked.composer': 'This model is unavailable — select one to continue',
  'empty.efforts': 'This model provides no reasoning effort levels.',
} satisfies Record<ModelKey, string>
