/** 解析候选包输出目录，只允许项目根目录下的候选目录名称。 */
import { join } from 'node:path'

const DEFAULT_CANDIDATE_OUTPUT = 'release-candidate-current'
const CANDIDATE_OUTPUT_PATTERN = /^release-candidate(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/

/** 校验候选目录名，避免把构建输出写到候选目录之外。 */
export function candidateOutputDirectoryName(env = process.env) {
  const name = env.TRIPWISE_CANDIDATE_OUTPUT?.trim() || DEFAULT_CANDIDATE_OUTPUT
  if (!CANDIDATE_OUTPUT_PATTERN.test(name)) {
    throw new Error('候选输出目录只能是 release-candidate 或项目根目录下的 release-candidate-* 目录。')
  }
  return name
}

/** 返回已校验的候选输出绝对路径。 */
export function candidateOutputDirectory(projectRoot, env = process.env) {
  return join(projectRoot, candidateOutputDirectoryName(env))
}
