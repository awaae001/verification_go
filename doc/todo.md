# 验证码流程参考(AGENT 仅可参考，不得将本文视为实现标准)

> 本文仅用于理解已有流程与已确认的技术事实。接口、架构、命名、技术选型、配置方式、错误码、页面文案、测试和验收标准均由用户另行指定。

## 用途

这是一个独立验证码服务的流程参考。服务与调用方业务无关，Telegram Login 只是验证码内部的身份验证步骤。

整个流程依次为：

```text
Cloudflare Turnstile
        ↓
Telegram OpenID Connect
        ↓
SHA-256 Proof of Work
        ↓
验证完成
```

当前流程的成功终点是服务端确认正确 PoW 答案。本文不定义验证结果之后的业务行为。

## 外部服务

流程涉及：

```text
Cloudflare Siteverify
https://challenges.cloudflare.com/turnstile/v0/siteverify

Telegram Login SDK
https://oauth.telegram.org/js/telegram-login.js?5

Telegram JWKS
https://oauth.telegram.org/.well-known/jwks.json

Telegram in-app initialization
https://oauth.telegram.org/inapp
```

运行时需要 Telegram Login Client ID、Cloudflare Turnstile Site Key、Cloudflare Turnstile Site Secret，以及能够保存短期一次性状态的存储。

Telegram Client Secret 不参与这个流程，因为服务接收并本地验证 `id_token`，不执行 Authorization Code 换 Token。

浏览器只需要得到公开 Client ID、公开 Site Key、本次 Telegram nonce 和本次 Turnstile cData。Secret 不进入浏览器。

## 临时状态关系

流程中有四种相互独立的随机值：

- Turnstile cData。
- Telegram nonce。
- PoW token。
- PoW challenge。

已有流程使用密码学安全随机源生成 32 字符字母数字值，临时状态有效期均为 10 分钟。

状态关系：

| 状态 | Value | 消费时机 |
|---|---|---|
| cData | Telegram nonce | Turnstile 完整验证成功后 |
| Telegram nonce | `verified` 标记 | ID Token 完整验证成功后 |
| PoW token | Telegram 用户 `id` 与 `name` | 创建 PoW challenge 时 |
| PoW challenge | Telegram 用户 `id` 与 `name` | 正确 PoW 答案验证后 |

每次消费是一次性的。原流程的意图是并发请求只能有一个成功，而不是先读取、再由多个请求分别删除。

## 阶段关系

```text
创建页面
    ↓
生成 cData 与 Telegram nonce
    ↓
保存 cData → nonce
    ↓
Turnstile 浏览器验证
    ↓
Cloudflare 服务端验证
    ↓
消费 cData，创建 nonce verified 状态
    ↓
Telegram Login
    ↓
服务端验证 ID Token 与 nonce
    ↓
消费 nonce，创建 PoW token
    ↓
消费 PoW token，创建 challenge
    ↓
浏览器计算 PoW
    ↓
服务端验证并消费 challenge
    ↓
完成
```

每一阶段只通过前一阶段产生的一次性状态进入。

## 创建页面时的状态

页面打开时生成两个不同的随机值：

```text
telegramNonce
turnstileCData
```

服务端先保存：

```text
turnstileCData → telegramNonce
```

此时 Telegram nonce 还没有通过验证，不能提前创建 `verified` 标记。

页面立即显式渲染 Turnstile。Turnstile 成功以前不显示 Telegram 登录按钮。

## Turnstile 流程

浏览器渲染 Turnstile 时使用：

```text
Site Key
服务指定的 action
服务端生成的 cData
```

成功后浏览器把 Turnstile token 与 cData 交给服务端。

服务端向 Siteverify 发送：

```text
secret = Site Secret
response = Turnstile token
```

已有流程不发送 `remoteip`。

服务端检查：

1. Siteverify 请求成功且响应可解析。
2. `success === true`。
3. `hostname` 等于验证码服务的 Host。
4. `action` 等于页面渲染时指定的 action。
5. Cloudflare 返回的 `cdata` 等于浏览器提交值。
6. cData 对应的临时状态仍存在且未被消费。

验证成功后消费 cData，并取得关联的 Telegram nonce，再创建：

```text
telegramNonce → verified
```

如果 cData 已过期或被消费，原页面会整体刷新并生成一套新状态。

## Telegram Login 流程

Turnstile 成功后才初始化 Telegram Login SDK。

已有初始化数据：

