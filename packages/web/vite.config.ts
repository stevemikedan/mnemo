import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { apiPlugin } from './src-server/api.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: {
    port: 5173,
    host: true
  }
})
