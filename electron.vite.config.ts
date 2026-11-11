/** 配置桌面进程构建，并在生产界面限制可执行内容来源。 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { amapFrameContentSecurityPolicy, rendererContentSecurityPolicy } from './src/shared/renderer-security-policy'

const root = fileURLToPath(new URL('.', import.meta.url))

/** 为主工作区与隔离地图页分别写入生产 CSP。 */
function rendererSecurityPolicy() {
  return {
    name: 'tripwise-renderer-security-policy',
    transformIndexHtml: {
      order: 'pre' as const,
      handler(html: string, context: { server?: unknown; filename?: string }) {
        if (context.server) return html
        const pageName = context.filename?.replace(/\\/g, '/').split('/').at(-1)
        const policy = pageName === 'amap-map.html'
          ? amapFrameContentSecurityPolicy()
          : rendererContentSecurityPolicy()
        return {
          html,
          tags: [{
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend' as const
          }]
        }
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve(root, 'src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
    build: { rollupOptions: { output: { format: 'cjs' } } }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react(), rendererSecurityPolicy()],
    build: {
      rolldownOptions: {
        input: {
          index: resolve(root, 'src/renderer/index.html'),
          amapMap: resolve(root, 'src/renderer/amap-map.html')
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(root, 'src/renderer/src'),
        '@shared': resolve(root, 'src/shared')
      }
    }
  }
})
