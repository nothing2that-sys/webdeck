import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const projectRoot = import.meta.dirname

//+_+// vite root 가 src/dashboard 이므로 manifest.json 은 복사 대상에 들어오지 않는다. dist 루트로 직접 내보낸다
function emitManifest(): Plugin {
  return {
    name: 'webdeck-emit-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: readFileSync(resolve(projectRoot, 'manifest.json'), 'utf8'),
      })
    },
  }
}

export default defineConfig({
  root: resolve(projectRoot, 'src/dashboard'),
  publicDir: false,
  plugins: [emitManifest()],
  build: {
    outDir: resolve(projectRoot, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(projectRoot, 'src/dashboard/dashboard.html'),
    },
  },
  test: {
    root: projectRoot,
    include: ['tests/**/*.test.ts'],
  },
})
