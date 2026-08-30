/**
 * Cloudflare Workers 主入口
 */

import { Hono } from 'hono'
import type { Env } from './types/env'
import { parseConfig } from './types/env'
import { clientAuth, cors, errorHandler, logger } from './middleware'
import {
  createSession,
  getSessionStatus,
  verifyTurnstile,
  verifyTelegramToken,
  createChallenge,
  verifyPoWHandler,
} from './handlers/sessions'
import { renderVerifyPage } from './views/verify'

// 导出 Durable Object
export { SessionStore } from './durable-objects/session-store'

// 创建 Hono 应用
const app = new Hono<{ Bindings: Env }>()

// 全局中间件
app.use('*', errorHandler())
app.use('*', cors())
app.use('*', logger())

// API 路由 - 需要客户端认证
app.use('/api/*', async (c, next) => {
  const config = parseConfig(c.env)
  return clientAuth(config)(c, next)
})

app.post('/api/sessions', async (c) => {
  const config = parseConfig(c.env)
  return createSession(c, config)
})

app.get('/api/sessions/:id', getSessionStatus)

app.post('/api/sessions/:id/verify-turnstile', async (c) => {
  const config = parseConfig(c.env)
  return verifyTurnstile(c, config)
})

app.post('/api/sessions/:id/verify-telegram', async (c) => {
  const config = parseConfig(c.env)
  return verifyTelegramToken(c, config)
})

app.post('/api/sessions/:id/challenge', async (c) => {
  const config = parseConfig(c.env)
  return createChallenge(c, config)
})

app.post('/api/sessions/:id/verify-pow', async (c) => {
  const config = parseConfig(c.env)
  return verifyPoWHandler(c, config)
})

// 验证页面 - 无需认证
app.get('/verify/:id', async (c) => {
  const config = parseConfig(c.env)
  const sessionId = c.req.param('id')
  return renderVerifyPage(c, sessionId, config)
})

// 健康检查
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() })
})

// 首页
app.get('/', (c) => {
  return c.text('Telegram User Verification Service')
})

export default app
