import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'lib/types/apps/desktop/src/main.js',
    'lib/types/apps/desktop/src/main-window-preload.js',
    'lib/types/apps/desktop/src/macos-update-helper.js',
    'lib/types/apps/desktop/src/macos-transition.js',
  ],
  outDir: 'dist',
  // Electron loads the sandboxed window preload through its CommonJS loader
  // even when the application package itself is ESM. Emit both faces.
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: false,
  clean: true,
  external: ['electron'],
})
