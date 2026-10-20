# Telegram 群组入群验证服务

一个基于 Go 的 Telegram 群组入群验证后端服务，提供多种验证方式（Cloudflare Turnstile、Telegram Mini App、PoW 工作量证明）来防止机器人和恶意用户进入群组。

## 项目简介

本项目是一个独立的 Web 服务，配合 Telegram Bot 使用，为 Telegram 群组提供强大的入群验证功能。当用户加入群组时，Bot 会限制其权限并发送验证链接，用户需要在限定时间内完成验证才能正常发言。

### 核心特性

- **多种验证方式**
  - 🛡️ Cloudflare Turnstile 人机验证
  - 📱 Telegram Mini App 登录验证（确保 Telegram 账号真实性）
  - ⚡ PoW（工作量证明）备用验证
  
- **安全机制**
  - 🔒 JWT 令牌认证
  - 🚫 防机器人中间件
  - ⏱️ 会话过期控制
  - 🔑 客户端密钥验证

- **多语言支持**
  - 🌍 中文、英文界面（可扩展）
  - 基于浏览器语言自动切换

- **高性能**
  - ⚡ 内存存储（可配置 Redis）
  - 🎯 轻量级设计
  - 📊 状态监控端点

## 技术栈

- **语言**: Go 1.23+
- **Web 框架**: Gin
- **存储**: 内存存储 / Redis（可选）
- **验证服务**: Cloudflare Turnstile
- **前端**: 纯 HTML/CSS/JavaScript（内嵌）

## 项目结构

```
verification_go/
├── main.go                 # 程序入口
├── go.mod                  # Go 模块定义
├── go.sum                  # 依赖校验
├── .env.example            # 环境变量示例
├── src/
│   ├── cmd/
│   │   ├── cmd.go          # 命令行入口
│   │   └── router.go       # 路由配置
│   ├── config/
│   │   ├── config.go       # 配置加载与验证
│   │   └── defaults/
│   │       └── system_config.json  # 默认配置
│   ├── handler/
│   │   ├── handler.go      # 处理器基础
│   │   ├── session.go      # 会话创建与查询
│   │   ├── telegram.go     # Telegram 验证
│   │   ├── pow.go          # PoW 验证
│   │   └── status.go       # 状态检查
│   ├── middleware/
│   │   ├── auth.go         # 客户端认证
│   │   ├── antibot.go      # 防机器人中间件
│   │   └── errors.go       # 错误处理
│   ├── model/
│   │   ├── config.go       # 配置模型
│   │   ├── session.go      # 会话模型
│   │   ├── telegram.go     # Telegram 数据模型
│   │   ├── page.go         # 页面配置模型
│   │   └── dto/            # 数据传输对象
│   │       ├── session.go
│   │       ├── telegram.go
│   │       ├── pow.go
│   │       └── turnstile.go
│   ├── service/
│   │   ├── store.go        # 状态存储服务
│   │   ├── turnstile.go    # Turnstile 验证服务
│   │   ├── telegram/
│   │   │   └── verifier.go # Telegram 验证器
│   │   └── pow/
│   │       └── verifier.go # PoW 验证器
│   ├── utils/
│   │   ├── response.go     # 响应与错误码
│   │   └── token.go        # 令牌生成
│   ├── page/
│   │   └── page.go         # 页面渲染
│   └── i18n/
│       └── i18n.go         # 国际化
├── pages/
│   ├── templates/
│   │   └── index.html      # 验证页面模板
│   └── static/
│       ├── styles.css      # 样式文件
│       └── app.js          # 前端逻辑
└── scripts/
    └── build.sh            # 构建脚本
```

## 快速开始

### 前置要求

