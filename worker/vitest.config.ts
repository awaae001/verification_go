/**
 * Vitest 配置
 *
 * tests/ 下均为纯函数单测（pow、token 等工具函数），不依赖 Workers 运行时，
 * 因此使用默认 node 环境即可。
 *
 * 若后续要为 Durable Objects / fetch handler 编写集成测试，
 * 请改用官方方案 @cloudflare/vitest-pool-workers，它会读取 wrangler.toml
 * 并在真实 workerd 中运行测试（旧的 vitest-environment-miniflare 已不再维护）。
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': new URL('./src/', import.meta.url).pathname,
    },
  },
})
