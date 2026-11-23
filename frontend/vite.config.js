import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const localApiTarget = globalThis.process?.env?.VITE_PROXY_TARGET || 'http://127.0.0.1:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: localApiTarget,
        changeOrigin: true,
      },
      '/shared-api': {
        target: 'https://property-takeoff.onrender.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/shared-api(?:\/api)?/, '/api'),
      },
    },
  },
})
