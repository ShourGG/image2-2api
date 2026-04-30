# Shour生成图 / image2-2api

`image2-2api` 是 ShourGG 定制维护的在线 AI 生成图平台，基于 `chatgpt2api` 深度改造，面向「网页生成图 + 用户系统 + 积分计费 + OpenAI 兼容图片上游」场景。

项目内置前台画图、注册登录、账号信息、日志隔离、积分/图币计费、免费号池、OpenAI 兼容图片上游、图片分享页和后台管理能力。

> 本仓库是 ShourGG 定制维护版，重点服务于 `shour生成图` 的实际部署需求。

## 核心能力

### 用户端

- 用户注册 / 登录
- 账号信息页
- 免费积分与充值图币分离
- 每个用户独立：
  - 积分
  - 图币
  - 体验券
  - 画图历史
  - 日志记录
- 支持文生图
- 支持参考图编辑
- 支持多图参考编辑
- 支持生成结果继续加入编辑
- 支持图片结果分享页
- 支持复制图片地址、复制提示词

### 计费与积分

- 默认新用户积分
- 免费生成走积分
- 充值高清走图币 / 体验券
- 支持不同尺寸、画质独立定价
- 支持普通签到
- 支持赌狗签到
- 生成失败自动回退积分 / 图币

### 免费号池

- 免费生成使用共享 ChatGPT 账号池
- 免费号池并发控制为单任务队列
- 账号无额度、限流或异常时自动切换可用账号
- 支持账号健康状态、额度、成功/失败次数统计

### OpenAI 兼容图片上游

- 支持自定义 OpenAI 兼容 API Base URL
- 支持多个上游 key
- 支持按上游单独配置并发上限
- 某个上游失败自动切换下一个
- 所有上游满载时自动排队
- 支持 `/v1/usage` 额度查询
- 支持 `gpt-image-2` 等图片模型

### 后台管理

- 系统配置
- 用户管理
- 用户积分 / 图币 / 体验券管理
- ChatGPT 账号池管理
- CPA / Sub2API 账号导入
- 图片上游配置
- 图片资源管理
- 日志查看
- 登录 / 注册限流配置
- 同 IP 成功注册账号数限制

## 安全与风控

当前内置的注册与访问控制：

- 登录频率限制
- 注册频率限制
- 同 IP 注册尝试限制
- 同 IP + 同邮箱注册尝试限制
- 同 IP 成功注册账号数限制，默认 `1`
- 注册邮箱存在性不直接泄露
- `/docs`、`/openapi.json` 默认关闭
- CORS 默认收紧
- `config.json`、`data/`、本地图片数据建议只保存在部署服务器

> 建议公网部署时只允许 Cloudflare 或反代访问源站端口，避免客户端伪造 `X-Forwarded-For`。

## 页面入口

| 页面 | 说明 |
| --- | --- |
| `/` | 首页 |
| `/login` | 登录 |
| `/signup` | 注册 |
| `/image` | 用户画图工作台 |
| `/account` | 用户账号信息 |
| `/logs` | 用户日志 |
| `/share` | 公开图片分享页 |
| `/settings` | 管理后台 |
| `/accounts` | 账号池管理 |
| `/image-manager` | 图片资源管理 |
| `/register` | 注册任务管理 |

## API 能力

保留 OpenAI 兼容图片接口，便于接入第三方客户端或其他系统。

下面示例使用本地开发端口 `8025`；如果按 Docker 教程部署，请改成 `3000` 或你的域名。

### 模型列表

```bash
curl http://127.0.0.1:8025/v1/models \
  -H "Authorization: Bearer <auth-key>"
```

### 文生图

```bash
curl http://127.0.0.1:8025/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <auth-key>" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一张高级质感的未来城市海报",
    "n": 1,
    "size": "1024x1024",
    "quality": "standard",
    "response_format": "url"
  }'
```

### 图片编辑

```bash
curl http://127.0.0.1:8025/v1/images/edits \
  -H "Authorization: Bearer <auth-key>" \
  -F "model=gpt-image-2" \
  -F "prompt=把这张图改成赛博朋克夜景风格" \
  -F "n=1" \
  -F "image=@./input.png"
```

### Responses 图片工具兼容

```bash
curl http://127.0.0.1:8025/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <auth-key>" \
  -d '{
    "model": "gpt-image-2",
    "input": "生成一张未来感城市天际线图片",
    "tools": [
      {
        "type": "image_generation"
      }
    ]
  }'
```

## 新手部署教程

如果你第一次部署，推荐直接用 Docker Compose。下面按「一台新服务器」来写。

### 1. 准备服务器

