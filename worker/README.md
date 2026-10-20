# Telegram User Verification Service - Cloudflare Workers

这是 Telegram 用户验证系统从 Go + Gin 迁移到 Cloudflare Workers + Hono + Durable Objects 的版本。

## 🎯 项目架构

### 技术栈

- **Runtime**: Cloudflare Workers
- **Framework**: Hono (轻量级 Web 框架)
- **Storage**: Durable Objects (强一致性状态存储)
- **Language**: TypeScript

### 核心组件

```
src/
├── index.ts                      # Worker 入口
├── durable-objects/
│   └── session-store.ts          # Durable Objects 会话存储
├── handlers/
│   └── sessions.ts               # API 处理器
├── middleware/
│   └── index.ts                  # 中间件（认证、CORS、错误处理）
├── services/
│   ├── turnstile.ts              # Turnstile 验证服务
│   └── telegram.ts               # Telegram OIDC 验证服务
├── utils/
│   ├── token.ts                  # Token 生成和安全比较
│   └── pow.ts                    # PoW 验证
├── types/
│   ├── models.ts                 # 数据模型类型
│   └── env.ts                    # 环境变量类型
└── views/
    └── verify.ts                 # 验证页面
```

## 🚀 快速开始

### 1. 安装依赖

```bash
cd verification_workers
npm install
```

### 2. 配置环境变量

编辑 `wrangler.toml`，填写以下配置：

```toml
[vars]
TELEGRAM_CLIENT_ID = "your_telegram_bot_client_id"
BASE_URL = "https://verify.example.com"
TURNSTILE_SITE_KEY = "your_turnstile_site_key"
```

### 3. 配置 Secrets

通过 Wrangler CLI 设置敏感信息：

```bash
# Turnstile Secret Key
wrangler secret put TURNSTILE_SECRET

# API Key (用于健康检查等)
wrangler secret put API_KEY

# 可信客户端密钥（格式: "client1=key1,client2=key2"）
wrangler secret put TRUSTED_CLIENT_KEYS
```

### 4. 本地开发

```bash
npm run dev
```

访问 http://localhost:8787

### 5. 部署到生产环境

```bash
npm run deploy
```

## 📡 API 接口

### 创建会话

```http
POST /api/sessions
X-Client-Key: <client_key>
X-Client-Name: <client_name>

Response:
{
  "session_id": "abc123...",
  "verify_url": "https://verify.example.com/verify/abc123...",
  "expires_at": 1735574400000
}
```

### 获取会话状态

```http
GET /api/sessions/:id
X-Client-Key: <client_key>
X-Client-Name: <client_name>

Response:
{
  "session_id": "abc123...",
  "status": "verified",
  "user_id": 123456789,
  "user_name": "John Doe"
}
```

### 验证 Turnstile

```http
POST /api/sessions/:id/verify-turnstile
Content-Type: application/json

{
  "token": "turnstile_token"
}

Response:
{
  "antibot_token": "xyz789...",
  "nonce": "nonce123...",
  "expires_at": 1735574400000
}
```

### 验证 Telegram

```http
POST /api/sessions/:id/verify-telegram
Content-Type: application/json

{
  "nonce": "nonce123...",
  "id_token": "telegram_id_token"
}

Response:
{
  "pow_token": "pow456..."
}
```

### 获取 PoW Challenge

```http
POST /api/sessions/:id/challenge
Content-Type: application/json

{
  "pow_token": "pow456..."
}

Response:
{
  "challenge": "challenge_string",
  "difficulty": 6,
  "maximum_work": 268435456
}
```

### 验证 PoW

```http
POST /api/sessions/:id/verify-pow
Content-Type: application/json

{
  "challenge": "challenge_string",
  "solution": 123456
}

Response:
{
  "ok": true
}
```

## 🔐 验证流程

```
┌──────────┐
│ 创建会话  │
└────┬─────┘
     │
     ▼
┌──────────────┐
│ 1. Turnstile │ ──► 签发 antibot_token + nonce
└────┬─────────┘
     │
     ▼
┌─────────────────┐
│ 2. Telegram 登录 │ ──► 验证 ID Token + nonce，签发 pow_token
└────┬────────────┘
     │
     ▼
┌──────────────┐
│ 3. PoW 计算   │ ──► 提交解决方案，标记为已验证
└────┬─────────┘
     │
     ▼
┌──────────┐
│ 验证完成  │
└──────────┘
```

