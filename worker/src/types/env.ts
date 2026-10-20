/**
 * Cloudflare Workers 环境绑定类型定义
 */

export interface Env {
  // Durable Objects
  SESSIONS: DurableObjectNamespace
  RATE_LIMITER: DurableObjectNamespace

  // Environment Variables
  TELEGRAM_CLIENT_ID: string
  BASE_URL: string
  TURNSTILE_SITE_KEY: string
  TURNSTILE_ACTION: string
  POW_DIFFICULTY: string
  POW_MAXIMUM_WORK: string
  SESSION_TTL_SECONDS: string
  SESSION_VERIFIED_RETENTION_SECONDS: string
  SESSION_MAX_TOTAL: string
  SESSION_MAX_PER_CLIENT: string
  TURNSTILE_MAX_CONCURRENT: string
  TURNSTILE_MAX_PER_MINUTE: string
  TURNSTILE_MAX_ATTEMPTS: string
  TURNSTILE_RETRY_INTERVAL_MS: string

  // Secrets
  TURNSTILE_SECRET: string
  TRUSTED_CLIENT_KEYS: string
}

// Hono Context Variables
export interface Variables {
  client: string
}

export interface Config {
  telegram: {
    clientId: string
  }
  turnstile: {
    siteKey: string
    secret: string
    action: string
    maxConcurrent: number
    maxPerMinute: number
    maxAttempts: number
    retryIntervalMs: number
  }
  pow: {
    difficulty: number
    maximumWork: number
  }
  session: {
    ttlSeconds: number
    verifiedRetentionSeconds: number
    maxTotal: number
    maxPerClient: number
  }
  baseUrl: string
  trustedClients: Map<string, string>
}

export function parseConfig(env: Env): Config {
  // 解析 TRUSTED_CLIENT_KEYS: "client1=key1,client2=key2"
  const trustedClients = new Map<string, string>()
  if (env.TRUSTED_CLIENT_KEYS) {
    env.TRUSTED_CLIENT_KEYS.split(',').forEach((pair) => {
      const [name, key] = pair.split('=').map((s) => s.trim())
      if (name && key) {
        trustedClients.set(name, key)
      }
    })
  }

  return {
    telegram: {
      clientId: env.TELEGRAM_CLIENT_ID,
    },
    turnstile: {
      siteKey: env.TURNSTILE_SITE_KEY,
      secret: env.TURNSTILE_SECRET,
      action: env.TURNSTILE_ACTION || 'verify',
      maxConcurrent: parseInt(env.TURNSTILE_MAX_CONCURRENT || '32', 10),
      maxPerMinute: parseInt(env.TURNSTILE_MAX_PER_MINUTE || '300', 10),
      maxAttempts: parseInt(env.TURNSTILE_MAX_ATTEMPTS || '5', 10),
      retryIntervalMs: parseInt(env.TURNSTILE_RETRY_INTERVAL_MS || '1000', 10),
    },
    pow: {
      difficulty: parseInt(env.POW_DIFFICULTY || '6', 10),
      maximumWork: parseInt(env.POW_MAXIMUM_WORK || '268435456', 10),
    },
    session: {
      ttlSeconds: parseInt(env.SESSION_TTL_SECONDS || '900', 10),
      verifiedRetentionSeconds: parseInt(env.SESSION_VERIFIED_RETENTION_SECONDS || '300', 10),
      maxTotal: parseInt(env.SESSION_MAX_TOTAL || '10000', 10),
      maxPerClient: parseInt(env.SESSION_MAX_PER_CLIENT || '1000', 10),
    },
    baseUrl: env.BASE_URL,
    trustedClients,
  }
}