- 推荐系统：Ubuntu 22.04 / Debian 12
- 推荐配置：2 核 2G 起步
- 需要开放端口：
  - `80` / `443`：绑定域名后访问
  - `3000`：不配域名时临时访问

### 2. 安装 Docker

```bash
curl -fsSL https://get.docker.com | bash
systemctl enable --now docker

docker --version
docker compose version
```

### 3. 拉取项目

```bash
git clone https://github.com/ShourGG/image2-2api.git
cd image2-2api
```

### 4. 创建配置文件

```bash
cp .env.example .env
printf '{}\n' > config.json
mkdir -p data
```

编辑 `.env`：

```bash
nano .env
```

至少修改后台密钥：

```env
CHATGPT2API_AUTH_KEY=换成你自己的后台密钥
STORAGE_BACKEND=json
```

如果你已经绑定域名，再加上：

```env
CHATGPT2API_BASE_URL=https://你的域名
```

### 5. 启动服务

```bash
docker compose up -d --build
docker compose ps
```

启动后先用浏览器打开：

```text
http://服务器IP:3000
```

### 6. 第一次进入后台

后台入口：

```text
http://服务器IP:3000/settings
```

首次初始化时需要填写的后台密钥就是 `.env` 里的 `CHATGPT2API_AUTH_KEY`；初始化完成后，管理员使用邮箱密码登录。

进入后台后建议先配置：

1. 图片生成方式
   - 免费模式：导入 ChatGPT 账号池
   - 充值高清：添加 OpenAI 兼容图片上游
2. OpenAI 兼容图片上游
   - Base URL
   - API Key
   - 图片模型，例如 `gpt-image-2`
   - 单个上游并发上限
3. 用户计费
   - 免费积分价格
   - 图币价格
   - 体验券规则
4. 注册风控
   - 单 IP 注册数量
   - 登录 / 注册限流

### 7. 绑定域名反代

Nginx 示例：

```nginx
server {
    listen 80;
    server_name image.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配置完成后把 `.env` 里的公开地址改成你的域名：

```env
CHATGPT2API_BASE_URL=https://image.example.com
```

然后重启：

```bash
docker compose restart
```

### 8. 常用命令

```bash
# 查看运行状态
docker compose ps

# 查看实时日志
docker compose logs -f --tail=100

# 重启服务
docker compose restart

# 停止服务
docker compose down
```

## 本地开发运行

### 后端

```bash
cd /root/chatgpt2api

python -m venv .venv
source .venv/bin/activate
pip install -e .

export CHATGPT2API_AUTH_KEY="your-admin-key"
uvicorn main:app --host 0.0.0.0 --port 8025
```

### 前端构建

```bash
cd /root/chatgpt2api/web
npm install
npm run build
```

前端静态产物会输出到：

```text
web/out
```

后端通过 `web_dist` 软链接或目录提供静态页面。

## 存储后端

支持以下存储方式：

| 后端 | 说明 |
| --- | --- |
| `json` | 本地 JSON 文件，默认 |
| `sqlite` | 本地 SQLite |
| `postgres` | PostgreSQL |
| `git` | Git 私有仓库存储 |

示例：

```yaml
environment:
  - STORAGE_BACKEND=postgres
  - DATABASE_URL=postgresql://user:password@host:5432/dbname
```

## 重要配置

### 基础配置

| 配置 | 说明 |
| --- | --- |
| `CHATGPT2API_AUTH_KEY` | 后台初始化密钥 |
| `CHATGPT2API_BASE_URL` | 图片公开访问地址 |
| `STORAGE_BACKEND` | 存储后端 |
| `DATABASE_URL` | 数据库连接 |

### 图片生成策略

| 配置 | 说明 |
| --- | --- |
| `image_generation_strategy` | 生图方式 |
| `image_generation_api_upstreams` | OpenAI 兼容图片上游列表 |
| `max_concurrency` | 单个上游并发上限 |
| `image_retention_days` | 图片保留天数 |

### 注册风控

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `auth_register_ip_account_limit` | `1` | 同 IP 最多成功注册账号数 |
| `auth_rate_limit_register_ip_limit` | `10` | 同 IP 注册尝试次数 |
| `auth_rate_limit_register_ip_window_seconds` | `1800` | 同 IP 注册窗口 |
| `auth_rate_limit_login_ip_limit` | `30` | 同 IP 登录尝试次数 |
| `auth_rate_limit_login_ip_window_seconds` | `300` | 同 IP 登录窗口 |

## 项目归属

维护者：

- GitHub: [ShourGG](https://github.com/ShourGG)
- Project: [image2-2api](https://github.com/ShourGG/image2-2api)

本项目基于 `chatgpt2api` 进行定制开发，当前 README 面向 `shour生成图` 部署版本编写。
