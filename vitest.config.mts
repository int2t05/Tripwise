/** 让测试使用与桌面渲染进程一致的源码路径别名。 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(root, 'src/renderer/src'),
      '@shared': resolve(root, 'src/shared')
    }
  }
})
