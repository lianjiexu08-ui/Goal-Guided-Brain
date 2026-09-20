import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    host: '127.0.0.1',
    port: 3088,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3089' },
  },
  plugins: [vinext()],
});
