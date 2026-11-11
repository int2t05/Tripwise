/** 验证地图沙箱消息只包含预期类型、可信坐标与有界路线数据。 */
import { describe, expect, it } from 'vitest'
import { isAmapMapFrameCommand, isAmapMapFrameReply } from '../src/shared/amap-map-bridge.js'

const validCommand = {
  type: 'tripwise:configure-map',
  config: {
    jsKey: 'fixture-js-key',
    serviceHost: 'http://127.0.0.1:49231/tripwise-amap/' + 'a'.repeat(64) + '/_AMapService'
  },
  state: {
    dayNumber: 1,
    selectedStopId: 'stop-1',
    stops: [{ id: 'stop-1', name: '故宫', longitude: 116.397, latitude: 39.909 }],
    routePathSegments: [[[116.397, 39.909], [116.4, 39.91]]]
  }
}

describe('高德地图 iframe 消息边界', () => {
  it('接受最小地图运行配置与当前日地图状态', () => {
    expect(isAmapMapFrameCommand(validCommand)).toBe(true)
  })

  it('拒绝非本机代理、无界坐标和过长路线折线', () => {
    expect(isAmapMapFrameCommand({
      ...validCommand,
      config: { ...validCommand.config, serviceHost: 'https://example.com/proxy' }
    })).toBe(false)
    expect(isAmapMapFrameCommand({
      ...validCommand,
      state: { ...validCommand.state, stops: [{ ...validCommand.state.stops[0], longitude: 181 }] }
    })).toBe(false)
    expect(isAmapMapFrameCommand({
      ...validCommand,
      state: { ...validCommand.state, routePathSegments: [Array.from({ length: 601 }, () => [116.4, 39.9])] }
    })).toBe(false)
  })

  it('只接受选择停靠点和固定地图错误代码两种回传', () => {
    expect(isAmapMapFrameReply({ type: 'tripwise:select-stop', stopId: 'stop-1' })).toBe(true)
    expect(isAmapMapFrameReply({ type: 'tripwise:map-error', code: 'script-load' })).toBe(true)
    expect(isAmapMapFrameReply({ type: 'tripwise:select-stop', stopId: 'x'.repeat(201) })).toBe(false)
    expect(isAmapMapFrameReply({ type: 'tripwise:invoke-ipc', method: 'getSnapshot' })).toBe(false)
    expect(isAmapMapFrameReply({ type: 'tripwise:map-error', code: 'raw-external-error' })).toBe(false)
  })
})
