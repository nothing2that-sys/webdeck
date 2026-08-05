import type { TileMatchMode } from './types'

//+_+// 파싱 실패는 어떤 모드에서도 매치되지 않는다. 예외를 위로 던지지 않는다
function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

//+_+// 경로 끝 슬래시 유무를 동일 취급한다. 루트 "/" 는 줄이지 않는다
function stripTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1)
  }
  return pathname
}

//+_+// 세그먼트 경계에서만 매치한다. 이 제한이 없으면 /foo 가 /foobar 를 잡는다
function isPathUnder(basePath: string, targetPath: string): boolean {
  if (basePath === '/') {
    return true
  }
  return targetPath === basePath || targetPath.startsWith(`${basePath}/`)
}

//+_+// scheme, host, 기본 포트 정규화와 경로 대소문자 보존은 URL 생성자가 처리한다
//+_+// fragment 는 hash 를 비교에 넣지 않는 것으로 무시한다
export function urlMatches(baseUrl: string, targetUrl: string, mode: TileMatchMode): boolean {
  const base = parseUrl(baseUrl)
  const target = parseUrl(targetUrl)
  if (base === null || target === null) {
    return false
  }
  if (base.origin !== target.origin) {
    return false
  }

  const basePath = stripTrailingSlash(base.pathname)
  const targetPath = stripTrailingSlash(target.pathname)

  switch (mode) {
    case 'exact':
      return basePath === targetPath && base.search === target.search
    case 'origin':
      return true
    case 'prefix':
      return isPathUnder(basePath, targetPath)
  }
}
