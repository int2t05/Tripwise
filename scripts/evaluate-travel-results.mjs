/** 根据固定旅行案例和人工审核记录计算 Beta 质量门槛。 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const manifestPath = fileURLToPath(new URL('../tests/fixtures/travel-evaluation-cases.json', import.meta.url))
const caseKeys = ['id', 'status', 'evidenceRef', 'constraintResults', 'dynamicFactResults', 'conflictAnnotationsReviewed', 'conflicts', 'failureRecovery']
const resultKeys = ['schemaVersion', 'run', 'factEvidenceReviewed', 'factEvidenceReviewedAt', 'cases']
const runKeys = ['buildVersion', 'modelId', 'platform', 'startedAt', 'completedAt']
const manifestKeys = ['schemaVersion', 'scope', 'cases']
const caseInputKeys = ['id', 'title', 'brief', 'prompt', 'tags', 'mustPreserve', 'dynamicFactsToVerify', 'failureInjection']
const briefKeys = ['departureCity', 'destination', 'startDate', 'endDate', 'arrivalFlight', 'arrivalTime', 'leaveTime', 'travelers', 'budget', 'lodgingLocation', 'lodging', 'pace', 'earlyStart', 'interests', 'transport', 'dietary', 'luggage', 'clothing', 'constraints']
const failureInjectionTools = new Set(['search_web', 'get_weather', 'find_places', 'estimate_route', 'mcp-tool'])

/** 从唯一案例清单生成不含模型响应和凭证的审核记录模板。 */
export function createEvaluationTemplate(manifest) {
  validateManifest(manifest)
  return {
    schemaVersion: 1,
    run: { buildVersion: '', modelId: '', platform: '', startedAt: '', completedAt: '' },
    factEvidenceReviewed: false,
    factEvidenceReviewedAt: null,
    cases: manifest.cases.map((item) => ({
      id: item.id,
      status: 'not-run',
      evidenceRef: '',
      constraintResults: item.mustPreserve.map((requirement) => ({ requirement, result: 'pending' })),
      dynamicFactResults: item.dynamicFactsToVerify.map((fact) => ({
        fact,
        outcome: 'pending',
        hasSourceLink: false,
        hasFetchedAt: false
      })),
      conflictAnnotationsReviewed: false,
      conflicts: [],
      failureRecovery: item.failureInjection === null ? null : { usableDraft: null, clearExplanation: null }
    }))
  }
}

/** 校验固定案例清单版本、字段、失败工具和连续编号。 */
function validateManifest(manifest) {
  requireObject(manifest, '固定案例清单')
  requireKeys(manifest, manifestKeys, '固定案例清单')
  if (manifest.schemaVersion !== 1) throw new Error('固定案例清单版本不受支持。')
  requireText(manifest.scope, '固定案例清单范围')
  if (!Array.isArray(manifest.cases) || manifest.cases.length !== 30) throw new Error('固定案例清单必须包含 30 个案例。')

  for (let index = 0; index < manifest.cases.length; index += 1) {
    const item = manifest.cases[index]
    requireObject(item, '固定案例')
    const allowedKeys = [
      ...caseInputKeys,
      ...(Object.hasOwn(item, 'expectedPlanCount') ? ['expectedPlanCount'] : []),
      ...(Object.hasOwn(item, 'syntheticEvidence') ? ['syntheticEvidence'] : [])
    ]
    requireKeys(item, allowedKeys, '固定案例')

    const expectedId = `TW-${String(index + 1).padStart(2, '0')}`
    if (item.id !== expectedId) throw new Error(`固定案例必须按顺序使用编号 ${expectedId}。`)
    requireText(item.title, `案例 ${item.id} 标题`)
    requireBoundedString(item.prompt, `案例 ${item.id} 提示`, 3_000)
    if (Object.hasOwn(item, 'expectedPlanCount') &&
        (!Number.isInteger(item.expectedPlanCount) || item.expectedPlanCount < 0 || item.expectedPlanCount > 1)) {
      throw new Error(`案例 ${item.id} 的预期计划数量无效；单份计划产品只允许 0 或 1。`)
    }
    requireObject(item.brief, `案例 ${item.id} 旅行简报`)
    requireKeys(item.brief, briefKeys, `案例 ${item.id} 旅行简报`)
    for (const [key, value] of Object.entries(item.brief)) {
      requireBoundedString(value, `案例 ${item.id} 的旅行简报.${key}`, 1_000)
    }

    for (const [key, values, minimum] of [
      ['tags', item.tags, 1],
      ['mustPreserve', item.mustPreserve, 1],
      ['dynamicFactsToVerify', item.dynamicFactsToVerify, 0]
    ]) {
      if (!Array.isArray(values) || values.length < minimum) throw new Error(`案例 ${item.id} 的 ${key} 清单无效。`)
      for (const value of values) requireText(value, `案例 ${item.id} 的 ${key} 项`)
      if (new Set(values).size !== values.length) throw new Error(`案例 ${item.id} 的 ${key} 清单有重复项。`)
    }

    if (item.failureInjection !== null && !failureInjectionTools.has(item.failureInjection)) {
      throw new Error(`案例 ${item.id} 指定了不支持的来源故障工具。`)
    }
    if (allowedKeys.includes('syntheticEvidence')) {
      if (!Array.isArray(item.syntheticEvidence) || item.syntheticEvidence.length === 0) {
        throw new Error(`案例 ${item.id} 的合成来源清单无效。`)
      }
      for (const evidence of item.syntheticEvidence) {
        requireObject(evidence, `案例 ${item.id} 的合成来源`)
        requireKeys(evidence, ['kind', 'url', 'text'], `案例 ${item.id} 的合成来源`)
        for (const [key, value] of Object.entries(evidence)) requireText(value, `案例 ${item.id} 的合成来源.${key}`)
      }
    }
  }
}