```text
client_id = Telegram Login Client ID
scope = profile, write
lang = en
nonce = 页面创建时生成的 Telegram nonce
```

SDK 成功回调提供 `id_token`，浏览器把它交给服务端验证。SDK 错误只用于调试，普通页面不展示完整错误或 Token。

## Telegram in-app nonce 问题

Telegram Login SDK 存在一个已经确认的分支差异：

- 普通 Popup 分支会把 `opts.nonce` 加入授权请求。
- Telegram in-app 分支请求 `/inapp` 时没有转发 `opts.nonce`。
- `/inapp` 返回 OAuth URL 时，服务端认证请求已经建立。
- 因此事后拦截 `TelegramWebviewProxy.postEvent` 并修改 `oauth_request.url` 无法让 nonce 进入 ID Token。

已有可行兼容方式是在 SDK 发起初始 `/inapp` 请求时加入相同 nonce。

为避免影响其他请求，原兼容逻辑只识别：

```text
window.TelegramWebviewProxy 存在
URL origin == https://oauth.telegram.org
URL pathname == /inapp
URL 查询参数包含 client_id
```

识别后执行：

```text
url.searchParams.set("nonce", serverGeneratedNonce)
```

结果查询使用 `/inapp?code=...`，不含 `client_id`，不会被这条逻辑修改。

这个兼容逻辑位于初始 `/inapp` 请求之前，不能改回 `postEvent` URL 方案。

## Telegram ID Token 验证顺序

收到 `id_token` 后，已有流程按以下顺序验证：

1. JWS 必须恰好包含 Header、Payload、Signature 三个分段。
2. 三个分段执行 Base64URL 解码。
3. Header 与 Payload 必须是 JSON 对象。
4. Header 的 `alg` 必须是 `ES256`。
5. Header 必须包含 `kid`。
6. 从 Telegram JWKS 中选择相同 `kid` 的 JWK。
7. JWK 的 P-256 坐标 `x`、`y` 解码后各为 32 字节。
8. 使用 P-256 和 SHA-256 验证 JWS 签名。
9. 验证 OIDC Claims。
10. 验证 audience 与时间关系。
11. 最后才消费 Telegram nonce。

JWS 的签名输入是原始字符串：

```text
encodedHeader + "." + encodedPayload
```

ES256 JWS Signature 是 64 字节 `R || S`，每部分 32 字节。Go 可以直接转为两个大整数后使用 `crypto/ecdsa` 验证，不需要转换为 ASN.1 DER。

## OIDC Claims

已有流程要求以下 Claims：
[2026/8/28 15:34] 神林: | Claim | 类型 | 约束 |
|---|---|---|
| `iss` | string | 等于 `https://oauth.telegram.org` |
| `aud` | string | 等于 Client ID 的十进制字符串 |
| `sub` | string | 必须存在 |
| `iat` | integer | 不晚于当前时间 |
| `exp` | integer | 晚于当前时间 |
| `id` | integer | Telegram 用户 ID |
| `name` | string | 必须存在 |
| `nonce` | string | 32 字符字母数字值 |

时间还需要满足：

```text
iat < exp
```

Claims、签名、issuer、audience 和时间全部通过后，才消费 `payload.nonce` 对应的 `verified` 状态。

验证成功后生成 PoW token，并在短期状态中保存 Telegram 用户 `id` 与 `name`。

## 本地浏览器特征

Telegram 验证成功后，浏览器计算音频与视觉渲染特征。视觉特征优先使用 WebGPU，WebGPU 不可用时降级到 Canvas 2D。它们只决定 PoW 搜索起点，不上传服务端，也不是密码学意义上的可信设备证明。

### 音频特征

使用：

```text
OfflineAudioContext(1, 44100, 44100)
```

创建 Triangle Oscillator：

```text
frequency = 10000
```

连接 Dynamics Compressor：

```text
threshold = -50
knee = 40
ratio = 12
attack = 0
release = 0.25
```

连接关系：

```text
Oscillator → DynamicsCompressor → destination
```

离线渲染后，对第一个声道 Float32 buffer 的原始字节计算 SHA-256，编码为小写十六进制字符串。

### WebGPU 特征

请求默认 WebGPU Adapter，读取：

```text
vendor
architecture
device
description
isFallbackAdapter
features
```

`features` 转为字符串数组并排序。把整个对象编码为 JSON，对 UTF-8 字节计算 SHA-256，编码为小写十六进制字符串。

