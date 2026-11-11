/** 验证旅行评测记录模板、隐私边界和 Beta 门槛计分。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createEvaluationTemplate, scoreEvaluation } from './evaluate-travel-results.mjs'

const manifest = JSON.parse(await readFile(new URL('../tests/fixtures/travel-evaluation-cases.json', import.meta.url), 'utf8'))
const cliPath = fileURLToPath(new URL('./evaluate-travel-results.mjs', import.meta.url))
const temporaryDirectories = []

/** 每条命令行用例使用隔离文件，并在结束后清理。 */
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** 构造只用于计分器测试的完整记录，不代表真实模型质量结果。 */
function passingRecord() {
  const record = createEvaluationTemplate(manifest)
  record.run = {
    buildVersion: '0.1.0-test',
    modelId: 'fixture-model',
    platform: 'test-runtime',
    startedAt: '2026-10-19T00:00:00.000Z',
    completedAt: '2026-10-19T00:30:00.000Z'
  }
  record.factEvidenceReviewed = true
  record.factEvidenceReviewedAt = '2026-10-19T00:31:00.000Z'
  for (const item of record.cases) {
    item.status = 'reviewed'
    item.evidenceRef = `private-evidence/${item.id}`
    item.constraintResults.forEach((result) => { result.result = 'pass' })
    item.dynamicFactResults.forEach((result) => {
      result.outcome = 'source'
      result.hasSourceLink = true
      result.hasFetchedAt = true
    })
    item.conflictAnnotationsReviewed = true
    if (item.failureRecovery) item.failureRecovery = { usableDraft: true, clearExplanation: false }
  }
  record.cases.find((item) => item.id === 'TW-03').conflicts.push({ severity: 'severe', expected: true, detected: true })
  record.cases.find((item) => item.id === 'TW-17').conflicts.push({ severity: 'other', expected: true, detected: true })
  return record
}

/** 通过真实子进程执行 CLI，检查退出码和机器可读汇总。 */
async function runEvaluatorCli(record) {
  const directory = await mkdtemp(join(tmpdir(), 'tripwise-eval-cli-'))
  temporaryDirectories.push(directory)
  const resultPath = join(directory, 'results.json')
  await writeFile(resultPath, JSON.stringify(record), 'utf8')
  const child = spawnSync(process.execPath, [cliPath, resultPath], { encoding: 'utf8', timeout: 5000 })
  if (child.error) throw child.error
  return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr }
}