/** 检查记录结构，并拒绝不在审核模板中的字段，避免误收原始输出或凭证。 */
function validateEvaluation(record, manifest) {
  requireObject(record, '评测记录')
  requireKeys(record, resultKeys, '评测记录')
  if (record.schemaVersion !== 1) throw new Error('评测记录版本不受支持。')
  requireObject(record.run, '运行信息')
  requireKeys(record.run, runKeys, '运行信息')
  for (const key of ['buildVersion', 'modelId', 'platform']) {
    if (record.run[key] !== '') requireText(record.run[key], `运行信息.${key}`)
  }
  if (record.run.modelId !== '' && (
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/.test(record.run.modelId) ||
    /^(?:Bearer\b|sk-|tvly-|fc-|exa[-_]|AIza)/i.test(record.run.modelId) ||
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.run.modelId) ||
    /^[A-Za-z0-9_-]{32,}$/.test(record.run.modelId)
  )) {
    throw new Error('modelId 只能填写模型名称，不能填写凭证。')
  }
  const startedAt = record.run.startedAt === '' ? null : parseTimestamp(record.run.startedAt, 'run.startedAt')
  const completedAt = record.run.completedAt === '' ? null : parseTimestamp(record.run.completedAt, 'run.completedAt')
  if (startedAt !== null && completedAt !== null && completedAt < startedAt) throw new Error('评测完成时间早于开始时间。')
  requireBoolean(record.factEvidenceReviewed, 'factEvidenceReviewed')
  if (record.factEvidenceReviewed) parseTimestamp(record.factEvidenceReviewedAt, 'factEvidenceReviewedAt')
  else if (record.factEvidenceReviewedAt !== null) throw new Error('事实证据未审核时，审核时间必须为空。')
  if (!Array.isArray(record.cases) || record.cases.length !== manifest.cases.length) {
    throw new Error(`评测案例数必须为 ${manifest.cases.length}。`)
  }

  const template = createEvaluationTemplate(manifest)
  const expectedById = new Map(template.cases.map((item) => [item.id, item]))
  const seenIds = new Set()
  for (const item of record.cases) {
    requireObject(item, '案例记录')
    requireKeys(item, caseKeys, '案例记录')
    if (typeof item.id !== 'string' || !expectedById.has(item.id) || seenIds.has(item.id)) throw new Error('案例 ID 缺失、重复或不属于固定清单。')
    seenIds.add(item.id)
    const expected = expectedById.get(item.id)
    if (!['not-run', 'run-pending-review', 'reviewed'].includes(item.status)) throw new Error(`案例 ${item.id} 的状态无效。`)
    if (typeof item.evidenceRef !== 'string' || item.evidenceRef.length > 300) throw new Error(`案例 ${item.id} 的证据位置无效。`)
    if (item.status !== 'not-run' && !isSafeEvidenceRef(item.evidenceRef)) throw new Error(`案例 ${item.id} 的证据位置必须是安全的相对路径。`)
    validateList(item.constraintResults, expected.constraintResults, 'requirement', ['pass', 'fail', 'pending'], item.id)
    validateDynamicFacts(item.dynamicFactResults, expected.dynamicFactResults, item.id)
    requireBoolean(item.conflictAnnotationsReviewed, `案例 ${item.id} 的冲突标注审核状态`)
    if (!Array.isArray(item.conflicts)) throw new Error(`案例 ${item.id} 的冲突清单无效。`)
    for (const conflict of item.conflicts) {
      requireObject(conflict, `案例 ${item.id} 的冲突标注`)
      requireKeys(conflict, ['severity', 'expected', 'detected'], `案例 ${item.id} 的冲突标注`)
      if (!['severe', 'other'].includes(conflict.severity)) throw new Error(`案例 ${item.id} 的冲突严重度无效。`)
      requireBoolean(conflict.expected, `案例 ${item.id} 的预期冲突标记`)
      requireBoolean(conflict.detected, `案例 ${item.id} 的识别结果`)
    }
    validateFailureRecovery(item.failureRecovery, expected.failureRecovery, item.id)
    if (item.status === 'reviewed' && item.conflictAnnotationsReviewed !== true) throw new Error(`案例 ${item.id} 已审核但冲突标注尚未审核。`)
  }
  return ['buildVersion', 'modelId', 'platform'].every((key) => record.run[key].trim().length > 0) && startedAt !== null && completedAt !== null
}

