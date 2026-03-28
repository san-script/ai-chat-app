import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/conversations': 'http://localhost:8000',
    },
  },
  optimizeDeps: {
    include: ['mammoth', 'pdfjs-dist'],
  },
})
