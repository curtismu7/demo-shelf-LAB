import { defineConfig } from 'vitest/config';

// Several tests spawn node and docker stand-ins; on a busy machine the 5 s default is too short.
export default defineConfig({ test: { testTimeout: 30000, hookTimeout: 30000 } });
