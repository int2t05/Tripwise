/** 验证主要工作区跳转入口的可访问名称和目标。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SkipLink } from '../src/renderer/src/SkipLink'

describe('SkipLink', () => {
  it('提供可读名称并指向主工作区', () => {
    const markup = renderToStaticMarkup(<SkipLink />)

    expect(markup).toContain('跳至主要内容')
    expect(markup).toContain('href="#main-workspace"')
  })
})
