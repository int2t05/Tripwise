/** 生成跨平台原生菜单模板，集中管理文本编辑和界面缩放操作。 */
import type { MenuItemConstructorOptions } from 'electron'
import type { ZoomDirection } from './zoom.js'

/** 根据当前桌面平台生成菜单，并将缩放动作交给主窗口处理。 */
export function buildApplicationMenu(
  isMac: boolean,
  onZoom: (direction: ZoomDirection) => void
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: '行程有数',
      submenu: [
        { label: '关于行程有数', role: 'about' },
        { type: 'separator' },
        { label: '退出行程有数', role: 'quit' }
      ]
    })
  }

  template.push(
    { label: '文件', submenu: [isMac ? { role: 'close' } : { label: '退出行程有数', role: 'quit' }] },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { type: 'separator' }, { role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '放大界面', accelerator: 'CommandOrControl+Plus', click: () => onZoom(1) },
        { label: '缩小界面', accelerator: 'CommandOrControl+-', click: () => onZoom(-1) },
        { label: '重置界面大小', accelerator: 'CommandOrControl+0', click: () => onZoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  )

  if (isMac) {
    template.push({
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    })
  }

  return template
}