/** 计算可追溯、约束保持、冲突识别和来源故障恢复指标。 */
export function scoreEvaluation(record, manifest) {
  const metadataComplete = validateEvaluation(record, manifest)
  const reviewedCases = record.cases.filter((item) => item.status === 'reviewed')
  const constraintResults = reviewedCases.flatMap((item) => item.constraintResults)
  const settledConstraints = constraintResults.filter((item) => item.result !== 'pending')
  const factResults = reviewedCases.flatMap((item) => item.dynamicFactResults)
  const settledFacts = factResults.filter((item) => item.outcome !== 'pending')
  const conflicts = reviewedCases.flatMap((item) => item.conflicts)
  const expectedSevere = conflicts.filter((item) => item.severity === 'severe' && item.expected)
  const expectedOther = conflicts.filter((item) => item.severity === 'other' && item.expected)
  const severeMisses = expectedSevere.filter((item) => !item.detected).length
  const otherRecognized = expectedOther.filter((item) => item.detected).length
  const falsePositives = conflicts.filter((item) => !item.expected && item.detected).length
  const failedSourceCases = reviewedCases.filter((item) => item.failureRecovery !== null)
  const recoveredSourceCases = failedSourceCases.filter((item) => item.failureRecovery.usableDraft || item.failureRecovery.clearExplanation)
  const pendingReview = !metadataComplete || record.cases.some((item) => item.status !== 'reviewed') || !record.factEvidenceReviewed ||
    record.cases.some((item) => !item.conflictAnnotationsReviewed) || constraintResults.some((item) => item.result === 'pending') ||
    factResults.some((item) => item.outcome === 'pending') || record.cases.some((item) => item.failureRecovery &&
      (item.failureRecovery.usableDraft === null || item.failureRecovery.clearExplanation === null))

  const metrics = {
    caseCoverage: { reviewed: reviewedCases.length, total: manifest.cases.length },
    mustPreserve: metric(settledConstraints.filter((item) => item.result === 'pass').length, settledConstraints.length),
    dynamicFactTraceability: metric(settledFacts.filter(isTraceable).length, settledFacts.length),
    severeConflictMisses: { expected: expectedSevere.length, missed: severeMisses },
    otherConflictRecall: metric(otherRecognized, expectedOther.length),
    falsePositiveConflicts: falsePositives,
    sourceFailureRecovery: metric(recoveredSourceCases.length, failedSourceCases.length)
  }

  const gates = [
    gate('all-cases-reviewed', !pendingReview, pendingReview ? '仍有案例、事实或冲突标注待审核。' : '30 个案例和必要标注均已审核。'),
    gate('must-preserve-constraints', settledConstraints.length > 0 && settledConstraints.every((item) => item.result === 'pass'), '所有已审核的用户约束均须通过。'),
    gate('dynamic-fact-traceability', settledFacts.length > 0 && settledFacts.every(isTraceable), '动态事实须有来源链接和获取时间，或明确标为估算/未知。'),
    gate('severe-conflict-misses', expectedSevere.length > 0 && severeMisses === 0, '至少标注一项严重冲突，且遗漏为零。'),
    gate('other-conflict-recall', expectedOther.length > 0 && otherRecognized / expectedOther.length >= 0.95, '其他预设冲突识别率须达到 95%。'),
    gate('source-failure-recovery', failedSourceCases.length === 5 && recoveredSourceCases.length / failedSourceCases.length >= 0.8, '五个单一来源故障案例中，至少四个仍能给出可用草案或清楚解释。')
  ].map((item) => ({ ...item, status: pendingReview ? 'pending' : item.passed ? 'pass' : 'fail' }))

  const status = pendingReview ? 'incomplete' : gates.every((item) => item.passed) ? 'pass' : 'fail'
  return { status, metrics, gates }
}