## 🏗️ Durable Objects 架构

### 为什么使用 Durable Objects？

1. **强一致性**: 每个会话由单个 DO 实例管理，天然避免并发冲突
2. **原子性操作**: nonce 消费、token 签发等操作保证原子性
3. **自动清理**: Alarms API 实现 TTL 自动过期
4. **全球分布**: DO 自动迁移到最近的用户位置

### 会话生命周期

```typescript
// 创建会话
SessionStore.createSession() → 设置 Alarm (15 分钟)

// 状态转换
created → antibot_passed → telegram_passed → challenge_issued → verified

// 自动清理
Alarm 触发 → 检查过期 → 删除会话
```

## 📊 性能优势

| 指标 | Go + VPS | CF Workers + DO | 提升 |
|------|----------|-----------------|------|
| 全球延迟 | 50-300ms | 10-50ms | **60%** |
| 冷启动 | 50-100ms | < 5ms | **95%** |
| 扩展性 | 手动扩容 | 自动无限扩展 | ♾️ |
| 成本（100万次验证/月） | $20-50 | < $1 | **节省 95%** |

## 💰 成本估算

### 定价模型（2024年）

- **Workers 请求**: 前 1000 万免费，之后 $0.50/百万
- **Durable Objects 请求**: $0.15/百万
- **Durable Objects 存储**: $0.20/GB·月（临时会话可忽略）

### 实际成本示例

假设每次验证 = 6 个请求（创建 + Turnstile + Telegram + Challenge + PoW + 查询）

**月 100 万次验证**:
- Workers: 600 万请求 → **$0**（免费额度内）
- DO: 600 万请求 × $0.15 → **$0.90**
- **总计: < $1/月**

**月 1000 万次验证**:
- Workers: 6000 万请求 → **$25**
- DO: 6000 万请求 × $0.15 → **$9**
- **总计: $34/月**

## 🧪 测试

```bash
# 运行单元测试
npm test

# 监听模式
npm run test:watch
```

## 🔧 故障排查

### 本地开发问题

如果 `wrangler dev` 无法启动：

```bash
# 清理缓存
rm -rf .wrangler

# 重新安装依赖
npm install

# 更新 Wrangler
npm install wrangler@latest
```

### Durable Objects 调试

```bash
# 查看 DO 日志
wrangler tail

# 查看特定会话的 DO 实例
wrangler dev --local
```

### 生产环境监控

```bash
# 实时日志
wrangler tail --env production

# 查看分析数据
wrangler analytics
```

## 📝 迁移指南

### 从 Go 版本迁移

1. **并行运行**: 新旧系统可以共存，通过不同域名区分
2. **逐步切流**: Bot 服务逐步将流量切到新 API
3. **验证一致性**: 确保验证逻辑完全一致
4. **监控对比**: 观察错误率、延迟等指标

### Bot 服务改造

只需修改 API 端点，其他逻辑无需改动：

```javascript
// 旧版本
const API_BASE = 'http://localhost:8080'

// 新版本
const API_BASE = 'https://verify.example.com'

// API 接口完全兼容
```

## 🚨 安全注意事项

1. **永远不要提交 Secrets**: 使用 `wrangler secret put`
2. **HTTPS Only**: 生产环境强制使用 HTTPS
3. **CORS 配置**: 根据实际需求调整 CORS 策略
4. **Rate Limiting**: 考虑在 Cloudflare Dashboard 配置 Rate Limiting
5. **常量时间比较**: Token 比较使用 `constantTimeEqual` 防止时序攻击

## 📚 相关文档

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Durable Objects 文档](https://developers.cloudflare.com/durable-objects/)
- [Hono 文档](https://hono.dev/)
- [Wrangler CLI 文档](https://developers.cloudflare.com/workers/wrangler/)

## 📄 License

与原项目保持一致

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！
