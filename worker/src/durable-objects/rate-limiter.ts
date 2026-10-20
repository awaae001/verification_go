/**
 * Durable Object - 全局限速器
 * 
 * 对齐 Go 版本两个全局限制：
 * 1. 会话容量限制（store.go:90-106, maxSessions + maxSessionsPerClient）
 * 2. Turnstile 全局并发 + 令牌桶速率限制（turnstile.go:72-77,104-117）
 * 
 * 使用单例 DO（固定 ID）保证全局一致计数。
 * 内部使用 transactional storage 保证原子性。
 */

export interface RateLimiterEnv {
  // 无额外 env，配置通过请求体传入
}

// 过期清理间隔（毫秒）
const CLEANUP_INTERVAL_MS = 60_000
// 并发 slot 最大占用时间（毫秒），超时自动释放
const SLOT_TIMEOUT_MS = 30_000

interface SessionCounters {
  total: number
  perClient: Record<string, number>
  lastCleanup: number
}

interface TurnstileState {
  // 令牌桶
  rateLimit: number
  rateTokens: number
  rateUpdated: number // epoch ms
  // 并发计数
  activeSlots: number
  // slot 跟踪：sessionId -> acquisition time
  slotHolders: Record<string, number>
}

export class RateLimiter implements DurableObject {
  private state: DurableObjectState

