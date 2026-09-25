import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setupEnv.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Les tests de cloisonnement partagent un état (fixtures créées dans
    // beforeAll) et s'exécutent contre la même base réelle : pas de
    // parallélisation entre fichiers pour éviter les interférences.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
