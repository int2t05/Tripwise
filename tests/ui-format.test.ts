/** 验证 Electron IPC 错误只显示业务原因，不向用户泄露传输包装。 */
import { describe, expect, it } from 'vitest'
import { errorMessage } from '../src/renderer/src/ui-format.js'

describe('用户可见错误格式', () => {
  it('去除 Electron IPC 方法包装并保留主进程业务错误', () => {
    const reason = new Error("Error invoking remote method 'trip:import-backup': Error: 备份文件不是有效的 JSON；当前资料未修改。")

    expect(errorMessage(reason)).toBe('备份文件不是有效的 JSON；当前资料未修改。')
  })

  it('普通错误原样保留并支持调用方上下文的兜底文案', () => {
    expect(errorMessage(new Error('文件读取失败。'))).toBe('文件读取失败。')
    expect(errorMessage(null, '地图操作失败。')).toBe('地图操作失败。')
  })
})