无法取得 WebGPU Adapter 时，使用 Canvas 2D 固定绘制结果的像素数据作为降级特征；仅当 WebGPU 和 Canvas 2D 都不可用时才停止流程。

### 搜索起点

拼接：

```text
audioFingerprint + webGPUFingerprint
```

对拼接后的 UTF-8 字节计算 SHA-256。取 Hash 前 4 字节作为 Big Endian uint32：

```text
startOffset = uint32(hash[0:4]) % maximumWork
```

原始音频、Adapter 信息、指纹、合并 Hash 和 startOffset 均留在浏览器本地。

## PoW Challenge

Telegram 验证产生的 PoW token 用于换取 challenge。

换取时会原子消费 PoW token，把 Telegram 用户信息转移到新的 challenge 状态。

已有 PoW 参数：

```text
challenge = 32 字符字母数字随机值
difficulty = 6
maximumWork = 268435456
```

`difficulty = 6` 表示 SHA-256 十六进制结果以 6 个 `0` 开头，也就是 24 个前导零 bit。

## PoW 算法

固定计算内容：

```text
SHA256(UTF8(challenge + decimal(solution)))
```

`challenge` 与十进制 `solution` 直接拼接，中间没有冒号、空格、换行或其他分隔符。

浏览器从本地 startOffset 开始，按以下顺序搜索：

```text
solution = (startOffset + completedWork + batchOffset) % maximumWork
```

搜索到空间尾部后从 `0` 继续，最多检查整个 `maximumWork` 空间。

命中条件：

```text
SHA-256 前 24 bit 为零
```

等价十六进制判断：

```text
hash starts with "000000"
```

## Dedicated Worker

PoW 在页面级 Dedicated Worker 中运行，避免主线程持续调度 Web Crypto Promise 导致 Chromium 出现 `Page Unresponsive`。

已有计算方式：

```text
batchSize = 256
```

Worker 每批生成最多 256 个 solution，并并发调用 Web Crypto SHA-256。

Worker 消息：

```text
progress   → percentage
complete   → solution
error      → message
```

完成或失败后终止 Worker。

Dedicated Worker 不是 Service Worker：它不注册、不拦截请求、不使用 Cache Storage、不跨页面存活，也不产生持久化存储。它只在运行期间占用 CPU 与 RAM。

如果页面部署 CSP，需要允许创建 Blob Worker，否则这套动态 Worker 方式无法启动。

## PoW 进度

已有进度精度为 `0.1%`：

```text
percentage = floor(completed / maximumWork * 1000) / 10
```

Worker 只在 percentage 改变时向页面报告进度。找到 solution 时报告 `100%`。

报告 `100%` 只表示浏览器找到候选答案，不表示服务端已经确认成功。

## PoW 服务端验证

浏览器提交 challenge 与整数 solution。

服务端先确认 challenge 存在，但不立即消费。随后计算：

```text
SHA256(challenge + decimal(solution))
```

处理关系：

- Hash 不满足 6 个十六进制前导零时，保留 challenge，允许继续提交其他答案。
- Hash 正确时，原子消费 challenge。
- 多个正确答案并发提交时，只有成功消费 challenge 的请求完成验证。
- 页面只在服务端确认成功后显示完成。

## 已确认的安全关系

- Turnstile cData、Telegram nonce、PoW token 和 challenge 是四个不同值。
- cData 把 Cloudflare 验证绑定到本次 Telegram nonce。
- Telegram nonce 把 ID Token 绑定到已经通过 Turnstile 的页面实例。
- PoW token 只能由成功 Telegram 验证产生。
- challenge 只能由一次性 PoW token 产生。
- 无效 ID Token 不应提前消费合法 nonce。
- 错误 PoW 答案不应消费 challenge。
- 浏览器特征不上传服务端。
- 浏览器找到答案后仍需服务端确认。

## 当前流程边界

完成链路为：

```text
Turnstile 通过
    ↓
Telegram ID Token 与 nonce 通过
    ↓
PoW challenge 正确消费
    ↓
验证码完成
```

本文不规定完成后的凭证形式、调用方接入方式、重定向、回调、授权结果或业务动作。


[2026/8/28 15:41] 神林: 不是 我的意思是这是一个通用级别的验证器 机器人作为客户端去请求验证 拿到URL发给用户 用户验证完点机器人的确认 机器人去这个验证器查状态
[2026/8/28 15:42] 神林: 也就是验证器只在内存里缓存状态 是一个无状态的验证器c