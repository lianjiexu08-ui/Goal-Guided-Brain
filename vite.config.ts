import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

const uiPort = Number(process.env.WORKBENCH_UI_PORT || 3088);
const apiPort = Number(process.env.WORKBENCH_API_PORT || 3089);

export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    host: '127.0.0.1',
    port: uiPort,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  plugins: [vinext()],
});
