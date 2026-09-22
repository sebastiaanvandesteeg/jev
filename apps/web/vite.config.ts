import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const env = loadEnv(mode, root, '');
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@jev/shared': fileURLToPath(
          new URL('../../packages/shared/src/index.ts', import.meta.url),
        ),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${process.env.PORT || env.PORT || 3001}` },
    },
  };
});
