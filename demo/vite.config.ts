import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
})
