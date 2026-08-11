import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const projectRoot = import.meta.dirname

//+_+// vite root 가 엔트리 디렉터리이므로 manifest.json 은 복사 대상에 들어오지 않는다. dist 루트로 직접 내보낸다
function emitManifest(sourcePath: string): Plugin {
  return {
    name: 'webdeck-emit-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: readFileSync(sourcePath, 'utf8'),
      })
    },
  }
}

//+_+// 하네스 리포트의 harnessCommit 이다. 얻지 못하면 null 이고 리포트가 필드를 만들지 않는다
function harnessCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

//+_+// 하네스는 버릴 코드다. 제품 dist 를 오염시키지 않도록 산출물을 분리한다
export default defineConfig(({ mode }) => {
  if (mode === 'harness') {
    return {
      root: resolve(projectRoot, 'harness/p3'),
      publicDir: false,
      plugins: [emitManifest(resolve(projectRoot, 'harness/p3/manifest.json'))],
      define: { __HARNESS_COMMIT__: JSON.stringify(harnessCommit()) },
      build: {
        outDir: resolve(projectRoot, 'dist-harness'),
        emptyOutDir: true,
        rollupOptions: {
          input: {
            harness: resolve(projectRoot, 'harness/p3/harness.html'),
            worker: resolve(projectRoot, 'harness/p3/worker.ts'),
          },
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: '[name].js',
            assetFileNames: '[name][extname]',
          },
        },
      },
    }
  }

  return {
    root: resolve(projectRoot, 'src/dashboard'),
    publicDir: false,
    plugins: [emitManifest(resolve(projectRoot, 'manifest.json'))],
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
  }
})
