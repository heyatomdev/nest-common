import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC, not esbuild: Nest's ValidationPipe needs `design:paramtypes` metadata.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] }, plugins: [swc.vite()] });
