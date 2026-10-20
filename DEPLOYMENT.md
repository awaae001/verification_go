# Telegram 验证服务部署指南

本文档详细说明如何在生产环境中部署 Telegram 群组入群验证服务。

## 目录

- [系统要求](#系统要求)
- [部署前准备](#部署前准备)
- [部署方式](#部署方式)
  - [1. Docker 部署（推荐）](#1-docker-部署推荐)
  - [2. 二进制部署](#2-二进制部署)
  - [3. systemd 服务部署](#3-systemd-服务部署)
- [反向代理配置](#反向代理配置)
- [SSL/TLS 配置](#ssltls-配置)
- [监控与日志](#监控与日志)
- [备份与恢复](#备份与恢复)
- [性能优化](#性能优化)
- [故障排查](#故障排查)

## 系统要求

### 硬件要求

- **CPU**: 1 核心（最低）/ 2 核心（推荐）
- **内存**: 512MB（最低）/ 1GB（推荐）
- **存储**: 1GB 可用空间
- **网络**: 稳定的互联网连接，能访问 Telegram API 和 Cloudflare API

### 软件要求

- **操作系统**: Linux (Ubuntu 20.04+, Debian 11+, CentOS 8+) 或其他支持 Go 的系统
- **Go**: 1.23 或更高版本（仅开发/构建时需要）
- **Docker**: 20.10+ (可选，用于容器化部署)
- **Nginx/Caddy**: 用于反向代理和 SSL 终止

### 网络要求

- **出站连接**:
  - Telegram API: `api.telegram.org` (443端口)
  - Cloudflare Turnstile API: `challenges.cloudflare.com` (443端口)
- **入站连接**:
  - HTTP/HTTPS: 80/443 端口（通过反向代理）

## 部署前准备

### 1. 获取必要的凭证

#### Telegram Bot Token

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 创建新 Bot
3. 按提示设置 Bot 名称和用户名
4. 保存收到的 Bot Token（格式：`123456789:ABCdefGHIjklMNOpqrsTUVwxyz`）

配置 Bot 权限：
```
/setprivacy - 设置为 Disabled（让 Bot 能看到群消息）
/setjoingroups - 设置为 Enabled（允许 Bot 加入群组）
```

#### Cloudflare Turnstile 密钥

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 选择你的域名（或使用 Workers）
3. 进入 **Turnstile** 选项卡
4. 点击 **Add Site**
5. 配置站点：
   - **Site Name**: `Telegram Verification`
   - **Domain**: 你的域名（如 `verify.example.com`）
   - **Widget Mode**: `Managed`（推荐）或 `Non-Interactive`
6. 保存并获取：
   - **Site Key** (公开密钥，用于前端)
   - **Secret Key** (私密密钥，用于后端验证)

### 2. 域名配置

1. 准备一个域名（如 `verify.example.com`）
2. 添加 A 记录指向服务器 IP
3. 等待 DNS 传播（通常几分钟到几小时）

验证 DNS 配置：
```bash
dig verify.example.com
# 或
nslookup verify.example.com
```

### 3. 生成安全密钥

生成强随机密钥：

```bash
# JWT Secret (用于签名会话令牌)
openssl rand -hex 32

# Client Key (Bot 调用 API 时使用)
openssl rand -base64 32
```

保存这些密钥，后续配置需要使用。

## 部署方式

### 1. Docker 部署（推荐）

Docker 部署最简单，适合大多数场景。

#### 步骤 1: 创建 Dockerfile

在项目根目录创建 `Dockerfile`：

```dockerfile
# 构建阶段
FROM golang:1.23-alpine AS builder

WORKDIR /build

# 复制依赖文件
COPY go.mod go.sum ./
RUN go mod download

# 复制源代码
COPY . .

# 构建二进制文件
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -ldflags="-w -s" -o verification_server .

# 运行阶段
FROM alpine:latest

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

# 从构建阶段复制二进制文件
COPY --from=builder /build/verification_server .
COPY --from=builder /build/pages ./pages
COPY --from=builder /build/src/config/defaults ./src/config/defaults

# 设置时区
ENV TZ=Asia/Shanghai

EXPOSE 8080

CMD ["./verification_server"]
```

#### 步骤 2: 创建 docker-compose.yml

```yaml
version: '3.8'

services:
  verification:
    build: .
    container_name: telegram-verification
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      - HOST=0.0.0.0
      - PORT=8080
      - JWT_SECRET=${JWT_SECRET}
      - TURNSTILE_SITE_KEY=${TURNSTILE_SITE_KEY}
      - TURNSTILE_SECRET_KEY=${TURNSTILE_SECRET_KEY}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TRUSTED_CLIENT_KEYS=${TRUSTED_CLIENT_KEYS}
      - PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
      - SESSION_TTL_SECONDS=600
      - TZ=Asia/Shanghai
    volumes:
      - ./logs:/app/logs
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8080/api/status"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

#### 步骤 3: 配置环境变量

创建 `.env` 文件：

```env
JWT_SECRET=your-generated-jwt-secret-here
TURNSTILE_SITE_KEY=your-turnstile-site-key
TURNSTILE_SECRET_KEY=your-turnstile-secret-key
TELEGRAM_BOT_TOKEN=your-bot-token
TRUSTED_CLIENT_KEYS=your-client-key-1,your-client-key-2
PUBLIC_BASE_URL=https://verify.example.com
```

#### 步骤 4: 启动服务

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 检查状态
docker-compose ps
```

#### 步骤 5: 验证部署

```bash
# 检查健康状态
curl http://localhost:8080/api/status

# 预期输出
# {"status":"ok","timestamp":1703145600}
```

### 2. 二进制部署

直接编译和运行 Go 程序。

#### 步骤 1: 编译

```bash
# 克隆代码
git clone <repository-url>
cd verification_go

# 下载依赖
go mod download

# 编译（针对 Linux amd64）
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o verification_server .

# 或直接在目标服务器上编译
go build -o verification_server .
```

#### 步骤 2: 创建目录结构

```bash
# 创建部署目录
sudo mkdir -p /opt/telegram-verification
sudo mkdir -p /opt/telegram-verification/logs

# 复制文件
sudo cp verification_server /opt/telegram-verification/
sudo cp -r pages /opt/telegram-verification/
sudo cp -r src/config/defaults /opt/telegram-verification/src/config/

# 创建配置文件
sudo cp .env.example /opt/telegram-verification/.env
sudo nano /opt/telegram-verification/.env
```

#### 步骤 3: 设置权限

```bash
# 创建专用用户
sudo useradd -r -s /bin/false telegram

# 设置所有权
sudo chown -R telegram:telegram /opt/telegram-verification

# 设置可执行权限
sudo chmod +x /opt/telegram-verification/verification_server
```

#### 步骤 4: 测试运行

```bash
# 切换到部署目录
cd /opt/telegram-verification

# 作为 telegram 用户运行
sudo -u telegram ./verification_server
```

按 `Ctrl+C` 停止，如果一切正常，继续配置 systemd 服务。

### 3. systemd 服务部署

将服务配置为自动启动的系统服务。

#### 步骤 1: 创建服务文件

创建 `/etc/systemd/system/telegram-verification.service`：

```ini
[Unit]
Description=Telegram Group Verification Service
Documentation=https://github.com/your-repo/verification_go
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=telegram
Group=telegram
WorkingDirectory=/opt/telegram-verification
EnvironmentFile=/opt/telegram-verification/.env

# 启动命令
ExecStart=/opt/telegram-verification/verification_server

# 重启策略
Restart=on-failure
RestartSec=5s
StartLimitInterval=60s
StartLimitBurst=3

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/telegram-verification/logs

# 资源限制
LimitNOFILE=65536
LimitNPROC=512

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=telegram-verification

[Install]
WantedBy=multi-user.target
```

#### 步骤 2: 启动服务

```bash
# 重新加载 systemd 配置
sudo systemctl daemon-reload

# 启用开机自启
sudo systemctl enable telegram-verification

# 启动服务
sudo systemctl start telegram-verification

# 查看状态
sudo systemctl status telegram-verification

# 查看日志
sudo journalctl -u telegram-verification -f
```

#### 步骤 3: 服务管理命令

```bash
# 启动服务
sudo systemctl start telegram-verification

# 停止服务
sudo systemctl stop telegram-verification

# 重启服务
sudo systemctl restart telegram-verification

# 重新加载配置（无需重启）
sudo systemctl reload telegram-verification

# 查看日志
sudo journalctl -u telegram-verification -n 100 --no-pager

# 实时查看日志
sudo journalctl -u telegram-verification -f
```

## 反向代理配置

不要直接将 Go 服务暴露到公网，使用 Nginx 或 Caddy 作为反向代理。

### Nginx 配置

#### 步骤 1: 安装 Nginx

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nginx

# CentOS/RHEL
sudo yum install nginx
```

#### 步骤 2: 创建站点配置

创建 `/etc/nginx/sites-available/telegram-verification`：

```nginx
# 上游服务器定义
upstream verification_backend {
    server 127.0.0.1:8080;
    keepalive 32;
}

# HTTP 重定向到 HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name verify.example.com;

    # ACME challenge (Let's Encrypt)
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # 重定向到 HTTPS
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS 服务器
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name verify.example.com;

    # SSL 证书
    ssl_certificate /etc/letsencrypt/live/verify.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/verify.example.com/privkey.pem;

    # SSL 配置（现代化配置）
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_stapling on;
    ssl_stapling_verify on;

    # 安全头
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # 日志
    access_log /var/log/nginx/verification_access.log;
    error_log /var/log/nginx/verification_error.log;

    # 代理配置
    location / {
        proxy_pass http://verification_backend;
        proxy_http_version 1.1;
        
        # 头信息
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        
        # 超时设置
        proxy_connect_timeout 10s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
        
        # 缓冲设置
        proxy_buffering off;
        proxy_request_buffering off;
    }

    # 静态文件缓存（可选）
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        proxy_pass http://verification_backend;
        proxy_cache_valid 200 1d;
        expires 1d;
        add_header Cache-Control "public, immutable";
    }
}
```

#### 步骤 3: 启用站点

```bash
# 创建符号链接
sudo ln -s /etc/nginx/sites-available/telegram-verification /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重新加载 Nginx
sudo systemctl reload nginx
```

### Caddy 配置（更简单）

Caddy 自动处理 SSL 证书。

创建 `/etc/caddy/Caddyfile`：

```caddy
verify.example.com {
    reverse_proxy localhost:8080
    
    # 自动 HTTPS
    tls {
        protocols tls1.2 tls1.3
    }
    
    # 安全头
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
    }
    
    # 日志
    log {
        output file /var/log/caddy/verification.log
        format json
    }
}
```

启动 Caddy：

```bash
sudo systemctl enable caddy
sudo systemctl start caddy
```

## SSL/TLS 配置

### 使用 Let's Encrypt (certbot)

#### 步骤 1: 安装 certbot

```bash
# Ubuntu/Debian
sudo apt install certbot python3-certbot-nginx

# CentOS/RHEL
sudo yum install certbot python3-certbot-nginx
```

#### 步骤 2: 获取证书

```bash
# 自动配置 Nginx
sudo certbot --nginx -d verify.example.com

# 或手动模式
sudo certbot certonly --webroot -w /var/www/certbot -d verify.example.com
```

#### 步骤 3: 配置自动续期

```bash
# 测试续期
sudo certbot renew --dry-run

# certbot 会自动创建 cron 任务，检查：
sudo systemctl list-timers | grep certbot
```

## 监控与日志

### 日志配置

#### 应用日志

Go 服务默认输出到 stdout/stderr，通过 systemd 捕获：

```bash
# 查看最近 100 行
sudo journalctl -u telegram-verification -n 100

# 实时查看
sudo journalctl -u telegram-verification -f

# 按日期筛选
sudo journalctl -u telegram-verification --since "2024-01-01" --until "2024-01-02"

# 导出日志
sudo journalctl -u telegram-verification > verification.log
```

#### Nginx 日志

```bash
# 访问日志
tail -f /var/log/nginx/verification_access.log

# 错误日志
tail -f /var/log/nginx/verification_error.log
```

### 监控端点

服务提供健康检查端点：

```bash
# 状态检查
curl https://verify.example.com/api/status

# 预期响应
# {"status":"ok","timestamp":1703145600}
```

### 配置监控告警

使用 Prometheus + Grafana（可选）：

1. 添加 metrics 端点到服务
2. 配置 Prometheus 抓取
3. 在 Grafana 中创建仪表盘

简单的监控脚本：

```bash
#!/bin/bash
# /opt/scripts/check_verification.sh

STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://verify.example.com/api/status)

if [ "$STATUS" != "200" ]; then
    echo "Verification service is down! Status code: $STATUS"
    # 发送告警（邮件、Telegram 等）
    exit 1
fi

echo "Service is healthy"
exit 0
```

添加到 crontab：

```bash
# 每 5 分钟检查一次
*/5 * * * * /opt/scripts/check_verification.sh
```

## 备份与恢复

### 备份内容

本服务使用内存存储，无持久化数据需要备份。但需要备份：

1. **配置文件**
   - `.env`
   - `src/config/defaults/system_config.json`

2. **SSL 证书**
   - `/etc/letsencrypt/`

3. **日志文件**（可选）
   - `/var/log/nginx/`
   - journalctl 导出的日志

### 备份脚本

```bash
#!/bin/bash
# /opt/scripts/backup_verification.sh

BACKUP_DIR="/backup/telegram-verification"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="$BACKUP_DIR/backup_$DATE"

mkdir -p "$BACKUP_PATH"

# 备份配置
cp /opt/telegram-verification/.env "$BACKUP_PATH/"
cp -r /opt/telegram-verification/src/config "$BACKUP_PATH/"

# 备份 Nginx 配置
cp /etc/nginx/sites-available/telegram-verification "$BACKUP_PATH/nginx.conf"

# 备份 SSL 证书
sudo cp -r /etc/letsencrypt "$BACKUP_PATH/"

# 压缩
cd "$BACKUP_DIR"
tar -czf "backup_$DATE.tar.gz" "backup_$DATE"
rm -rf "backup_$DATE"

# 删除 30 天前的备份
find "$BACKUP_DIR" -name "backup_*.tar.gz" -mtime +30 -delete

echo "Backup completed: backup_$DATE.tar.gz"
```

### 恢复流程

```bash
# 1. 解压备份
cd /backup/telegram-verification
tar -xzf backup_YYYYMMDD_HHMMSS.tar.gz

# 2. 恢复配置
sudo cp backup_YYYYMMDD_HHMMSS/.env /opt/telegram-verification/
sudo cp -r backup_YYYYMMDD_HHMMSS/config /opt/telegram-verification/src/

# 3. 恢复 Nginx 配置
sudo cp backup_YYYYMMDD_HHMMSS/nginx.conf /etc/nginx/sites-available/telegram-verification

# 4. 恢复 SSL 证书
sudo cp -r backup_YYYYMMDD_HHMMSS/letsencrypt /etc/

# 5. 重启服务
sudo systemctl restart telegram-verification
sudo systemctl reload nginx
```

## 性能优化

### 1. 系统参数优化

编辑 `/etc/sysctl.conf`：

```conf
# 网络优化
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 10000 65000

# 文件描述符
fs.file-max = 100000
```

应用配置：

```bash
sudo sysctl -p
```

### 2. Nginx 优化

在 `nginx.conf` 中：

```nginx
user www-data;
worker_processes auto;
worker_rlimit_nofile 65535;

events {
    worker_connections 4096;
    use epoll;
    multi_accept on;
}

http {
    # 连接超时
    keepalive_timeout 65;
    keepalive_requests 100;
    
    # 缓冲区大小
    client_body_buffer_size 128k;
    client_max_body_size 10m;
    
    # Gzip 压缩
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/javascript application/json application/javascript;
}
```

### 3. Go 服务优化

设置环境变量：

```env
# 增加文件描述符限制
# 在 systemd service 文件中
LimitNOFILE=65536

# Go 运行时优化
GOMAXPROCS=2  # 设置为 CPU 核心数
GOGC=100      # GC 触发阈值
```

## 故障排查

### 问题 1: 服务无法启动

**症状**: systemctl start 失败

**排查步骤**:

```bash
# 1. 查看详细错误
sudo journalctl -u telegram-verification -n 50

# 2. 检查配置文件
cat /opt/telegram-verification/.env

# 3. 检查端口占用
sudo netstat -tulpn | grep 8080

# 4. 手动运行测试
cd /opt/telegram-verification
sudo -u telegram ./verification_server
```

**常见原因**:
- 环境变量配置错误
- 端口被占用
- 权限不足

### 问题 2: 无法访问服务

**症状**: curl 返回连接失败

**排查步骤**:

```bash
# 1. 检查服务状态
sudo systemctl status telegram-verification

# 2. 检查端口监听
sudo ss -tlnp | grep 8080

# 3. 测试本地连接
curl http://localhost:8080/api/status

# 4. 检查防火墙
sudo ufw status
sudo iptables -L -n

# 5. 检查 Nginx
sudo nginx -t
sudo systemctl status nginx
```

### 问题 3: SSL 证书错误

**症状**: HTTPS 访问报证书错误

**排查步骤**:

```bash
# 1. 检查证书文件
sudo ls -la /etc/letsencrypt/live/verify.example.com/

# 2. 测试证书
openssl s_client -connect verify.example.com:443 -servername verify.example.com

# 3. 续期证书
sudo certbot renew

# 4. 检查 Nginx 配置
sudo nginx -t
```

### 问题 4: Turnstile 验证失败

**症状**: 前端提示验证失败

**排查步骤**:

```bash
# 1. 检查日志
sudo journalctl -u telegram-verification | grep turnstile

# 2. 验证配置
echo $TURNSTILE_SECRET_KEY

# 3. 测试 Cloudflare 连接
curl -v https://challenges.cloudflare.com/turnstile/v0/siteverify

# 4. 检查域名配置
# 确保 Turnstile 站点配置的域名与实际域名一致
```

### 问题 5: 内存占用过高

**症状**: 服务占用内存持续增长

**排查步骤**:

```bash
# 1. 查看内存使用
ps aux | grep verification_server

# 2. 查看 Go 内存统计（添加 pprof 支持后）
curl http://localhost:8080/debug/pprof/heap > heap.pprof
go tool pprof heap.pprof

# 3. 调整 GC 参数
# 在 .env 中添加
GOGC=50  # 更激进的 GC
```

**解决方案**:
- 定期重启服务（cron）
- 调整会话 TTL
- 增加服务器内存

### 问题 6: 高并发下响应慢

**症状**: 多用户同时验证时响应时间长

**排查步骤**:

```bash
# 1. 查看连接数
sudo ss -s

# 2. 查看 CPU 使用
top -p $(pgrep verification_server)

# 3. 查看 Nginx 状态
curl http://localhost/nginx_status
```

**解决方案**:
- 增加 `GOMAXPROCS`
- 优化 Nginx worker 数量
- 考虑使用 Redis 替代内存存储
- 启用 CDN 加速静态资源

## 更新与升级

### 更新流程

```bash
# 1. 备份当前版本
sudo cp /opt/telegram-verification/verification_server /opt/telegram-verification/verification_server.bak

# 2. 下载新版本
git pull origin main
go build -o verification_server .

# 3. 停止服务
sudo systemctl stop telegram-verification

# 4. 替换二进制文件
sudo cp verification_server /opt/telegram-verification/

# 5. 更新配置（如果需要）
sudo cp -r pages /opt/telegram-verification/
sudo cp -r src/config/defaults /opt/telegram-verification/src/config/

# 6. 启动服务
sudo systemctl start telegram-verification

# 7. 验证
curl https://verify.example.com/api/status

# 8. 如果失败，回滚
sudo systemctl stop telegram-verification
sudo cp /opt/telegram-verification/verification_server.bak /opt/telegram-verification/verification_server
sudo systemctl start telegram-verification
```

### Docker 更新

```bash
# 1. 拉取新代码
git pull origin main

# 2. 重新构建
docker-compose build

# 3. 重启服务
docker-compose up -d

# 4. 查看日志
docker-compose logs -f
```

## 安全检查清单

部署前确认：

- [ ] 使用强随机密钥（JWT_SECRET, CLIENT_KEYS）
- [ ] 启用 HTTPS（SSL/TLS）
- [ ] 配置防火墙规则
- [ ] 设置文件权限（.env 只有 telegram 用户可读）
- [ ] 启用 systemd 安全特性（NoNewPrivileges 等）
- [ ] 配置日志轮转
- [ ] 设置监控告警
- [ ] 准备备份方案
- [ ] 限制 Nginx 上传大小
- [ ] 添加 rate limiting（可选）

## 支持与反馈

如遇到部署问题：

1. 查看本文档的故障排查部分
2. 查看 GitHub Issues
3. 提交新的 Issue 并附上：
   - 操作系统版本
   - 部署方式（Docker/二进制/systemd）
   - 错误日志
   - 配置文件（隐藏敏感信息）

---

**祝部署顺利！** 🚀