  constructor(state: DurableObjectState, _env: RateLimiterEnv) {
    this.state = state
    // 定期清理过期 session 计数
    this.state.blockConcurrencyWhile(async () => {
      const counters = await this.state.storage.get<SessionCounters>('sessionCounters')
      if (!counters) {
        await this.state.storage.put('sessionCounters', {
          total: 0,
          perClient: {},
          lastCleanup: Date.now(),
        })
      }
      const ts = await this.state.storage.get<TurnstileState>('turnstileState')
      if (!ts) {
        await this.state.storage.put('turnstileState', {
          rateLimit: 0,
          rateTokens: 0,
          rateUpdated: 0,
          activeSlots: 0,
          slotHolders: {},
        })
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    try {
      if (path === '/acquire-session' && request.method === 'POST') {
        return await this.acquireSession(request)
      } else if (path === '/release-session' && request.method === 'POST') {
        return await this.releaseSession(request)
      } else if (path === '/acquire-turnstile' && request.method === 'POST') {
        return await this.acquireTurnstile(request)
      } else if (path === '/release-turnstile' && request.method === 'POST') {
        return await this.releaseTurnstile(request)
      } else if (path === '/cleanup' && request.method === 'POST') {
        return await this.cleanupExpiredSessions(request)
      }

      return new Response('Not Found', { status: 404 })
    } catch (err) {
      console.error('[rate-limiter] error:', err)
      return new Response(
        JSON.stringify({ ok: false, error: 'internal_error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }

  /**
   * 获取会话配额
   * 对齐 Go store.go:90-106:
   *   - 全局 maxSessions 限制
   *   - 每 client maxSessionsPerClient 限制
   */
  private async acquireSession(request: Request): Promise<Response> {
    const body = await request.json<{
      client: string
      maxTotal: number
      maxPerClient: number
    }>()

    const now = Date.now()
    const counters = await this.state.storage.get<SessionCounters>('sessionCounters')
    if (!counters) {
      return new Response(
        JSON.stringify({ ok: false, error: 'internal_error' }),
        { status: 500 }
      )
    }

    // 定期清理过期计数（每 60s 一次）
    if (now - counters.lastCleanup > CLEANUP_INTERVAL_MS) {
      // 清理只能由 DO alarm 或外部触发，这里只更新时间戳
      counters.lastCleanup = now
    }

    // 检查全局上限
    if (counters.total >= body.maxTotal) {
      return new Response(
        JSON.stringify({ ok: false, error: 'session_capacity' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // 检查每 client 上限
    const clientCount = counters.perClient[body.client] || 0
    if (clientCount >= body.maxPerClient) {
      return new Response(
        JSON.stringify({ ok: false, error: 'client_session_capacity' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // 配额获取成功，增加计数
    counters.total++
    counters.perClient[body.client] = clientCount + 1
    await this.state.storage.put('sessionCounters', counters)

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  /**
   * 释放会话配额（会话过期/完成时调用）
   */
  private async releaseSession(request: Request): Promise<Response> {
    const body = await request.json<{ client: string }>()

    const counters = await this.state.storage.get<SessionCounters>('sessionCounters')
    if (!counters) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    counters.total = Math.max(0, counters.total - 1)
    const clientCount = counters.perClient[body.client] || 0
    if (clientCount > 0) {
      counters.perClient[body.client] = clientCount - 1
      if (counters.perClient[body.client] === 0) {
        delete counters.perClient[body.client]
      }
    }

    await this.state.storage.put('sessionCounters', counters)

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  /**
   * 获取 Turnstile 验证配额
   * 对齐 Go turnstile.go:104-117:
   *   1. 并发 slot 检查（MaxConcurrent，非阻塞，满则拒绝）
   *   2. 令牌桶速率检查（MaxVerificationsPerMinute）
   * 返回 { ok: true, slotId } 或 { ok: false, error: 'rate_limited' }
   */
  private async acquireTurnstile(request: Request): Promise<Response> {
    const body = await request.json<{
      maxConcurrent: number
      maxPerMinute: number
      sessionId: string
    }>()

    const now = Date.now()
    const ts = await this.state.storage.get<TurnstileState>('turnstileState')
    if (!ts) {
      return new Response(
        JSON.stringify({ ok: false, error: 'internal_error' }),
        { status: 500 }
      )
    }

    // 更新令牌桶配置（如果变化）
    if (ts.rateLimit !== body.maxPerMinute) {
      ts.rateLimit = body.maxPerMinute
      if (ts.rateTokens === 0 && ts.rateUpdated === 0) {
        // 首次初始化
        ts.rateTokens = body.maxPerMinute
        ts.rateUpdated = now
      }
    }

    // 清理超时的 slot 持有者（超过 SLOT_TIMEOUT_MS 自动释放）
    const expiredSlots: string[] = []
    for (const [sid, acquiredAt] of Object.entries(ts.slotHolders)) {
      if (now - acquiredAt > SLOT_TIMEOUT_MS) {
        expiredSlots.push(sid)
      }
    }
    for (const sid of expiredSlots) {
      delete ts.slotHolders[sid]
      ts.activeSlots = Math.max(0, ts.activeSlots - 1)
    }

    // 1. 并发 slot 检查（非阻塞，对齐 Go 的 select-default 模式）
    if (ts.activeSlots >= body.maxConcurrent) {
      return new Response(
        JSON.stringify({ ok: false, error: 'capacity' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // 2. 令牌桶速率检查
    // 对齐 Go allowVerification: 基于时间差补充令牌
    if (ts.rateUpdated > 0 && now > ts.rateUpdated) {
      const elapsedMinutes = (now - ts.rateUpdated) / 60000
      const refill = elapsedMinutes * ts.rateLimit
      ts.rateTokens = Math.min(ts.rateLimit, ts.rateTokens + refill)
      ts.rateUpdated = now
    } else if (ts.rateUpdated === 0) {
      ts.rateUpdated = now
    }

    if (ts.rateTokens < 1) {
      return new Response(
        JSON.stringify({ ok: false, error: 'rate_limited' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // 消费令牌 + 占用 slot
    ts.rateTokens -= 1
    ts.activeSlots++
    ts.slotHolders[body.sessionId] = now

    await this.state.storage.put('turnstileState', ts)

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  /**
   * 释放 Turnstile 并发 slot
   */
  private async releaseTurnstile(request: Request): Promise<Response> {
    const body = await request.json<{ sessionId: string }>()

    const ts = await this.state.storage.get<TurnstileState>('turnstileState')
    if (!ts) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    if (ts.slotHolders[body.sessionId] !== undefined) {
      delete ts.slotHolders[body.sessionId]
      ts.activeSlots = Math.max(0, ts.activeSlots - 1)
      await this.state.storage.put('turnstileState', ts)
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  /**
   * 清理过期 session 计数
   * 由外部定时触发或 DO alarm 触发
   */
  private async cleanupExpiredSessions(request: Request): Promise<Response> {
    const body = await request.json<{
      expiredClients: Array<{ client: string }>
    }>()

    const counters = await this.state.storage.get<SessionCounters>('sessionCounters')
    if (!counters) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    for (const { client } of body.expiredClients) {
      const count = counters.perClient[client] || 0
      if (count > 0) {
        counters.total = Math.max(0, counters.total - 1)
        counters.perClient[client] = count - 1
        if (counters.perClient[client] === 0) {
          delete counters.perClient[client]
        }
      }
    }

    counters.lastCleanup = Date.now()
    await this.state.storage.put('sessionCounters', counters)

    return new Response(
      JSON.stringify({ ok: true, remaining: counters.total }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  /**
   * Alarm - 定期清理过期 slot
   */
  async alarm(): Promise<void> {
    const now = Date.now()
    const ts = await this.state.storage.get<TurnstileState>('turnstileState')
    if (!ts) return

    // 清理超时 slot
    let changed = false
    for (const [sid, acquiredAt] of Object.entries(ts.slotHolders)) {
      if (now - acquiredAt > SLOT_TIMEOUT_MS) {
        delete ts.slotHolders[sid]
        ts.activeSlots = Math.max(0, ts.activeSlots - 1)
        changed = true
      }
    }
    if (changed) {
      await this.state.storage.put('turnstileState', ts)
    }

    // 设置下次 alarm（30s 后）
    this.state.storage.setAlarm(now + 30_000)
  }
}
