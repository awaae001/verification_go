/**
 * Cloudflare Workers 主入口
 */

import { Hono } from 'hono'
import type { Env, Variables } from './types/env'
import { parseConfig } from './types/env'
import { clientAuth, cors, errorHandler, logger, antibotProtect } from './middleware'
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
const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// 全局中间件
app.use('*', errorHandler())
app.use('*', cors())
app.use('*', logger())

// 验证页面 - 公开访问（对应 Go 的 /v/:sid）
app.get('/v/:id', async (c) => {
  const config = parseConfig(c.env)
  const sessionId = c.req.param('id')
  return renderVerifyPage(c, sessionId, config)
})

// API 路由 - 会话创建与状态查询需要客户端认证
app.post('/api/sessions', async (c) => {
  const config = parseConfig(c.env)
  await clientAuth(config)(c, async () => {})
  return createSession(c, config)
})

app.get('/api/sessions/:sid/status', async (c) => {
  const config = parseConfig(c.env)
  await clientAuth(config)(c, async () => {})
  return getSessionStatus(c)
})

// 浏览器验证端点 - antibot 无需鉴权，后续步骤需要 antibot token
app.post('/api/sessions/:sid/antibot', async (c) => {
  const config = parseConfig(c.env)
  return verifyTurnstile(c, config)
})

app.post('/api/sessions/:sid/telegram', async (c) => {
  const config = parseConfig(c.env)
  await antibotProtect()(c, async () => {})
  return verifyTelegramToken(c, config)
})

app.post('/api/sessions/:sid/challenge', async (c) => {
  const config = parseConfig(c.env)
  await antibotProtect()(c, async () => {})
  return createChallenge(c, config)
})

app.post('/api/sessions/:sid/pow', async (c) => {
  const config = parseConfig(c.env)
  await antibotProtect()(c, async () => {})
  return verifyPoWHandler(c, config)
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