- Go 1.23 或更高版本
- Telegram Bot Token（从 [@BotFather](https://t.me/BotFather) 获取）
- Cloudflare Turnstile 站点密钥（从 [Cloudflare Dashboard](https://dash.cloudflare.com/) 获取）

### 安装步骤

1. **克隆项目**

```bash
git clone <repository-url>
cd verification_go
```

2. **安装依赖**

```bash
go mod download
```

3. **配置环境变量**

复制 `.env.example` 为 `.env` 并填写配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# 服务器配置
HOST=0.0.0.0
PORT=8080

# JWT 密钥（用于生成会话令牌，请使用强随机字符串）
JWT_SECRET=your-secret-key-here-change-me

# Cloudflare Turnstile 配置
TURNSTILE_SITE_KEY=your-turnstile-site-key
TURNSTILE_SECRET_KEY=your-turnstile-secret-key

# Telegram Bot 配置
TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather

# 客户端密钥（Bot 调用 API 时使用，请使用强随机字符串）
TRUSTED_CLIENT_KEYS=bot-client-key-change-me

# 公开访问地址（Bot 发送给用户的验证链接前缀）
PUBLIC_BASE_URL=https://your-domain.com
```

4. **运行服务**

开发模式：
```bash
go run main.go
```

生产模式（构建后运行）：
```bash
go build -o verification_server main.go
./verification_server
```

5. **验证服务运行**

访问状态端点：
```bash
curl http://localhost:8080/api/status
```

预期响应：
```json
{
  "status": "ok",
  "timestamp": 1703145600
}
```

## API 文档

### 1. 创建验证会话

创建一个新的验证会话，返回会话 ID 和验证页面 URL。

**请求**

```http
POST /api/sessions
X-Client-Key: your-client-key
```

**响应** (201 Created)

```json
{
  "session_id": "abc123def456",
  "verify_url": "https://your-domain.com/verify/abc123def456",
  "expires_at": 1703145900
}
```

### 2. 查询会话状态

查询会话的验证状态。

**请求**

```http
GET /api/sessions/{session_id}/status
X-Client-Key: your-client-key
```

**响应** (200 OK)

验证完成：
```json
{
  "status": "verified",
  "user_id": "123456789",
  "user_name": "example_user"
}
```

待验证：
```json
{
  "status": "pending"
}
```

### 3. 打开验证页面

用户访问验证页面。

**请求**

```http
GET /verify/{session_id}
```

**响应**

返回 HTML 验证页面，包含：
- Turnstile 人机验证组件
- Telegram Mini App 登录按钮
- PoW 备用验证

### 4. 提交 Turnstile 验证

提交 Cloudflare Turnstile 验证结果。

**请求**

```http
POST /api/sessions/{session_id}/turnstile
X-Anti-Bot-Token: session-anti-bot-token

{
  "token": "turnstile-response-token"
}
```

**响应** (200 OK)

```json
{
  "success": true
}
```

### 5. 提交 Telegram 验证

提交 Telegram Mini App 登录验证。

**请求**

```http
POST /api/sessions/{session_id}/telegram
X-Anti-Bot-Token: session-anti-bot-token

{
  "init_data": "telegram-mini-app-init-data"
}
```

**响应** (200 OK)

```json
{
  "success": true,
  "user_id": "123456789",
  "user_name": "example_user"
}
```

### 6. 提交 PoW 验证

提交工作量证明验证。

**请求**

```http
POST /api/sessions/{session_id}/pow
X-Anti-Bot-Token: session-anti-bot-token

{
  "nonce": "calculated-nonce"
}
```

**响应** (200 OK)

```json
{
  "success": true
}
```

### 错误响应格式

所有错误响应遵循统一格式：

```json
{
  "code": "ERROR_CODE",
  "info": {
    "message": "错误描述"
  }
}
```

常见错误码：

- `INVALID_REQUEST` (400) - 请求参数无效
- `UNAUTHORIZED_CLIENT` (401) - 客户端密钥无效
- `SESSION_NOT_FOUND` (404) - 会话不存在
- `SESSION_EXPIRED` (410) - 会话已过期
- `TURNSTILE_FAILED` (403) - Turnstile 验证失败
- `TELEGRAM_TOKEN_INVALID` (401) - Telegram 数据无效
- `POW_SOLUTION_INVALID` (422) - PoW 解答错误
- `RATE_LIMITED` (429) - 请求过于频繁
- `INTERNAL_ERROR` (500) - 内部服务器错误

## 配置说明

### 环境变量

| 变量名 | 说明 | 默认值 | 必填 |
|--------|------|--------|------|
| `HOST` | 监听地址 | `0.0.0.0` | 否 |
| `PORT` | 监听端口 | `8080` | 否 |
| `JWT_SECRET` | JWT 签名密钥 | - | **是** |
| `TURNSTILE_SITE_KEY` | Turnstile 站点密钥 | - | **是** |
| `TURNSTILE_SECRET_KEY` | Turnstile 服务端密钥 | - | **是** |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token | - | **是** |
| `TRUSTED_CLIENT_KEYS` | 受信任的客户端密钥（逗号分隔） | - | **是** |
| `PUBLIC_BASE_URL` | 公开访问地址 | - | **是** |
| `SESSION_TTL_SECONDS` | 会话有效期（秒） | `600` | 否 |
| `TURNSTILE_MAX_ATTEMPTS` | Turnstile 最大尝试次数 | `3` | 否 |
| `POW_DIFFICULTY` | PoW 难度级别 | `4` | 否 |

### 配置文件

除了环境变量，还可以通过 `src/config/defaults/system_config.json` 配置更多选项：

```json
{
  "session": {
    "ttl_seconds": 600,
    "cleanup_interval_seconds": 60
  },
  "turnstile": {
    "max_attempts": 3
  },
  "pow": {
    "difficulty": 4,
    "enabled": true
  },
  "page": {
    "title": "Telegram Group Verification",
    "default_language": "zh"
  }
}
```

## 部署指南

详细的部署说明请参考 [DEPLOYMENT.md](./DEPLOYMENT.md)。

### Docker 部署（推荐）

1. 构建镜像：
```bash
docker build -t telegram-verification .
```

2. 运行容器：
```bash
docker run -d \
  -p 8080:8080 \
  --env-file .env \
  --name verification-server \
  telegram-verification
```

### systemd 服务

1. 创建服务文件 `/etc/systemd/system/telegram-verification.service`：

```ini
[Unit]
Description=Telegram Verification Service
After=network.target

[Service]
Type=simple
User=telegram
WorkingDirectory=/opt/telegram-verification
EnvironmentFile=/opt/telegram-verification/.env
ExecStart=/opt/telegram-verification/verification_server
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

2. 启动服务：
```bash
sudo systemctl daemon-reload
sudo systemctl enable telegram-verification
sudo systemctl start telegram-verification
```

### Nginx 反向代理

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 与 Bot 集成

本服务需要配合 Telegram Bot 使用。Bot 的实现请参考 [tg_bot](../tg_bot) 项目。

**集成流程：**

1. 用户加入群组
2. Bot 检测到新成员，限制其权限
3. Bot 调用 `POST /api/sessions` 创建验证会话
4. Bot 发送验证链接给用户
5. 用户点击链接完成验证
6. Bot 定期调用 `GET /api/sessions/{session_id}/status` 检查状态
7. 验证通过后，Bot 恢复用户权限

## 安全建议

1. **密钥管理**
   - 使用强随机字符串作为 `JWT_SECRET` 和 `TRUSTED_CLIENT_KEYS`
   - 不要将 `.env` 文件提交到版本控制
   - 定期轮换密钥

2. **HTTPS**
   - 生产环境必须使用 HTTPS
   - 使用 Let's Encrypt 免费证书

3. **防火墙**
   - 仅允许必要的端口对外开放
   - 如果使用 Redis，确保其不对公网开放

4. **日志监控**
   - 定期检查日志中的异常行为
   - 设置告警机制

## 故障排查

### 服务无法启动

1. 检查环境变量是否正确配置：
```bash
go run main.go
```

2. 查看详细错误信息

### Turnstile 验证失败

1. 检查 `TURNSTILE_SECRET_KEY` 是否正确
2. 确认 Turnstile 站点配置的域名与 `PUBLIC_BASE_URL` 一致
3. 检查网络连接（服务器需要能访问 Cloudflare API）

### 会话过期问题

1. 检查 `SESSION_TTL_SECONDS` 配置
2. 确认用户在有效期内完成验证
3. 查看服务器时间是否准确

### Bot 无法连接

1. 检查 `TRUSTED_CLIENT_KEYS` 配置
2. 确认 Bot 使用正确的 `X-Client-Key` 头
3. 检查 `PUBLIC_BASE_URL` 是否可从外网访问

## 开发指南

### 运行测试

```bash
go test ./...
```

### 代码格式化

```bash
go fmt ./...
```

### 添加新的验证方式

1. 在 `src/handler` 中创建新的处理器
2. 在 `src/service` 中实现验证逻辑
3. 在 `src/cmd/router.go` 中注册路由
4. 更新前端页面添加 UI 组件

## 许可证

[MIT License](./LICENSE)

## 贡献

欢迎提交 Issue 和 Pull Request！

## 相关项目

- [tg_bot](../tg_bot) - Telegram Bot 端实现
- [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/) - 人机验证服务

## 支持

如有问题，请提交 [Issue](../../issues)。
