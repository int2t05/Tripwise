/** 验证不同桌面平台的菜单结构和缩放动作映射。 */
import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildApplicationMenu } from '../src/main/application-menu.js'

function submenu(menu: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const item = menu.find((entry) => entry.label === label)
  return Array.isArray(item?.submenu) ? item.submenu : []
}

describe('跨平台原生菜单', () => {
  it('将缩放菜单项映射到主窗口的 10% 缩放动作', () => {
    const onZoom = vi.fn()
    const view = submenu(buildApplicationMenu(false, onZoom), '视图')
    const zoomItems = view.filter((item) => item.label && item.label !== '全屏')

    expect(zoomItems.map((item) => item.label)).toEqual(['放大界面', '缩小界面', '重置界面大小'])
    expect(zoomItems.map((item) => item.accelerator)).toEqual([
      'CommandOrControl+Plus', 'CommandOrControl+-', 'CommandOrControl+0'
    ])
    zoomItems.forEach((item) => item.click?.(undefined as never, undefined as never, undefined as never))
    expect(onZoom.mock.calls).toEqual([[1], [-1], [0]])
  })

  it('macOS 提供应用和窗口菜单，并把文件菜单映射为关闭窗口', () => {
    const menu = buildApplicationMenu(true, vi.fn())
    expect(menu.map((item) => item.label)).toEqual(['行程有数', '文件', '编辑', '视图', '窗口'])
    expect(submenu(menu, '文件')).toMatchObject([{ role: 'close' }])
  })

  it('Windows 和 Linux 提供退出菜单及标准文本编辑操作', () => {
    const menu = buildApplicationMenu(false, vi.fn())
    expect(menu.map((item) => item.label)).toEqual(['文件', '编辑', '视图'])
    expect(submenu(menu, '文件')).toMatchObject([{ role: 'quit' }])
    expect(submenu(menu, '编辑').map((item) => item.role).filter(Boolean)).toEqual([
      'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'
    ])
  })
})
