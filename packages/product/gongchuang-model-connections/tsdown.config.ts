import { defineConfig } from 'tsdown'

/** Build the browser-safe provider registry as an explicit public companion. */
export default defineConfig({
  entry: [
    'lib/types/index.js',
    'lib/types/provider-registry.js',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
