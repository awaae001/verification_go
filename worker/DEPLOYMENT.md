# Cloudflare Workers 迁移部署指南

## 📋 前置准备

### 1. 创建 Cloudflare 账号

访问 https://dash.cloudflare.com 注册账号（免费）

### 2. 安装 Wrangler CLI

```bash
npm install -g wrangler

# 登录 Cloudflare
wrangler login
```

### 3. 获取 Telegram Bot Client ID

访问 [@BotFather](https://t.me/BotFather) 创建 Bot，拿到形如
`1234567890:ABCdefGHIjklMNOpqrsTUVwxyz` 的 Bot Token。

**Client ID 就是 Token 冒号前面那段纯数字**（上例中为 `1234567890`），也叫 Bot ID。

> ⚠️ 不要把完整的 Bot Token 填进 `TELEGRAM_CLIENT_ID`：
> 一是 Telegram OAuth 的 `bot_id` 参数只接受纯数字，填错会导致登录流程失败；
> 二是 `[vars]` 是明文配置，会把 Token 泄露出去。
> 本项目根本不需要 Bot Token —— 发消息/踢人由 `tg_bot_workers` 负责，
> Token 在那边以 secret 形式配置。

另外需要在 BotFather 里给 Bot 绑定登录域名，否则 OAuth 会被拒绝：

```
/mybots → 选择你的 Bot → Bot Settings → Domain → 填入 BASE_URL 的域名
```

### 4. 创建 Turnstile Site Key

访问 Cloudflare Dashboard：
1. 左侧菜单 → Turnstile
2. Create Site
3. 填写域名（开发时可用 `localhost`）
4. 记录 Site Key 和 Secret Key

## 🚀 部署步骤

### 第 1 步：安装依赖

```bash
cd d:/Codes/TelegramBots/verification_workers
npm install
```

### 第 2 步：配置 wrangler.toml

编辑 `wrangler.toml`，替换以下三个占位符（其余项保持默认即可）：

```toml
[vars]
TELEGRAM_CLIENT_ID = "1234567890"              # Bot Token 冒号前的纯数字，不是完整 Token
BASE_URL = "https://verify.yourdomain.com"     # 本 Worker 的对外地址，末尾不加 /
TURNSTILE_SITE_KEY = "0x4AAAAAAA..."           # Turnstile Site Key（公开值）
```

> ⚠️ `wrangler.toml` 里定义了 `[env.dev]` 和 `[env.production]` 两个命名环境。
> wrangler **不会**把顶层 `[vars]` 继承给命名环境，所以如果你用
> `--env production` 部署，必须同时改 `[env.production.vars]` 下的同名配置。

### 第 3 步：设置 Secrets

```bash
# Turnstile Secret Key（Turnstile 后台与 Site Key 成对给出）
wrangler secret put TURNSTILE_SECRET

# 可信客户端密钥，格式: "客户端名=密钥,客户端名2=密钥2"
# 这里的「客户端名」对应调用方请求头 X-Client-Name，密钥对应 X-Client-Key
# 例如: tg_bot=<openssl rand -base64 32 的输出>
wrangler secret put TRUSTED_CLIENT_KEYS
```

> 部署到命名环境时要带上 `--env`，secret 是按环境隔离的：
> `wrangler secret put TURNSTILE_SECRET --env production`

> 说明：`API_KEY` 曾出现在旧文档和 `src/types/env.ts` 里，但当前代码中
> **没有任何地方读取它**（鉴权统一走 `TRUSTED_CLIENT_KEYS`），因此无需设置。

### 第 4 步：本地测试

```bash
npm run dev
```

在浏览器中访问：
- 健康检查: http://localhost:8787/health
- 测试验证页面: http://localhost:8787/verify/test123

### 第 5 步：部署到生产环境

```bash
# 首次部署
npm run deploy

# 或使用 Wrangler 直接部署
wrangler deploy
```

部署成功后，你会看到类似输出：

```
Published telegram-verification (1.23 sec)
  https://telegram-verification.your-subdomain.workers.dev
```

### 第 6 步：配置自定义域名（可选）

1. 进入 Cloudflare Dashboard
2. 选择你的 Worker
3. Settings → Triggers → Custom Domains
4. 添加域名（例如 `verify.yourdomain.com`）

### 第 7 步：更新 Bot 服务配置

Bot 侧（`tg_bot_workers`）在 `wrangler.toml` 的 `[vars]` 里配置地址：

```toml
VERIFY_API_BASE_URL = "https://verify.yourdomain.com"
```

密钥走 secret，值必须与本服务 `TRUSTED_CLIENT_KEYS` 中某一项的密钥部分完全一致：

```bash
cd ../tg_bot_workers
wrangler secret put VERIFY_CLIENT_KEY
```

## ✅ 验证部署

### 测试健康检查

```bash
curl https://verify.yourdomain.com/health
```

期望输出：
```json
{
  "status": "ok",
  "timestamp": 1735574400000
}
```

### 测试创建会话

```bash
curl -X POST https://verify.yourdomain.com/api/sessions \
  -H "Content-Type: application/json" \
  -H "X-Client-Name: tg_bot" \
  -H "X-Client-Key: your_secure_key_here"
```

期望输出：
```json
{
  "session_id": "abc123...",
  "verify_url": "https://verify.yourdomain.com/verify/abc123...",
  "expires_at": 1735574400000
}
```

### 测试验证页面

在浏览器中访问返回的 `verify_url`，应该看到验证界面。

## 🔍 监控和日志

### 实时日志

```bash
# 查看实时日志
wrangler tail

# 查看生产环境日志
wrangler tail --env production

# 过滤错误日志
wrangler tail --status error
```

### 性能分析

```bash
# 查看分析数据
wrangler analytics
```

或访问 Cloudflare Dashboard → Workers & Pages → Analytics

## 🐛 故障排查

### 问题 1: Durable Objects 创建失败

**错误信息**: `Durable Object namespace not found`

**解决方案**:
```bash
# 确保已运行迁移
wrangler migrations apply
```

### 问题 2: Secrets 未生效

**错误信息**: `TURNSTILE_SECRET is undefined`

**解决方案**:
```bash
# 检查 secrets
wrangler secret list

# 重新设置
wrangler secret put TURNSTILE_SECRET
```

### 问题 3: CORS 错误

**错误信息**: `CORS policy blocked`

**解决方案**: 检查 `src/middleware/index.ts` 中的 CORS 配置，确保包含你的域名。

### 问题 4: 验证页面无法加载

检查 `wrangler.toml` 中的 `BASE_URL` 是否正确设置。

## 📊 成本优化建议

### 开发环境

使用免费的 `.workers.dev` 域名，无需额外费用。

### 生产环境

1. **合理设置 TTL**: 避免会话存储时间过长
2. **启用 Caching**: 静态资源使用 Cache API
3. **监控使用量**: 定期检查 Workers 和 DO 使用量

## 🔄 回滚策略

如果新版本出现问题，可以快速回滚：

```bash
# 查看部署历史
wrangler deployments list

# 回滚到上一个版本
wrangler rollback --message "Rolling back due to issue"
```

## 📈 扩展建议

### 1. 添加速率限制

在 Cloudflare Dashboard 配置 Rate Limiting：
- API 端点: 100 请求/分钟
- 验证页面: 10 请求/分钟

### 2. 启用 WAF

Cloudflare Dashboard → Security → WAF
- 启用 OWASP 规则集
- 自定义规则阻止异常流量

### 3. 配置告警

Cloudflare Dashboard → Notifications
- Worker 错误率超过阈值
- DO 请求量异常

### 4. 集成 Analytics

```typescript
// 在 src/index.ts 添加
app.use('*', async (c, next) => {
  await next()
  // 发送自定义指标到 Workers Analytics Engine
})
```

## 🎉 部署完成检查清单

- [ ] 依赖已安装
- [ ] wrangler.toml 已配置
- [ ] Secrets 已设置
- [ ] 本地测试通过
- [ ] 生产环境部署成功
- [ ] 自定义域名已配置
- [ ] 健康检查正常
- [ ] API 端点可访问
- [ ] 验证页面正常显示
- [ ] Bot 服务已更新配置
- [ ] 监控和告警已配置

---

🎊 恭喜！您已成功将 Telegram 用户验证系统迁移到 Cloudflare Workers！
