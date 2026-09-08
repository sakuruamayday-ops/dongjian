import { Fragment } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

/** Product-owned copy for the blank-session headline slot. */
export type ProductHeroHeadlineProps =
  PropsRuntime<'conversation.hero.headline'> & PropsLocale<typeof NS>

/** Render the localized product slogan without adding layout chrome. */
export function ProductHeroHeadline({ t }: ProductHeroHeadlineProps) {
  return <Fragment>{t('hero.headline')}</Fragment>
}
