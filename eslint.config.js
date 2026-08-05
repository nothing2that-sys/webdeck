import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import requireCommentPrefix from './eslint-rules/require-comment-prefix.js'

export default tseslint.config(
  //+_+// poc 와 test-pages 는 동결이다. 린트 대상에서 제외한다
  { ignores: ['dist/**', 'node_modules/**', 'poc/**', 'test-pages/**'] },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      local: { rules: { 'require-comment-prefix': requireCommentPrefix } },
    },
    rules: {
      'local/require-comment-prefix': 'error',
    },
  },
)
