/** 验证快照启动页的加载播报、可读错误与重试状态。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StartupScreen } from '../src/renderer/src/StartupScreen'

function render(error: string, busy: boolean): string {
  return renderToStaticMarkup(<StartupScreen brandSymbol="brand.svg" error={error} busy={busy} onRetry={() => undefined} />)
}

describe('启动恢复界面', () => {
  it('加载中时播报工作区正在打开', () => {
    const markup = render('', true)

    expect(markup).toContain('role="status"')
    expect(markup).toContain('正在加载旅行资料…')
    expect(markup).toContain('aria-busy="true"')
  })

  it('载入失败时展示原因与重试入口', () => {
    const markup = render('本地旅行资料无法读取。', false)

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('本地旅行资料无法读取。')
    expect(markup).toContain('>重试</button>')
    expect(markup).not.toContain('正在加载旅行资料…')
  })

  it('重试进行中时禁用重复操作并提示进度', () => {
    const markup = render('载入失败', true)

    expect(markup).toContain('class="primary-button" type="button" disabled=""')
    expect(markup).toContain('>正在重试…</button>')
  })
})
