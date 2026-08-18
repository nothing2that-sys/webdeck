import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

//+_+// Chrome 이 unpacked 확장에 주는 id 는 경로에서 결정된다. crx_file/id_util.cc 와 같은 규칙이다
//+_+// 절대 경로를 UTF-16LE 바이트로 해시하고 앞 16바이트의 니블을 a~p 로 옮긴다
//+_+// Windows 는 드라이브 문자를 대문자로 정규화한 뒤 해시한다 (unpacked_installer 의 MaybeNormalizePath)
export function normalizeExtensionPath(path) {
  const absolute = resolve(path)
  return /^[a-z]:/.test(absolute) ? absolute[0].toUpperCase() + absolute.slice(1) : absolute
}

export function extensionIdForPath(path) {
  const normalized = normalizeExtensionPath(path)
  const digest = createHash('sha256').update(Buffer.from(normalized, 'utf16le')).digest('hex')
  return digest
    .slice(0, 32)
    .split('')
    .map((nibble) => String.fromCharCode(0x61 + Number.parseInt(nibble, 16)))
    .join('')
}
