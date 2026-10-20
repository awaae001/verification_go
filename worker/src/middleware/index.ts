/**
 * Hono 中间件
 * 对应 Go 版本的 middleware
 */

import type { Context, Next } from 'hono'
import type { Env, Config, Variables } from '../types/env'
import { AppError } from '../types/models'
import { constantTimeEqual } from '../utils/token'

/**
 * 客户端认证中间件
 * 仅验证 X-Client-Key header，客户端名称由 key 反查得出
 * 对应 Go 版 middleware.ClientAuth + Config.IsTrustedClient
 */
export function clientAuth(config: Config) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const clientKey = c.req.header('X-Client-Key') ?? ''

    // 遍历全部可信客户端做常量时间比较，避免因提前返回泄露信息
    let matched: string | null = null
    for (const [name, configuredKey] of config.trustedClients) {
      if (constantTimeEqual(configuredKey, clientKey)) {
        matched = name
        break
      }
    }

    if (matched === null) {
      throw new AppError('UNAUTHORIZED_CLIENT', 'invalid client key', 401)
    }

    // 将客户端名称存储到上下文
    c.set('client', matched)

    await next()
  }
}

/**
 * CORS 中间件
 */
export function cors() {
  return async (c: Context, next: Next) => {
    // 处理预检请求
    if (c.req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Client-Key, X-Client-Name',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    await next()

    // 添加 CORS headers
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Content-Type, X-Client-Key, X-Client-Name')
  }
}

/**
 * 错误处理中间件
 */
export function errorHandler() {
  return async (c: Context, next: Next) => {
    try {
      await next()
    } catch (err) {
      if (err instanceof AppError) {
        return c.json(
          {
            code: err.code,
            info: {
              message: err.message,
              ...err.info,
            },
          },
          err.status as any
        )
      }

      console.error('[error] unhandled error:', err)
      return c.json(
        {
          code: 'INTERNAL_ERROR',
          info: {
            message: 'internal server error',
          },
        },
        500
      )
    }
  }
}

/**
 * 请求日志中间件
 */
export function logger() {
  return async (c: Context, next: Next) => {
    const start = Date.now()
    const method = c.req.method
    const path = c.req.path

    await next()

    const duration = Date.now() - start
    const status = c.res.status

    console.log(`[${method}] ${path} ${status} ${duration}ms`)
  }
}

/**
 * Antibot 中间件 - 对应 Go 的 middleware.AntiBot.Protect
 * 验证 X-Anti-Bot-Token header，拒绝无效 token 的浏览器验证请求
 */
export function antibotProtect() {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const token = c.req.header('X-Anti-Bot-Token') ?? ''
    const sessionId = c.req.param('sid')!

    // 获取会话 DO
    const id = c.env.SESSIONS.idFromName(sessionId)
    const stub = c.env.SESSIONS.get(id)

    // 调用 DO 的 check-antibot RPC
    const checkResp = await stub.fetch('http://internal/check-antibot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    const result = await checkResp.json<{ valid: boolean }>()
    if (!result.valid) {
      throw new AppError('ANTIBOT_REQUIRED', 'invalid anti-bot token', 401)
    }

    await next()
  }
}
