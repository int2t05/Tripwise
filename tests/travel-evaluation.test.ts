/** 校验固定旅行评测输入的规模、覆盖面和未核验事实标记。 */
import { describe, expect, it } from 'vitest'
import manifest from './fixtures/travel-evaluation-cases.json'

const requiredCoverage = [
  'baseline', 'airport-arrival', 'departure', 'closure', 'reservation', 'pace-light', 'pace-moderate', 'pace-high',
  'weather-rain', 'weather-cold', 'ambiguous-place', 'partial-dates', 'dietary-allergy', 'mobility',
  'source-conflict', 'source-failure', 'ugc-untrusted', 'packing', 'route'
]
const tripBriefFields = [
  'departureCity', 'destination', 'startDate', 'endDate', 'arrivalFlight', 'arrivalTime', 'leaveTime', 'travelers',
  'budget', 'lodgingLocation', 'lodging', 'pace', 'earlyStart', 'interests', 'transport', 'dietary', 'luggage', 'clothing', 'constraints'
]

describe('固定旅行规划评测输入', () => {
  it('包含 30 个 ID 唯一且约束可判定的案例', () => {
    const ids = manifest.cases.map((item) => item.id)

    expect(manifest.cases).toHaveLength(30)
    expect(new Set(ids).size).toBe(30)
    for (const item of manifest.cases) {
      expect(item.id).toMatch(/^TW-\d{2}$/)
      expect(item.title.trim().length).toBeGreaterThan(0)
      expect(item.prompt.trim().length).toBeGreaterThan(0)
      expect(item.mustPreserve.length).toBeGreaterThan(0)
      expect(item.dynamicFactsToVerify.every((fact) => fact.trim().length > 0)).toBe(true)
      expect(Object.hasOwn(item, 'expectedConflictAnnotations')).toBe(false)
      expect(Object.keys(item.brief).sort()).toEqual([...tripBriefFields].sort())
      expect(Object.values(item.brief).every((value) => typeof value === 'string')).toBe(true)
    }
  })

  it('清单只保留版本、范围和固定旅行输入', () => {
    expect(Object.keys(manifest)).toEqual(['schemaVersion', 'scope', 'cases'])
    expect(manifest.schemaVersion).toBe(1)
  })

  it('覆盖 PRD 要求的旅行约束、动态事实、来源冲突和恢复场景', () => {
    const actualCoverage = new Set(manifest.cases.flatMap((item) => item.tags))
    const missingCoverage = requiredCoverage.filter((tag) => !actualCoverage.has(tag))

    expect(missingCoverage).toEqual([])
    const failureCases = manifest.cases.filter((item) => item.failureInjection !== null)
    expect(failureCases.map((item) => item.id)).toEqual(['TW-18', 'TW-19', 'TW-20', 'TW-21', 'TW-22'])
    expect(failureCases.every((item) => item.tags.includes('source-failure') && item.tags.includes('recovery'))).toBe(true)
    expect(manifest.cases.filter((item) => item.tags.includes('source-conflict'))).toHaveLength(1)
  })

  it('将冲突事实限制为明确标注的合成示例', () => {
    const conflictCase = manifest.cases.find((item) => 'syntheticEvidence' in item)
    expect(conflictCase?.id).toBe('TW-17')
    if (!conflictCase || !('syntheticEvidence' in conflictCase) || !Array.isArray(conflictCase.syntheticEvidence)) {
      throw new Error('TW-17 缺少合成来源证据。')
    }

    expect(conflictCase.syntheticEvidence).toHaveLength(2)
    for (const evidence of conflictCase.syntheticEvidence) {
      expect(new URL(evidence.url).hostname).toMatch(/\.example\.test$/)
      expect(evidence.text).toContain('合成测试资料')
    }
  })
})
