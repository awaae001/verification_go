/**
 * API 处理器 - 会话管理
 * 对应 Go 版本的 handler
 */

import type { Context } from 'hono'
import type { Env, Config } from '../types/env'
import type {
  CreateSessionResponse,
  SessionStatusResponse,
  VerifyTurnstileRequest,
  VerifyTurnstileResponse,
  VerifyTelegramRequest,
  VerifyTelegramResponse,
  CreateChallengeRequest,
  CreateChallengeResponse,
  VerifyPoWRequest,
} from '../types/models'
import { AppError } from '../types/models'
import { generateSecureToken } from '../utils/token'
import { TurnstileService, getRequestHostname } from '../services/turnstile'
import { TelegramVerifier } from '../services/telegram'
import { verifyPoW } from '../utils/pow'

/**
 * 获取会话对应的 Durable Object stub
 */
function getSessionStub(c: Context<{ Bindings: Env }>, sessionId: string) {
  const id = c.env.SESSIONS.idFromName(sessionId)
  return c.env.SESSIONS.get(id)
}

/**
 * POST /api/sessions - 创建新会话
 */
export async function createSession(
  c: Context<{ Bindings: Env }>,
  config: Config
): Promise<Response> {
  const client = c.get('client') as string

  // 生成会话 ID
  const sessionId = generateSecureToken()

  // 计算过期时间
  const now = Date.now()
  const expiresAt = now + config.session.ttlSeconds * 1000

  // 获取会话的 Durable Object
  const stub = getSessionStub(c, sessionId)

  // 创建会话
  const response = await stub.fetch('http://internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      client,
      expiresAt,
    }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new AppError(error.code, error.info.message, response.status)
  }

  // 生成验证 URL
  const verifyUrl = `${config.baseUrl}/verify/${sessionId}`

  const result: CreateSessionResponse = {
    session_id: sessionId,
    verify_url: verifyUrl,
    expires_at: expiresAt,
  }

  return c.json(result, 201)
}

/**
 * GET /api/sessions/:id - 获取会话状态
 */
export async function getSessionStatus(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const sessionId = c.req.param('id')

  const stub = getSessionStub(c, sessionId)
  const response = await stub.fetch('http://internal/get')

  if (!response.ok) {
    const error = await response.json()
    throw new AppError(error.code, error.info.message, response.status)
  }

  const session = await response.json()

  const result: SessionStatusResponse = {
    session_id: session.id,
    status: session.status,
    user_id: session.user?.id,
    user_name: session.user?.name,
  }

  return c.json(result)
}

/**
 * POST /api/sessions/:id/verify-turnstile - 验证 Turnstile
 */
export async function verifyTurnstile(
  c: Context<{ Bindings: Env }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('id')
  const body = await c.req.json<VerifyTurnstileRequest>()

  if (!body.token) {
    throw new AppError('BAD_REQUEST', 'missing turnstile token', 400)
  }

  const stub = getSessionStub(c, sessionId)

  // 1. 原子性检查 - 开始 Turnstile 验证
  const beginResp = await stub.fetch('http://internal/begin-turnstile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      maxAttempts: config.turnstile.maxAttempts,
      retryIntervalMs: config.turnstile.retryIntervalMs,
    }),
  })

  const beginResult = await beginResp.json<{ result: string }>()

  if (beginResult.result === 'session_inactive') {
    throw new AppError('SESSION_NOT_FOUND', 'session not found or expired', 404)
  }
  if (beginResult.result === 'attempt_in_flight') {
    throw new AppError('TURNSTILE_IN_FLIGHT', 'turnstile verification in progress', 409)
  }
  if (beginResult.result === 'attempts_exhausted') {
    throw new AppError(
      'TURNSTILE_ATTEMPTS_EXHAUSTED',
      'turnstile attempts exhausted',
      429
    )
  }
  if (beginResult.result === 'retry_too_soon') {
    throw new AppError('TURNSTILE_RETRY_TOO_SOON', 'turnstile retry too soon', 429)
  }

  try {
    // 2. 记录尝试
    await stub.fetch('http://internal/record-turnstile', { method: 'POST' })

    // 3. 调用 Turnstile API 验证
    const turnstileService = new TurnstileService({
      secret: config.turnstile.secret,
      action: config.turnstile.action,
    })

    const hostname = getRequestHostname(c.req.raw)
    await turnstileService.verify(body.token, hostname)

    // 4. 生成 antibot token 和 nonce
    const antiBotToken = generateSecureToken()
    const nonce = generateSecureToken()

    // 5. 更新会话状态
    const passResp = await stub.fetch('http://internal/pass-turnstile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        antiBotToken,
        nonce,
      }),
    })

    if (!passResp.ok) {
      const error = await passResp.json()
      throw new AppError(error.code, error.info.message, passResp.status)
    }

    const result = await passResp.json<VerifyTurnstileResponse>()

    return c.json(result)
  } finally {
    // 6. 无论成功失败，都要清除 in-flight 标志
    await stub.fetch('http://internal/finish-turnstile', { method: 'POST' })
  }
}

