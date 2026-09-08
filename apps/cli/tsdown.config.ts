import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships the executable bin plus the profile-host entry consumed by
 * the signed 共创 desktop application. Their shared internals may be bundled
 * independently; the public subpath is the desktop host's stable seam.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/profile-boot.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
