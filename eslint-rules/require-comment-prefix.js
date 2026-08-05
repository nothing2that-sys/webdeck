const REQUIRED_PREFIX = '+_+//'

//+_+// 도구 지시 주석이다. 접두사 규칙을 적용하면 ESLint 지시 자체를 쓸 수 없다
const DIRECTIVE_PREFIXES = [
  'eslint',
  'eslint-disable',
  'eslint-enable',
  'eslint-env',
  'globals',
  'global',
  'exported',
  '@ts-',
  'prettier-ignore',
  'v8 ignore',
  'c8 ignore',
  '/ <reference',
]

function isToolDirective(value) {
  const text = value.trimStart()
  return DIRECTIVE_PREFIXES.some((prefix) => text.startsWith(prefix))
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require the //+_+// comment prefix and forbid block comments (v1 section 20)',
    },
    schema: [
      {
        type: 'object',
        properties: { allowBlock: { type: 'boolean' } },
        additionalProperties: false,
      },
    ],
    messages: {
      missingPrefix: 'Comment must start with //+_+// (v1 section 20).',
      blockComment: 'Block comment is not allowed. Use a //+_+// line comment (v1 section 20).',
    },
  },
  create(context) {
    const allowBlock = context.options[0]?.allowBlock ?? false

    return {
      'Program:exit'() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === 'Shebang' || comment.type === 'Hashbang') {
            continue
          }
          if (isToolDirective(comment.value)) {
            continue
          }
          if (comment.type === 'Block') {
            if (!allowBlock) {
              context.report({ node: comment, messageId: 'blockComment' })
            }
            continue
          }
          if (!comment.value.startsWith(REQUIRED_PREFIX)) {
            context.report({ node: comment, messageId: 'missingPrefix' })
          }
        }
      },
    }
  },
}