/** 检查评测项与案例清单一一对应，避免漏评或误把类别当事实值。 */
function validateList(actual, expected, property, allowedResults, caseId) {
  if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`案例 ${caseId} 的 ${property} 评测项数量不匹配。`)
  for (let index = 0; index < expected.length; index += 1) {
    const item = actual[index]
    requireObject(item, `案例 ${caseId} 的 ${property} 评测项`)
    requireKeys(item, [property, 'result'], `案例 ${caseId} 的 ${property} 评测项`)
    if (item[property] !== expected[index][property] || !allowedResults.includes(item.result)) {
      throw new Error(`案例 ${caseId} 的 ${property} 评测项与固定清单不匹配。`)
    }
  }
}

/** 校验动态事实是否明确区分来源、估算、未知和缺失。 */
function validateDynamicFacts(actual, expected, caseId) {
  if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`案例 ${caseId} 的动态事实评测项数量不匹配。`)
  for (let index = 0; index < expected.length; index += 1) {
    const item = actual[index]
    requireObject(item, `案例 ${caseId} 的动态事实评测项`)
    requireKeys(item, ['fact', 'outcome', 'hasSourceLink', 'hasFetchedAt'], `案例 ${caseId} 的动态事实评测项`)
    if (item.fact !== expected[index].fact || !['source', 'estimated', 'unknown', 'missing', 'pending'].includes(item.outcome)) {
      throw new Error(`案例 ${caseId} 的动态事实评测项与固定清单不匹配。`)
    }
    requireBoolean(item.hasSourceLink, `案例 ${caseId} 的来源链接标记`)
    requireBoolean(item.hasFetchedAt, `案例 ${caseId} 的来源获取时间标记`)
  }
}

/** 验证只有来源故障案例填写恢复结果，且已审核结果必须完整。 */
function validateFailureRecovery(actual, expected, caseId) {
  if (expected === null) {
    if (actual !== null) throw new Error(`非来源故障案例 ${caseId} 不应包含恢复结果。`)
    return
  }
  requireObject(actual, `案例 ${caseId} 的来源故障恢复结果`)
  requireKeys(actual, ['usableDraft', 'clearExplanation'], `案例 ${caseId} 的来源故障恢复结果`)
  for (const key of ['usableDraft', 'clearExplanation']) {
    if (actual[key] !== null) requireBoolean(actual[key], `案例 ${caseId} 的 ${key}`)
  }
}

/** 载入唯一案例清单，避免模板和计分使用不同输入。 */
async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  validateManifest(manifest)
  return manifest
}

/** 将比例四舍五入到百分数的两位小数；无样本时保留空值。 */
function metric(numerator, denominator) {
  return { numerator, denominator, percent: denominator ? Math.round((numerator / denominator) * 10_000) / 100 : null }
}

/** 标记质量门槛及其失败条件。 */
function gate(id, passed, detail) {
  return { id, passed, detail }
}

/** 仅在来源值同时具有链接和获取时间时计为可追溯。 */
function isTraceable(item) {
  return item.outcome === 'estimated' || item.outcome === 'unknown' ||
    (item.outcome === 'source' && item.hasSourceLink && item.hasFetchedAt)
}

/** 确保 JSON 项不是空值或数组。 */
function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象。`)
}

/** 检查对象字段与当前记录版本完全匹配。 */
function requireKeys(value, allowed, label) {
  const keys = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error(`${label}包含缺失或未支持的字段。`)
}

/** 验证非空文本字段，不回显其值以避免错误信息泄露。 */
function requireText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) throw new Error(`${label}必须为 1–200 个字符的非空文本。`)
}

/** 校验允许为空但有明确长度上限的旅行简报文本。 */
function requireBoundedString(value, label, maximum) {
  if (typeof value !== 'string' || value.length > maximum) throw new Error(`${label}文本长度无效。`)
}

/** 证据引用仅允许相对路径，避免写入外部地址、密钥或本机绝对路径。 */
function isSafeEvidenceRef(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 300) return false
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false
  return !value.split(/[\\/]/).includes('..')
}

/** 验证布尔审核标记。 */
function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label}必须为布尔值。`)
}

/** 验证 ISO 时间，并返回毫秒值用于先后关系检查。 */
function parseTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label}必须是带时区的 ISO 时间。`)
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`${label}不是有效时间。`)
  return timestamp
}

/** 执行模板生成或评测计分，不读取 API 密钥或原始模型回复。 */
async function main(args) {
  if (args.length === 1 && args[0] === '--template') {
    process.stdout.write(`${JSON.stringify(createEvaluationTemplate(await loadManifest()), null, 2)}\n`)
    return
  }
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('用法：npm run evaluate:travel -- --template | <审核记录.json>\n')
    process.exitCode = 2
    return
  }

  try {
    const record = JSON.parse(await readFile(args[0], 'utf8'))
    const summary = scoreEvaluation(record, await loadManifest())
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    if (summary.status === 'incomplete') process.exitCode = 2
    else if (summary.status === 'fail') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`旅行案例评测失败：${error instanceof Error ? error.message : '输入无效。'}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
