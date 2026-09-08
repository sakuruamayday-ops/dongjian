/* Apply the host-validated theme before the application shell mounts. */
const script = document.currentScript
const source = script instanceof HTMLScriptElement ? new URL(script.src, location.href) : undefined
const preference = source?.searchParams.get('preference') ?? 'system'
const requestedFontSize = Number(source?.searchParams.get('fontSize'))
const fontSize = Number.isInteger(requestedFontSize)
  && requestedFontSize >= 12
  && requestedFontSize <= 17
  ? requestedFontSize
  : 14
const systemDark = preference === 'system'
  && typeof matchMedia !== 'undefined'
  && matchMedia('(prefers-color-scheme: dark)').matches
const dark = preference === 'dark' || systemDark
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
document.body.toggleAttribute('data-ds-dark-theme', dark)
document.body.style.setProperty('--dsh-content-font-size', String(fontSize) + 'px')
