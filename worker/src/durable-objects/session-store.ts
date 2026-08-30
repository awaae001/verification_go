/**
 * Durable Objects 会话存储
 * 对应 Go 版本的 service/store.go
 * 
 * 每个 SessionStore 实例管理单个会话的状态
 * 提供强一致性的原子性状态转换
 */

import type {
  Session,
  SessionState,
  SessionStatus,
  VerificationStage,
  TelegramUser,
} from '../types/models'
import { AppError } from '../types/models'
import { constantTimeEqual } from '../utils/token'

export interface SessionStoreEnv {
  SESSION_TTL_SECONDS: string
  SESSION_VERIFIED_RETENTION_SECONDS: string
}

export class SessionStore implements DurableObject {
  private state: DurableObjectState
  private env: SessionStoreEnv

  constructor(state: DurableObjectState, env: SessionStoreEnv) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    try {
      // 路由分发
      if (path === '/create' && request.method === 'POST') {
        return await this.createSession(request)
      } else if (path === '/get' && request.method === 'GET') {
        return await this.getSession()
      } else if (path === '/pass-turnstile' && request.method === 'POST') {
        return await this.passTurnstile(request)
      } else if (path === '/check-antibot' && request.method === 'POST') {
        return await this.checkAntiBot(request)
      } else if (path === '/complete-telegram' && request.method === 'POST') {
        return await this.completeTelegram(request)
      } else if (path === '/issue-challenge' && request.method === 'POST') {
        return await this.issueChallenge(request)
      } else if (path === '/has-challenge' && request.method === 'POST') {
        return await this.hasChallenge(request)
      } else if (path === '/complete-challenge' && request.method === 'POST') {
        return await this.completeChallenge(request)
      } else if (path === '/is-active' && request.method === 'GET') {
        return await this.isActive()
      } else if (path === '/begin-turnstile' && request.method === 'POST') {
        return await this.beginTurnstile(request)
      } else if (path === '/record-turnstile' && request.method === 'POST') {
        return await this.recordTurnstileAttempt()
      } else if (path === '/finish-turnstile' && request.method === 'POST') {
        return await this.finishTurnstileAttempt()
      }

      return new Response('Not Found', { status: 404 })
    } catch (err) {
      if (err instanceof AppError) {
        return new Response(
          JSON.stringify({
            code: err.code,
            info: { message: err.message, ...err.info },
          }),
          { status: err.status, headers: { 'Content-Type': 'application/json' } }
        )
      }
      console.error('[session-store] unexpected error:', err)
      return new Response(
        JSON.stringify({
          code: 'INTERNAL_ERROR',
          info: { message: 'internal server error' },
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }

  /**
   * 创建新会话
   */
  private async createSession(request: Request): Promise<Response> {
    const body = await request.json<{
      sessionId: string
      client: string
      expiresAt: number
    }>()

    const existing = await this.state.storage.get<SessionState>('session')
    if (existing) {
      throw new AppError('SESSION_EXISTS', 'session already exists', 409)
    }

    const now = Date.now()
    const session: Session = {
      id: body.sessionId,
      client: body.client,
      status: 'pending',
      createdAt: now,
      expiresAt: body.expiresAt,
    }

    const sessionState: SessionState = {
      session,
      stage: 'created',
      turnstileInFlight: false,
      turnstileAttempts: 0,
    }

    await this.state.storage.put('session', sessionState)

    // 设置自动清理 alarm
    const cleanupAt = body.expiresAt
    await this.state.storage.setAlarm(cleanupAt)

    console.log(`[session-store] created session ${body.sessionId}, expires at ${new Date(cleanupAt).toISOString()}`)

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * 获取会话状态
   */
  private async getSession(): Promise<Response> {
    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      throw new AppError('SESSION_NOT_FOUND', 'session not found', 404)
    }

    const now = Date.now()
    const effectiveStatus = this.getEffectiveStatus(state.session, now)

    return new Response(
      JSON.stringify({
        ...state.session,
        status: effectiveStatus,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }

  /**
   * 检查会话是否处于 active 状态
   */
  private async isActive(): Promise<Response> {
    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      return new Response(JSON.stringify({ active: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const now = Date.now()
    const active = this.getEffectiveStatus(state.session, now) === 'pending'

    return new Response(JSON.stringify({ active }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * 开始 Turnstile 验证尝试（原子性检查）
   */
  private async beginTurnstile(request: Request): Promise<Response> {
    const body = await request.json<{
      maxAttempts: number
      retryIntervalMs: number
    }>()

    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      return new Response(
        JSON.stringify({ result: 'session_inactive' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const now = Date.now()
    if (this.getEffectiveStatus(state.session, now) !== 'pending') {
      return new Response(
        JSON.stringify({ result: 'session_inactive' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    if (state.turnstileInFlight) {
      return new Response(
        JSON.stringify({ result: 'attempt_in_flight' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    if (state.turnstileAttempts >= body.maxAttempts) {
      return new Response(
        JSON.stringify({ result: 'attempts_exhausted' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    if (
      state.turnstileLastAttempt &&
      now - state.turnstileLastAttempt < body.retryIntervalMs
    ) {
      return new Response(
        JSON.stringify({ result: 'retry_too_soon' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // 标记为进行中
    state.turnstileInFlight = true
    await this.state.storage.put('session', state)

    return new Response(
      JSON.stringify({ result: 'started' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  /**
   * 记录 Turnstile 尝试
   */
  private async recordTurnstileAttempt(): Promise<Response> {
    const state = await this.state.storage.get<SessionState>('session')
    if (!state || !state.turnstileInFlight) {
      return new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    state.turnstileAttempts++
    state.turnstileLastAttempt = Date.now()
    await this.state.storage.put('session', state)

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * 结束 Turnstile 尝试
   */
  private async finishTurnstileAttempt(): Promise<Response> {
    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      return new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    state.turnstileInFlight = false
    await this.state.storage.put('session', state)

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Turnstile 验证通过，签发 antibot token 和 nonce
   */
  private async passTurnstile(request: Request): Promise<Response> {
    const body = await request.json<{
      antiBotToken: string
      nonce: string
    }>()

    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      throw new AppError('SESSION_NOT_FOUND', 'session not found', 404)
    }

    const now = Date.now()
    if (this.getEffectiveStatus(state.session, now) !== 'pending') {
      throw new AppError('SESSION_EXPIRED', 'session is expired', 410)
    }

    // 原子性状态转换
    state.stage = 'antibot_passed'
    state.antiBotToken = body.antiBotToken
    state.nonce = body.nonce
    state.powToken = undefined
    state.challenge = undefined
    state.user = undefined
    state.turnstileInFlight = false

    await this.state.storage.put('session', state)

    return new Response(
      JSON.stringify({
        antiBotToken: body.antiBotToken,
        nonce: body.nonce,
        expiresAt: state.session.expiresAt,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }

  /**
   * 检查 antibot token 是否有效
   */
  private async checkAntiBot(request: Request): Promise<Response> {
    const body = await request.json<{ token: string }>()

    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      return new Response(JSON.stringify({ valid: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const now = Date.now()
    if (this.getEffectiveStatus(state.session, now) !== 'pending') {
      return new Response(JSON.stringify({ valid: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 检查 stage 和 token
    const stageValid =
      state.stage === 'antibot_passed' ||
      state.stage === 'telegram_passed' ||
      state.stage === 'challenge_issued'

    const tokenValid =
      state.antiBotToken && constantTimeEqual(state.antiBotToken, body.token)

    return new Response(JSON.stringify({ valid: stageValid && tokenValid }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * 完成 Telegram 验证
   */
  private async completeTelegram(request: Request): Promise<Response> {
    const body = await request.json<{
      nonce: string
      powToken: string
      user: TelegramUser
    }>()

    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      throw new AppError('SESSION_NOT_FOUND', 'session not found', 404)
    }

    const now = Date.now()
    if (this.getEffectiveStatus(state.session, now) !== 'pending') {
      throw new AppError('SESSION_EXPIRED', 'session is expired', 410)
    }

    // 验证状态和 nonce（原子性检查）
    if (state.stage !== 'antibot_passed') {
      throw new AppError('STATE_CONFLICT', 'invalid verification stage', 409)
    }

    if (!state.nonce || !constantTimeEqual(state.nonce, body.nonce)) {
      throw new AppError('INVALID_NONCE', 'invalid nonce', 401)
    }

    // 原子性状态转换
    state.stage = 'telegram_passed'
    state.nonce = undefined // 消费 nonce
    state.powToken = body.powToken
    state.user = body.user

    await this.state.storage.put('session', state)

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * 签发 PoW challenge
   */
  private async issueChallenge(request: Request): Promise<Response> {
    const body = await request.json<{
      powToken: string
      challenge: string
    }>()

    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      throw new AppError('SESSION_NOT_FOUND', 'session not found', 404)
    }

    const now = Date.now()
    if (this.getEffectiveStatus(state.session, now) !== 'pending') {
      throw new AppError('SESSION_EXPIRED', 'session is expired', 410)
    }

    // 验证状态和 powToken
    if (state.stage !== 'telegram_passed') {
      throw new AppError('STATE_CONFLICT', 'invalid verification stage', 409)
    }

    if (!state.powToken || !constantTimeEqual(state.powToken, body.powToken)) {
      throw new AppError('INVALID_POW_TOKEN', 'invalid PoW token', 401)
    }

    // 原子性状态转换
    state.stage = 'challenge_issued'
    state.powToken = undefined // 消费 powToken
    state.challenge = body.challenge

    await this.state.storage.put('session', state)

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * 检查 challenge 是否匹配
   */
  private async hasChallenge(request: Request): Promise<Response> {
    const body = await request.json<{ challenge: string }>()

    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      return new Response(JSON.stringify({ valid: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const now = Date.now()
    const valid =
      this.getEffectiveStatus(state.session, now) === 'pending' &&
      state.stage === 'challenge_issued' &&
      state.challenge !== undefined &&
      constantTimeEqual(state.challenge, body.challenge)

    return new Response(JSON.stringify({ valid }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * 完成 PoW challenge，标记会话为已验证
   */
  private async completeChallenge(request: Request): Promise<Response> {
    const body = await request.json<{ challenge: string }>()

    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      throw new AppError('SESSION_NOT_FOUND', 'session not found', 404)
    }

    const now = Date.now()
    if (this.getEffectiveStatus(state.session, now) !== 'pending') {
      throw new AppError('SESSION_EXPIRED', 'session is expired', 410)
    }

    // 验证状态和 challenge
    if (state.stage !== 'challenge_issued') {
      throw new AppError('STATE_CONFLICT', 'invalid verification stage', 409)
    }

    if (!state.challenge || !constantTimeEqual(state.challenge, body.challenge)) {
      throw new AppError('INVALID_CHALLENGE', 'invalid challenge', 401)
    }

    // 原子性状态转换 - 标记为已验证
    state.stage = 'verified'
    state.challenge = undefined
    state.antiBotToken = undefined
    state.session.status = 'verified'
    state.session.user = state.user
    state.session.verifiedAt = now

    await this.state.storage.put('session', state)

    // 更新 alarm - 已验证会话保留更短时间
    const verifiedRetentionMs =
      parseInt(this.env.SESSION_VERIFIED_RETENTION_SECONDS || '300', 10) * 1000
    const cleanupAt = now + verifiedRetentionMs
    await this.state.storage.setAlarm(cleanupAt)

    console.log(`[session-store] session verified, will cleanup at ${new Date(cleanupAt).toISOString()}`)

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Alarm 处理器 - 自动清理过期会话
   */
  async alarm(): Promise<void> {
    const state = await this.state.storage.get<SessionState>('session')
    if (!state) {
      console.log('[session-store] alarm triggered but no session found')
      return
    }

    const now = Date.now()
    let shouldDelete = false

    if (state.stage === 'verified' && state.session.verifiedAt) {
      const verifiedRetentionMs =
        parseInt(this.env.SESSION_VERIFIED_RETENTION_SECONDS || '300', 10) * 1000
      const removeAt = state.session.verifiedAt + verifiedRetentionMs
      shouldDelete = now >= removeAt
    } else {
      shouldDelete = now >= state.session.expiresAt
    }

    if (shouldDelete) {
      await this.state.storage.deleteAll()
      console.log(`[session-store] cleaned up session ${state.session.id}`)
    }
  }

  /**
   * 获取会话的有效状态
   */
  private getEffectiveStatus(session: Session, now: number): SessionStatus {
    if (session.status === 'pending' && now >= session.expiresAt) {
      return 'expired'
    }
    return session.status
  }
}
