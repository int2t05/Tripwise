/** 记录设置与凭证分步保存的结果，避免失败时隐藏已完成的部分写入。 */

export type SettingsSaveResult<T> =
  | { kind: 'saved'; snapshot: T }
  | { kind: 'secrets-failed'; snapshot: T; error: unknown }

/** 先保存普通设置，再保存凭证；凭证失败时保留已经提交的设置快照。 */
export async function saveSettingsAndSecrets<T>(
  saveSettings: () => Promise<T>,
  saveSecrets: () => Promise<T>
): Promise<SettingsSaveResult<T>> {
  const settingsSnapshot = await saveSettings()
  try {
    return { kind: 'saved', snapshot: await saveSecrets() }
  } catch (error) {
    return { kind: 'secrets-failed', snapshot: settingsSnapshot, error }
  }
}
