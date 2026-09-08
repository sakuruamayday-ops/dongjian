import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BRAND_MARK_DATA_URL } from './brand-data.ts'

/** Render the same product mark used by the sidebar and desktop chrome. */
export function ProductHeroBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return (
    <img
      src={BRAND_MARK_DATA_URL}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={size}
      height={size}
      className={className}
    />
  )
}

/**
 * Occupy the upstream preview seat without visible output. The product is a
 * released client, so falling back to the harness preview badge is incorrect.
 */
export function ProductHeroPreview() {
  return null
}
