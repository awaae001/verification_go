# 🚀 快速启动指南

## 5 分钟快速部署

### Step 1: 安装依赖 (1 分钟)

```bash
cd d:/Codes/TelegramBots/verification_workers
npm install
```

### Step 2: 配置密钥 (2 分钟)

#### 2.1 生成客户端密钥

```bash
node scripts/generate-keys.js tg_bot
```

复制输出的密钥，稍后使用。

#### 2.2 编辑 wrangler.toml

打开 `wrangler.toml`，替换以下值：

```toml
[vars]
TELEGRAM_CLIENT_ID = "你的_Telegram_Bot_Client_ID"
BASE_URL = "https://你的域名.com"  # 或使用 .workers.dev
TURNSTILE_SITE_KEY = "你的_Turnstile_Site_Key"
```

#### 2.3 设置 Secrets

```bash
# Turnstile Secret
wrangler secret put TURNSTILE_SECRET
# 输入你的 Turnstile Secret Key

# API Key (随机生成)
wrangler secret put API_KEY
# 输入: 任意强密码，例如 openssl rand -base64 32

# 客户端密钥 (使用 Step 2.1 生成的)
wrangler secret put TRUSTED_CLIENT_KEYS
# 输入: tg_bot=刚才生成的密钥
```

### Step 3: 部署 (1 分钟)

```bash
# 检查配置
node scripts/pre-deploy-check.js

# 部署到 Cloudflare
npm run deploy
```

部署成功后会显示 URL：
```
✨ https://telegram-verification.your-subdomain.workers.dev
```

### Step 4: 测试 (1 分钟)

```bash
# 测试健康检查
curl https://telegram-verification.your-subdomain.workers.dev/health

# 应该返回:
# {"status":"ok","timestamp":1735574400000}
```

### Step 5: 更新 Bot 配置

编辑 `tg_bot` 项目的配置文件：

```javascript
// config.js 或 .env
API_BASE_URL=https://telegram-verification.your-subdomain.workers.dev
API_CLIENT_NAME=tg_bot
API_CLIENT_KEY=你在Step2.1生成的密钥
```

重启 Bot：

```bash
cd d:/Codes/TelegramBots/tg_bot
npm restart
```

## ✅ 完成！

现在你的验证系统已经运行在 Cloudflare Workers 上了！

### 验证是否成功

1. Bot 发送新成员加入消息
2. 用户点击验证链接
3. 完成 Turnstile + Telegram + PoW 验证
4. Bot 自动解除用户限制

### 查看实时日志

```bash
wrangler tail
```

### 本地开发

```bash
npm run dev
# 访问 http://localhost:8787
```

## 🆘 遇到问题？

### 问题 1: `wrangler: command not found`

```bash
npm install -g wrangler
wrangler login
```

### 问题 2: 部署时提示 "Durable Objects not found"

```bash
wrangler migrations apply
```

### 问题 3: Secrets 没有生效

```bash
# 检查 secrets
wrangler secret list

# 重新设置
wrangler secret put TURNSTILE_SECRET
```

### 问题 4: 验证页面加载失败

检查 `wrangler.toml` 中的 `BASE_URL` 和 `TURNSTILE_SITE_KEY` 是否正确。

## 📚 更多文档

- [README.md](./README.md) - 完整项目文档
- [DEPLOYMENT.md](./DEPLOYMENT.md) - 详细部署指南
- [MIGRATION.md](./MIGRATION.md) - 迁移说明

## 💰 成本估算

- 前 1000 万请求/月：**免费**
- 超出部分：约 **$1/百万次验证**

比 VPS 节省 **95%** 成本！🎉