describe('旅行案例评测计分器', () => {
  it('从固定案例生成不含回复正文或凭证字段的 30 案模板', () => {
    const template = createEvaluationTemplate(manifest)

    assert.equal(template.cases.length, 30)
    assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'scope', 'cases'])
    assert.equal(Object.hasOwn(manifest.cases[0], 'expectedConflictAnnotations'), false)
    assert.equal(template.cases[0].constraintResults.length, manifest.cases[0].mustPreserve.length)
    assert.equal(template.cases[0].dynamicFactResults.length, manifest.cases[0].dynamicFactsToVerify.length)
    assert.equal(template.cases.find((item) => item.id === 'TW-18').failureRecovery.usableDraft, null)
    assert.equal(JSON.stringify(template).includes('apiKey'), false)
    assert.equal(JSON.stringify(template).includes('response'), false)
  })

  it('拒绝不受支持的清单版本、案例字段和来源故障工具', () => {
    const unsupportedVersion = structuredClone(manifest)
    unsupportedVersion.schemaVersion = 2
    assert.throws(() => createEvaluationTemplate(unsupportedVersion), /版本不受支持/)

    const staleField = structuredClone(manifest)
    staleField.cases[0].reviewStatus = 'pending'
    assert.throws(() => createEvaluationTemplate(staleField), /未支持的字段/)

    const unknownFailure = structuredClone(manifest)
    unknownFailure.cases[17].failureInjection = 'unknown-tool'
    assert.throws(() => createEvaluationTemplate(unknownFailure), /不支持的来源故障工具/)

    const multiplePlans = structuredClone(manifest)
    multiplePlans.cases[1].expectedPlanCount = 2
    assert.throws(() => createEvaluationTemplate(multiplePlans), /单份计划产品只允许 0 或 1/)
  })

  it('空白模板计为未完成评测，不误报为输入损坏或通过', () => {
    assert.equal(scoreEvaluation(createEvaluationTemplate(manifest), manifest).status, 'incomplete')
  })

  it('按 PRD 门槛计算可追溯、冲突识别和来源故障恢复结果', () => {
    const summary = scoreEvaluation(passingRecord(), manifest)

    assert.equal(summary.status, 'pass')
    assert.equal(summary.metrics.caseCoverage.reviewed, 30)
    assert.equal(summary.metrics.dynamicFactTraceability.percent, 100)
    assert.equal(summary.metrics.severeConflictMisses.missed, 0)
    assert.equal(summary.metrics.otherConflictRecall.percent, 100)
    assert.equal(summary.metrics.sourceFailureRecovery.percent, 100)
    assert.equal(summary.gates.every((item) => item.status === 'pass'), true)
  })

  it('严重冲突漏报会使完整评测失败', () => {
    const record = passingRecord()
    record.cases.find((item) => item.id === 'TW-03').conflicts[0].detected = false

    const summary = scoreEvaluation(record, manifest)

    assert.equal(summary.status, 'fail')
    assert.equal(summary.metrics.severeConflictMisses.missed, 1)
  })

  it('未评审案例或来源证据字段待补时不会报告通过', () => {
    const record = passingRecord()
    record.cases.find((item) => item.id === 'TW-01').status = 'not-run'
    record.cases.find((item) => item.id === 'TW-02').dynamicFactResults[0].hasFetchedAt = false

    const summary = scoreEvaluation(record, manifest)

    assert.equal(summary.status, 'incomplete')
    assert.equal(summary.gates.every((item) => item.status === 'pending'), true)
  })

  it('区分已实跑但尚未人工复核的案例，并要求其引用安全证据路径', () => {
    const record = passingRecord()
    const item = record.cases.find((testCase) => testCase.id === 'TW-07')
    item.status = 'run-pending-review'
    item.evidenceRef = 'runs/2026-10-24-output-contract/TW-07.json'
    item.constraintResults.forEach((result) => { result.result = 'pending' })
    item.conflictAnnotationsReviewed = false

    const summary = scoreEvaluation(record, manifest)

    assert.equal(summary.status, 'incomplete')
    assert.equal(summary.metrics.caseCoverage.reviewed, 29)

    item.evidenceRef = '/Users/private/TW-07.json'
    assert.throws(() => scoreEvaluation(record, manifest), /安全的相对路径/)
  })

  it('单一来源故障恢复率达到 80% 时通过门槛', () => {
    const record = passingRecord()
    const failingRecovery = record.cases.filter((item) => item.failureRecovery !== null).at(-1)
    failingRecovery.failureRecovery = { usableDraft: false, clearExplanation: false }

    const summary = scoreEvaluation(record, manifest)

    assert.equal(summary.status, 'pass')
    assert.equal(summary.metrics.sourceFailureRecovery.percent, 80)
  })

  it('单一来源故障恢复率低于 80% 时使完整评测失败', () => {
    const record = passingRecord()
    const failingRecovery = record.cases.filter((item) => item.failureRecovery !== null).slice(-2)
    failingRecovery.forEach((item) => { item.failureRecovery = { usableDraft: false, clearExplanation: false } })

    const summary = scoreEvaluation(record, manifest)

    assert.equal(summary.status, 'fail')
    assert.equal(summary.metrics.sourceFailureRecovery.percent, 60)
  })

  it('拒绝模板之外字段，避免把凭证或原始回复写入评测记录', () => {
    const record = passingRecord()
    record.apiKey = 'redacted-test-value'

    assert.throws(() => scoreEvaluation(record, manifest), /未支持的字段/)
  })

  it('接受常见兼容模型 ID，同时拒绝凭证形态和绝对证据路径', () => {
    const compatibleModelIds = passingRecord()
    compatibleModelIds.run.modelId = 'openrouter/meta-llama/Llama-3.1:free'
    assert.equal(scoreEvaluation(compatibleModelIds, manifest).status, 'pass')

    const keyInModelId = passingRecord()
    keyInModelId.run.modelId = '00000000-0000-0000-0000-000000000000'
    assert.throws(() => scoreEvaluation(keyInModelId, manifest), /不能填写凭证/)

    for (const absolutePath of ['/Users/private/TW-01.png', 'C:\\Users\\private\\TW-01.png', '\\\\server\\share\\TW-01.png']) {
      const absoluteEvidence = passingRecord()
      absoluteEvidence.cases[0].evidenceRef = absolutePath
      assert.throws(() => scoreEvaluation(absoluteEvidence, manifest), /安全的相对路径/)
    }
  })

  it('要求运行时间包含明确时区，保证不同机器计分一致', () => {
    const localTime = passingRecord()
    localTime.run.startedAt = '2026-10-19T00:00:00'

    assert.throws(() => scoreEvaluation(localTime, manifest), /带时区的 ISO 时间/)
  })

  it('命令行对通过、未完成和失败分别返回 0、2、1', async () => {
    const incomplete = await runEvaluatorCli(createEvaluationTemplate(manifest))
    assert.equal(incomplete.exitCode, 2)
    assert.equal(JSON.parse(incomplete.stdout).status, 'incomplete')
    assert.equal(incomplete.stderr, '')

    const passed = await runEvaluatorCli(passingRecord())
    assert.equal(passed.exitCode, 0)
    assert.equal(JSON.parse(passed.stdout).status, 'pass')
    assert.equal(passed.stderr, '')

    const failedRecord = passingRecord()
    failedRecord.cases.find((item) => item.id === 'TW-03').conflicts[0].detected = false
    const failed = await runEvaluatorCli(failedRecord)
    assert.equal(failed.exitCode, 1)
    assert.equal(JSON.parse(failed.stdout).status, 'fail')
    assert.equal(failed.stderr, '')
  })
})