/**
 * POST /api/sessions/:id/verify-telegram - 验证 Telegram OIDC
 */
export async function verifyTelegramToken(
  c: Context<{ Bindings: Env }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('id')
  const body = await c.req.json<VerifyTelegramRequest>()

  if (!body.nonce || !body.id_token) {
    throw new AppError('BAD_REQUEST', 'missing nonce or id_token', 400)
  }

  const stub = getSessionStub(c, sessionId)

  // 1. 检查 antibot token（nonce 来自前端，需要验证会话状态）
  const checkResp = await stub.fetch('http://internal/check-antibot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: body.nonce }), // 这里用 nonce 做简单检查
  })

  const checkResult = await checkResp.json<{ valid: boolean }>()
  if (!checkResult.valid) {
    throw new AppError('INVALID_ANTIBOT_TOKEN', 'invalid antibot token', 401)
  }

  // 2. 验证 Telegram ID Token
  const telegramVerifier = new TelegramVerifier(config.telegram.clientId)
  const user = await telegramVerifier.verify(body.id_token, body.nonce)

  // 3. 生成 PoW token
  const powToken = generateSecureToken()

  // 4. 更新会话状态
  const completeResp = await stub.fetch('http://internal/complete-telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nonce: body.nonce,
      powToken,
      user,
    }),
  })

  if (!completeResp.ok) {
    const error = await completeResp.json()
    throw new AppError(error.code, error.info.message, completeResp.status)
  }

  const result: VerifyTelegramResponse = {
    pow_token: powToken,
  }

  return c.json(result)
}

/**
 * POST /api/sessions/:id/challenge - 获取 PoW challenge
 */
export async function createChallenge(
  c: Context<{ Bindings: Env }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('id')
  const body = await c.req.json<CreateChallengeRequest>()

  if (!body.pow_token) {
    throw new AppError('BAD_REQUEST', 'missing pow_token', 400)
  }

  // 生成 challenge
  const challenge = generateSecureToken()

  const stub = getSessionStub(c, sessionId)

  // 签发 challenge
  const issueResp = await stub.fetch('http://internal/issue-challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      powToken: body.pow_token,
      challenge,
    }),
  })

  if (!issueResp.ok) {
    const error = await issueResp.json()
    throw new AppError(error.code, error.info.message, issueResp.status)
  }

  const result: CreateChallengeResponse = {
    challenge,
    difficulty: config.pow.difficulty,
    maximum_work: config.pow.maximumWork,
  }

  return c.json(result)
}

/**
 * POST /api/sessions/:id/verify-pow - 验证 PoW 解决方案
 */
export async function verifyPoWHandler(
  c: Context<{ Bindings: Env }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('id')
  const body = await c.req.json<VerifyPoWRequest>()

  if (!body.challenge || body.solution === undefined) {
    throw new AppError('BAD_REQUEST', 'missing challenge or solution', 400)
  }

  const stub = getSessionStub(c, sessionId)

  // 1. 验证 challenge 是否匹配
  const hasResp = await stub.fetch('http://internal/has-challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: body.challenge }),
  })

  const hasResult = await hasResp.json<{ valid: boolean }>()
  if (!hasResult.valid) {
    throw new AppError('INVALID_CHALLENGE', 'invalid challenge', 401)
  }

  // 2. 验证 PoW 解决方案
  const valid = await verifyPoW(body.challenge, body.solution, config.pow.difficulty)

  if (!valid) {
    throw new AppError('INVALID_POW_SOLUTION', 'invalid PoW solution', 403)
  }

  // 3. 完成验证，标记会话为 verified
  const completeResp = await stub.fetch('http://internal/complete-challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: body.challenge }),
  })

  if (!completeResp.ok) {
    const error = await completeResp.json()
    throw new AppError(error.code, error.info.message, completeResp.status)
  }

  return c.json({ ok: true })
}
