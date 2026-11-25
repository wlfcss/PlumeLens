import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      minify: 'esbuild',
      target: 'node24',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      minify: 'esbuild',
      target: 'node24',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts'),
        },
        // Electron sandbox=true 下 preload 必须是 CommonJS（ESM 不会执行，
        // 导致 contextBridge.exposeInMainWorld 没运行 → window.plumelens 是 undefined）
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    build: {
      minify: 'esbuild',
      target: 'chrome156',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'renderer/index.html'),
        },
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('/echarts/') || id.includes('/zrender/')) return 'vendor-echarts'
            if (id.includes('/pinyin-pro/')) return 'vendor-pinyin'
            if (id.includes('/@tanstack/')) return 'vendor-tanstack'
            if (id.includes('/lucide-react/')) return 'vendor-lucide'
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
              return 'vendor-react'
            }
            return undefined
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
