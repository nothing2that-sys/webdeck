import { describe, expect, it } from 'vitest'
import { urlMatches } from '../src/shared/urlMatcher'

describe('v1 25.1 item 6 - url exact match', () => {
  it('matches an identical url', () => {
    expect(urlMatches('https://a.com/foo', 'https://a.com/foo', 'exact')).toBe(true)
  })

  it('matches when only the trailing path slash differs', () => {
    expect(urlMatches('https://a.com/foo', 'https://a.com/foo/', 'exact')).toBe(true)
  })

  it('matches when only the fragment differs', () => {
    expect(urlMatches('https://a.com/foo#a', 'https://a.com/foo#b', 'exact')).toBe(true)
  })

  it('does not match when the query differs', () => {
    expect(urlMatches('https://a.com/foo?a=1', 'https://a.com/foo?a=2', 'exact')).toBe(false)
  })

  it('does not match when the path case differs', () => {
    expect(urlMatches('https://a.com/Foo', 'https://a.com/foo', 'exact')).toBe(false)
  })

  it('matches when only the host case differs', () => {
    expect(urlMatches('https://A.com/foo', 'https://a.com/foo', 'exact')).toBe(true)
  })

  it('matches an explicit default port against an omitted one', () => {
    expect(urlMatches('https://a.com:443/foo', 'https://a.com/foo', 'exact')).toBe(true)
  })

  it('does not match when the scheme differs', () => {
    expect(urlMatches('http://a.com/foo', 'https://a.com/foo', 'exact')).toBe(false)
  })

  it('does not match an unparsable string', () => {
    expect(urlMatches('/foo', 'https://a.com/foo', 'exact')).toBe(false)
    expect(urlMatches('https://a.com/foo', 'not a url', 'exact')).toBe(false)
    expect(urlMatches('a.com/foo', 'a.com/foo', 'exact')).toBe(false)
  })
})

describe('v1 25.1 item 7 - url origin match', () => {
  it('matches the same origin with a different path', () => {
    expect(urlMatches('https://a.com/foo', 'https://a.com/bar/baz', 'origin')).toBe(true)
  })

  it('matches the same origin with a different query', () => {
    expect(urlMatches('https://a.com/foo?a=1', 'https://a.com/foo?a=2', 'origin')).toBe(true)
  })

  it('does not match across a subdomain difference', () => {
    expect(urlMatches('https://a.example.com/', 'https://example.com/', 'origin')).toBe(false)
  })

  it('does not match a non default port against the default port', () => {
    expect(urlMatches('https://a.com:8080/', 'https://a.com/', 'origin')).toBe(false)
  })

  it('matches an explicit default port against an omitted one', () => {
    expect(urlMatches('https://a.com:443/', 'https://a.com/', 'origin')).toBe(true)
  })

  it('does not match when the scheme differs', () => {
    expect(urlMatches('http://a.com/', 'https://a.com/', 'origin')).toBe(false)
  })

  it('does not match an unparsable string', () => {
    expect(urlMatches('/foo', 'https://a.com/foo', 'origin')).toBe(false)
    expect(urlMatches('https://a.com/foo', 'not a url', 'origin')).toBe(false)
    expect(urlMatches('a.com/foo', 'a.com/foo', 'origin')).toBe(false)
  })
})

describe('v1 25.1 item 8 - url prefix match', () => {
  it('matches the base path itself', () => {
    expect(urlMatches('https://a.com/foo', 'https://a.com/foo', 'prefix')).toBe(true)
  })

  it('matches the base path with a trailing slash', () => {
    expect(urlMatches('https://a.com/foo', 'https://a.com/foo/', 'prefix')).toBe(true)
  })

  it('matches a deeper path under the base path', () => {
    expect(urlMatches('https://a.com/foo', 'https://a.com/foo/bar', 'prefix')).toBe(true)
  })

  it('does not match a path that only shares a string prefix', () => {
    expect(urlMatches('https://a.com/foo', 'https://a.com/foobar', 'prefix')).toBe(false)
  })

  it('matches any path when the base path is root', () => {
    expect(urlMatches('https://a.com/', 'https://a.com/any/path', 'prefix')).toBe(true)
  })

  it('does not match a different origin even when the path fits', () => {
    expect(urlMatches('https://a.com/foo', 'https://b.com/foo/bar', 'prefix')).toBe(false)
  })

  it('ignores a query on the base url', () => {
    expect(urlMatches('https://a.com/foo?a=1', 'https://a.com/foo/bar', 'prefix')).toBe(true)
  })

  it('does not match an unparsable string', () => {
    expect(urlMatches('/foo', 'https://a.com/foo', 'prefix')).toBe(false)
    expect(urlMatches('https://a.com/foo', 'not a url', 'prefix')).toBe(false)
    expect(urlMatches('a.com/foo', 'a.com/foo', 'prefix')).toBe(false)
  })
})

//+_+// P5-D7. L11 을 정규화하지 않는다. 현재 동작을 시험으로 고정하고 회피 수단은 matchMode 다
describe('L11 - exact tells query parameter order apart', () => {
  it('does not match when only the query order differs', () => {
    expect(urlMatches('https://a.com/p?a=1&b=2', 'https://a.com/p?b=2&a=1', 'exact')).toBe(false)
  })

  it('matches when the query is written in the same order', () => {
    expect(urlMatches('https://a.com/p?a=1&b=2', 'https://a.com/p?a=1&b=2', 'exact')).toBe(true)
  })

  //+_+// 회피 수단이다. 두 모드는 search 를 비교에 넣지 않는다
  it('lets origin ignore the query order', () => {
    expect(urlMatches('https://a.com/p?a=1&b=2', 'https://a.com/p?b=2&a=1', 'origin')).toBe(true)
  })

  it('lets prefix ignore the query order', () => {
    expect(urlMatches('https://a.com/p?a=1&b=2', 'https://a.com/p?b=2&a=1', 'prefix')).toBe(true)
  })

  it('keeps exact sensitive to an added parameter', () => {
    expect(urlMatches('https://a.com/p?a=1', 'https://a.com/p?a=1&b=2', 'exact')).toBe(false)
  })

  it('keeps exact matching an empty query on both sides', () => {
    expect(urlMatches('https://a.com/p', 'https://a.com/p', 'exact')).toBe(true)
  })
})
