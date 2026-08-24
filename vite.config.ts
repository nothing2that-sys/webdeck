import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import type { ViteUserConfig } from 'vitest/config'

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
//+_+// 반환형을 명시한다. 두 분기의 엔트리 맵이 union 으로 합쳐지면 키가 optional undefined 로 섞인다
export default defineConfig(({ mode }): ViteUserConfig => {
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
    //+_+// 확장 페이지는 chrome-extension 스킴에서 열린다. 상대 경로로 내보내 스킴 가정을 없앤다
    base: './',
    plugins: [react(), emitManifest(resolve(projectRoot, 'manifest.json'))],
    build: {
      outDir: resolve(projectRoot, 'dist'),
      emptyOutDir: true,
      rollupOptions: {
        //+_+// 엔트리 3개다. 서비스 워커가 제품 그래프에 들어가야 L10 이 닫힌다
        //+_+// 8-2.3 3번. 허브와 프로젝트 화면을 다른 파일로 가른다. path 성분에서 이미 갈린다
        input: {
          dashboard: resolve(projectRoot, 'src/dashboard/dashboard.html'),
          hub: resolve(projectRoot, 'src/dashboard/hub.html'),
          serviceWorker: resolve(projectRoot, 'src/background/serviceWorker.ts'),
        },
        //+_+// manifest 의 background.service_worker 가 고정 경로를 가리켜야 하므로 해시를 붙이지 않는다
        //+_+// harness 분기와 같은 방식이다. 이름 규칙을 두 곳에서 다르게 두지 않는다
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: '[name].js',
          assetFileNames: '[name][extname]',
        },
      },
    },
    test: {
      root: projectRoot,
      include: ['tests/**/*.test.ts'],
    },
  }
})
