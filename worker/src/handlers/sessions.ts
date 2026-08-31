/**
 * API 处理器 - 会话管理
 * 对应 Go 版本的 handler
 */

import type { Context } from 'hono'
import type { Env, Config, Variables } from '../types/env'
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
  ErrorResponse,
} from '../types/models'
import { AppError } from '../types/models'
import { generateSecureToken } from '../utils/token'
import { TurnstileService, getRequestHostname } from '../services/turnstile'
import { TelegramVerifier } from '../services/telegram'
import { verifyPoW } from '../utils/pow'

/**
 * 获取会话对应的 Durable Object stub
 */
function getSessionStub(c: Context<{ Bindings: Env; Variables: Variables }>, sessionId: string) {
  const id = c.env.SESSIONS.idFromName(sessionId)
  return c.env.SESSIONS.get(id)
}

/**
 * POST /api/sessions - 创建新会话
 */
export async function createSession(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  config: Config
): Promise<Response> {
  const client = c.get('client')

  // 生成会话 ID
  const sessionId = generateSecureToken()

  // 计算过期时间（对齐 Go: Unix 秒，handler/session.go:57）
  const now = Date.now()
  const expiresAt = Math.floor(now / 1000) + config.session.ttlSeconds

  // 获取会话的 Durable Object
  const stub = getSessionStub(c, sessionId)

  // 创建会话（DO 内部存储时会转为毫秒）
  const response = await stub.fetch('http://internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      client,
      expiresAt: expiresAt * 1000, // DO 内部用毫秒存储
    }),
  })

  if (!response.ok) {
    const error = (await response.json()) as any
    throw new AppError(error.code, error.info.message, response.status)
  }

  // 生成验证 URL（对齐 Go 的 /v/:id 路径）
  const verifyUrl = `${config.baseUrl}/v/${sessionId}`

  const result: CreateSessionResponse = {
    session_id: sessionId,
    verify_url: verifyUrl,
    expires_at: expiresAt,
  }

  return c.json(result, 201)
}

/**
 * GET /api/sessions/:sid/status - 获取会话状态
 */
export async function getSessionStatus(
  c: Context<{ Bindings: Env; Variables: Variables }>
): Promise<Response> {
  const sessionId = c.req.param('sid')!
  const client = c.get('client')

  const stub = getSessionStub(c, sessionId)
  const response = await stub.fetch('http://internal/get')

  if (!response.ok) {
    const error = (await response.json()) as any
    throw new AppError(error.code, error.info.message, response.status)
  }

  const session = (await response.json()) as any

  // 对齐 Go: 校验会话归属（handler/session.go:35-37）
  if (session.client !== client) {
    throw new AppError('SESSION_NOT_FOUND', 'session not found', 404)
  }

  const result: SessionStatusResponse = {
    session_id: session.id,
    status: session.status,
    user_id: session.user?.id,
    user_name: session.user?.name,
  }

  return c.json(result)
}

/**
 * POST /api/sessions/:sid/antibot - 验证 Turnstile
 */
export async function verifyTurnstile(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('sid')!
  const body = await c.req.json<VerifyTurnstileRequest>()

  if (!body.token) {
    throw new AppError('INVALID_REQUEST', 'missing turnstile token', 400)
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
    throw new AppError('STATE_CONFLICT', 'turnstile verification in progress', 409)
  }
  if (beginResult.result === 'attempts_exhausted') {
    throw new AppError(
      'TURNSTILE_ATTEMPTS_EXHAUSTED',
      'turnstile attempts exhausted',
      409
    )
  }
  if (beginResult.result === 'retry_too_soon') {
    throw new AppError('RATE_LIMITED', 'turnstile retry too soon', 429)
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
      const error = (await passResp.json()) as any
      throw new AppError(error.code, error.info.message, passResp.status)
    }

    const doResult = await passResp.json<{
      antiBotToken: string
      nonce: string
      expiresAt: number
    }>()

    // 对齐 Go: expires_at 返回 Unix 秒（turnstile.go:145）
    const result: VerifyTurnstileResponse = {
      antibot_token: doResult.antiBotToken,
      nonce: doResult.nonce,
      expires_at: Math.floor(doResult.expiresAt / 1000),
    }

    return c.json(result)
  } finally {
    // 6. 无论成功失败，都要清除 in-flight 标志
    await stub.fetch('http://internal/finish-turnstile', { method: 'POST' })
  }
}

/**
 * POST /api/sessions/:sid/telegram - 验证 Telegram OIDC
 */
export async function verifyTelegramToken(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('sid')!
  const body = await c.req.json<VerifyTelegramRequest>()

  if (!body.nonce || !body.id_token) {
    throw new AppError('INVALID_REQUEST', 'missing nonce or id_token', 400)
  }

  const stub = getSessionStub(c, sessionId)

  // 1. 验证 Telegram ID Token
  const telegramVerifier = new TelegramVerifier(config.telegram.clientId)
  const user = await telegramVerifier.verify(body.id_token, body.nonce)

  // 2. 生成 PoW token
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
    const error = (await completeResp.json()) as any
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
  c: Context<{ Bindings: Env; Variables: Variables }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('sid') as string
  const body = await c.req.json<CreateChallengeRequest>()

  if (!body.pow_token) {
    throw new AppError('INVALID_REQUEST', 'missing pow_token', 400)
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
    const error = (await issueResp.json()) as ErrorResponse
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
  c: Context<{ Bindings: Env; Variables: Variables }>,
  config: Config
): Promise<Response> {
  const sessionId = c.req.param('sid') as string
  const body = await c.req.json<VerifyPoWRequest>()

  if (!body.challenge || body.solution === undefined || body.solution === null) {
    throw new AppError('INVALID_REQUEST', 'invalid request', 400)
  }

  // 1. solution 必须落在工作空间内（对齐 Go handler/pow.go:47）
  if (
    !Number.isInteger(body.solution) ||
    body.solution < 0 ||
    body.solution >= config.pow.maximumWork
  ) {
    throw new AppError('POW_SOLUTION_INVALID', 'solution is outside the work space', 422)
  }

  const stub = getSessionStub(c, sessionId)

  // 2. challenge 必须存在且未被消费
  const hasResp = await stub.fetch('http://internal/has-challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: body.challenge }),
  })

  const hasResult = await hasResp.json<{ valid: boolean }>()
  if (!hasResult.valid) {
    throw new AppError(
      'STATE_CONFLICT',
      'challenge is missing, expired, or already consumed',
      409
    )
  }

  // 3. 校验 PoW 解
  const valid = await verifyPoW(body.challenge, body.solution, config.pow.difficulty)

  if (!valid) {
    throw new AppError('POW_SOLUTION_INVALID', 'incorrect PoW solution', 422)
  }

  // 4. 消费 challenge 并将会话标记为 verified
  const completeResp = await stub.fetch('http://internal/complete-challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: body.challenge }),
  })

  if (!completeResp.ok) {
    throw new AppError('STATE_CONFLICT', 'challenge was already consumed', 409)
  }

  // Go 侧返回 204 No Content
  return c.body(null, 204)
}
