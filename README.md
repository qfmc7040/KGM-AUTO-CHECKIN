# 酷狗概念版签到
【对齐上游 KuGouMusicApi v1.6.2】

自动领取 `酷狗概念VIP`，每天领取总计 `两天酷狗概念VIP`

支持两种部署方式：

- **Docker 部署（推荐）**：部署到自己的服务器 / NAS，内置定时调度 + **WebUI 控制台**（扫码登录 / 手机号登录 / 一键签到 / 账号管理），无需 GitHub Actions（见下方 [Docker 部署](#docker-部署)）
- **GitHub Actions 部署**：Fork 本仓库白嫖 Actions，每天定时签到（见下方折叠的部署教程）

登录后即可使用，目前提供二维码登录(推荐)和手机号登录(一个手机号绑定多个账号无法登录，见 [多账号登录问题](https://github.com/MakcRe/KuGouMusicApi/issues/51))

### 项目试用链接
账号管理需输入酷狗ID 与密码（**未改过密码的账号，默认密码即其酷狗ID**，登录后请及时修改）；酷狗ID 请于酷狗概念APP **[我的]→[设置]→[消息和绑定设置]→[酷狗ID]** 查看

```htlm
https://kg.neteaseapi.cc.cd/
```

## 免责声明

> [!important]
>
> 1. 本项目仅供学习使用，请尊重版权，请勿利用此项目从事商业行为及非法用途!
> 2. 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 24小时内清除使用本项目的过程中所产生的版权数据。
> 3. 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）由使用者负责。
> 4. **禁止在违反当地法律法规的情况下使用本项目。** 对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担，本项目不承担由此造成的任何直接、间接、特殊、偶然或结果性责任。
> 5. 音乐平台不易，请尊重版权，支持正版。
> 6. 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。
> 7. 如果官方音乐平台觉得本项目不妥，可联系本项目更改或移除。

## 使用说明

> [!warning]
> **注意事项**
> 
> 若登录后听歌领取失败，请到APP 活动中心->天天签到领VIP(这个活动新用户好像没有) 查看当日是否已经领取VIP。

> [!CAUTION]
> **Github Actions部署 常见错误**：
> 
> 执行签到报错未配置，为`PAT`秘钥权限设置问题，需正确设置`PAT Secret`权限并再次执行登录，**Repository secrets**处除了配置的**PAT Secret**外，成功写入**USERINFO**即可正常执行签到
> 
> **即 先确保权限无误`Only select Repository`仅选中所需仓库**
> 
> **权限①：`Metadata` 保持只读**
> 
> **权限②：`Secrets` 设置为读写**
> 
> **在仓库`Settings`设置`PAT Secret`，再执行登录 确保`Secrets and variables` - `Actions`中成功写入`USERINFO`再执行签到**

$${\color{red}避免将PAT秘钥复制于Windows记事本中，可能存在的字号字体问题会导致秘钥中所有下划线消失导致秘钥出错}$$

## Docker 部署

在任意一台服务器 / NAS（能访问外网即可）上用 Docker 常驻运行，容器内置定时调度，**每天北京时间 01:10 自动签到**，不依赖 GitHub Actions 与 GitHub Secret。

### 1. 获取代码

```bash
git clone <本仓库地址> kgcheckin
cd kgcheckin
```

### 2. 构建并启动

```bash
docker compose up -d --build
docker compose logs -f        # 查看日志，Ctrl+C 退出（容器继续运行）
```

容器启动后同时具备 **WebUI 控制台 + 定时自动签到**，无需任何其他配置。

> [!NOTE]
> **关于 `./data` 目录属主（"登录成功但凭据没保存"的根因）**
>
> 凭据目录 `./data` 是宿主机上的 bind mount。如果它由 `sudo` 或 Docker 守护进程以 `root` 创建
> （**fork 后首次 `up` 必然如此**：`data/` 已被 `.gitignore` 忽略，克隆下来并不存在），容器内的普通用户就写不进去。
> 表现是：**扫码 / 手机号登录都显示成功，但账号没保存，重启后消失**；`data/` 下其它文件（公告、签到状态）同样写失败。
>
> 本版本已自动处理：容器以 root 启动，入口脚本先把 `./data` 属主修正为 `PUID:PGID`，再**降权**到该身份运行业务进程
> （WebUI 与签到**不会**以 root 运行）。`PUID` / `PGID` 留空时自动沿用 `./data` 现有属主；目录不存在或属主是 `root`
> 时回落到 `1000:1000`。
>
> - NAS / 非 1000 uid 的用户：在 `.env` 里显式写 `PUID` / `PGID`（Linux 用 `id -u` / `id -g` 取值），否则属主会被改成 1000
> - 从旧版本升级（`./data` 里已有 root 所有的文件）：`docker compose up -d --build` 重建即可，入口脚本会一并修正
> - 仍有问题看启动横幅的「凭据目录」一行，它会把需要执行的 `chown` 命令原样打出来；也可手动 `sudo chown -R <uid>:<gid> ./data`
> - **不要**用 `chmod 777` 绕过：`data/` 里是完整登录 token，等价于账号密码

容器内置健康检查（每 30 秒探测 WebUI 的 `/healthz`，该端点不受 `WEBUI_PASSWORD` 保护），可用 `docker ps` 查看状态：

```bash
docker ps                       # STATUS 列显示 (healthy) 即正常
docker inspect --format '{{.State.Health.Status}}' kgcheckin
```

#### 参照模板 ".env.example" 新建自己本地的 ".env" 配置文件 不要在模板上修改！！！

### 3. WebUI 控制台（推荐）

浏览器打开 `http://<服务器IP>:14725`，即可使用终端风格的可视化控制台：

| 功能 | 说明 |
|------|------|
| **扫码登录** | 选择账号数量 → 生成二维码 → 酷狗音乐 APP 扫码确认，凭据自动保存；多账号并行轮询扫码状态 |
| **手机号登录** | 输入手机号发送验证码（60s 冷却）→ 输入验证码一键登录 |
| **一键签到** | 点击立即执行签到，实时彩色终端输出（与 Actions 运行日志一致），签到结束显示退出码；**当日已完成签到的账号自动跳过**（不再重复请求酷狗 API；通知单独标记"跳过"，全部跳过时不重复发送通知）；**多账号全部并行签到**（`CHECKIN_CONCURRENCY` 可限流，1 为串行） |
| **账号管理** | 每账号独立密码（scrypt 哈希存储）：**未修改过密码的账号默认密码即其酷狗ID**，用户可凭此登录后自助修改密码（登录时会提示尽快改密）；仅可查看/管理自己的账号。管理员账号 `admin`（密码为 `ACCOUNTS_PASSWORD`，或用 `ACCOUNTS_BOOTSTRAP_PASSWORD` 首次初始化）可查看/管理所有账号，也可为任意账号设置密码；防爆破为**单账号 + 单 IP 双维度**锁定（默认账号 3 次 / IP 15 次错误，锁定 5 分钟），单账号被锁不影响其他账号 |
| **站点公告** | 顶栏「📢 公告」入口 + 未读角标：管理员在「公告管理」标签页发布通知（标题 / 正文 / 级别 info·warn·err / 置顶 / 草稿），所有访客打开页面即可看到。**发布仅限 `admin`**（与账号管理、全量签到共用同一套密码校验与防爆破计数）；正文一律按**纯文本**渲染（不走 HTML），避免公告成为 XSS 入口。已读状态记录在**访客浏览器本地**（`localStorage`，键 `kc_ann_read`），服务端不保存「谁读过」，匿名访客同样可用——代价是换设备或清缓存后会重新显示为未读 |

> - 公网暴露时，请在 `.env` 中设置 `WEBUI_PASSWORD`（全局访问密码）与 `ACCOUNTS_PASSWORD`（账号管理 admin 管理员密码），参考 `.env.example`
> - ⚠ **关于默认密码**：酷狗ID 并非秘密（账号列表接口会返回，用户之间也会互相告知），因此知道某个 ID 的人可以登录该账号并改掉密码。该默认值为「方便用户首次改密」而保留；公网部署请设置 `WEBUI_PASSWORD`，或设 `ACCOUNTS_DISABLE_ID_DEFAULT=true` 改用「由 admin 分发密码」的方式
> - 部署在反向代理之后时**必须**设置 `WEBUI_TRUST_PROXY`，否则所有外部请求会被视为同一个代理内网地址——账号防爆破的 IP 桶会互相拖累（一人被锁波及所有人）、二维码限流会被整体豁免；未设置时系统不会信任 `X-Forwarded-For`，以防伪造 IP 绕过计数。启动横幅会在未设置时红字提醒
> - 发送短信验证码与生成登录二维码的接口均可匿名调用，已内置滑动窗口限流（可用 `WEBUI_PHONE_SEND_GLOBAL_LIMIT`、`WEBUI_PHONE_SEND_PHONE_LIMIT`、`WEBUI_QR_GEN_IP_LIMIT` 调整），防止本服务被当作短信轰炸机使用。其中短信验证码按「全局 + 手机号」计数，不依赖来源 IP——容器端口映射下 `req.ip` 恒为网桥地址、反向代理下又来自可伪造的 `X-Forwarded-For`，按 IP 计数在生产部署里并不可靠
> - 通知渠道密钥同样建议写在 `.env`（自动注入容器，不会被提交到仓库）
> - 公告保存在 `data/announcements.json`（容器已挂载 `./data`，重启不丢）；**公告发布依赖 `admin` 账号可用**——若未设置 `ACCOUNTS_PASSWORD` 又没有初始化过 admin 密码，任何人都无法发布公告（读取公告不受影响）

### 4. 命令行登录（可选）

不想用 WebUI 时也可以纯命令行完成登录：

**方式一：二维码登录（推荐）**

```bash
# 第 1 步：生成登录二维码
docker compose run --rm kgcheckin node qrcodeLogin.js gen
# 第 2 步：用浏览器打开 data/qr/login.html，使用「酷狗音乐 APP」扫码并确认（二维码有效期约 2 分钟）
# 第 3 步：等待扫码结果并保存凭据
docker compose run --rm kgcheckin node qrcodeLogin.js wait
```

看到「登录成功」后，凭据已自动保存到 `data/userinfo.json`。

> 多账号追加：重新执行上面 3 步即可；`wait` 一步加参数 `-e APPEND_USER=是`，例如
> `docker compose run --rm -e APPEND_USER=是 kgcheckin node qrcodeLogin.js wait`（追加保留已有账号，仅更新/新增）

**方式二：手机号登录**

```bash
# 发送验证码
docker compose run --rm -e PHONE=138xxxxxxxx kgcheckin npm run sent
# 提交验证码完成登录
docker compose run --rm -e PHONE=138xxxxxxxx -e CODE=123456 kgcheckin npm run phoneLogin
```

### 4. 完成

登录完成后容器即按计划自动签到（默认每天北京时间 01:10），无需其他配置。也可以在 WebUI 点击「立即签到」手动验证：

```bash
docker compose run --rm kgcheckin node scheduler.js once   # 或命令行方式立即签到一次
```

### 4.1 已有 USERINFO？（从 Actions 迁移）

如果之前在 GitHub Actions 使用过，可直接把 Secret `USERINFO` 的内容贴到 `docker-compose.yml` 的 `USERINFO` 环境变量中，跳过第 3 步登录。

### 配置说明（docker-compose.yml `environment`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WEBUI_PORT` | `14725` | WebUI 控制台监听端口 |
| `WEBUI_PASSWORD` | - | 可选访问密码；设置后所有 API 需携带密钥（公网暴露时建议设置，写在 `.env` 中） |
| `ACCOUNTS_PASSWORD` | - | 账号管理模块 admin 管理员密码；普通账号未改过密码时以「酷狗ID」作为默认密码登录，admin 可管理所有账号 |
| `ACCOUNTS_BOOTSTRAP_PASSWORD` | - | 首次启动且尚无密码文件时，用它初始化 admin 密码 |
| `ACCOUNTS_MAX_ATTEMPTS` / `ACCOUNTS_LOCK_MINUTES` | `3` / `5` | 可选覆盖防爆破策略（单账号最大错误次数 / 锁定时长） |
| `ACCOUNTS_IP_MAX_ATTEMPTS` | `ACCOUNTS_MAX_ATTEMPTS × 5` | 单个 IP 的最大错误次数（放宽以免同 NAT 用户互相影响） |
| `ACCOUNTS_DISABLE_ID_DEFAULT` | `false` | 设为 `true` 关闭「默认密码=酷狗ID」，未设密码的账号须由 admin 先设置密码（公网部署推荐） |
| `PUID` / `PGID` | 自动 | 容器内运行业务进程的 uid / gid。留空时自动沿用宿主 `./data` 现有属主（目录不存在或属主为 root 则用 `1000:1000`）；NAS 或非 1000 用户请显式指定。入口脚本启动时据此修正 `./data` 属主并降权 |
| `WEBUI_TRUST_PROXY` | - | 部署在反向代理后（Nginx/Caddy/Cloudflare Tunnel 等）时**必须**设为 `1`，以信任 `X-Forwarded-For` 取真实 IP（也可填代理跳数，如 `2`）；未设置或设为 `0`/`false` 则不信任（防伪造绕过防爆破），但外部请求会被视为同一个代理内网地址，账号防爆破的 IP 桶会互相拖累、二维码限流会被豁免 |
| `WEBUI_PHONE_SEND_GLOBAL_LIMIT` | `20/60` | 发送短信验证码的全局限流（"次数/分钟"，即全服务每小时 20 次），防换号刷量；不依赖来源 IP；设为 `0/1` 关闭 |
| `WEBUI_PHONE_SEND_PHONE_LIMIT` | `2/1440` | 发送短信验证码的手机号限流（每号 24 小时 2 次），防止本服务被当作短信轰炸机 |
| `WEBUI_QR_GEN_IP_LIMIT` | `1/3` | 生成登录二维码的 IP 限流（每 IP 3 分钟 1 次，每次都会向酷狗申请新 key）；内网/本机豁免 |
| `CRON_SCHEDULE` | `10 1 * * *` | 签到计划任务（cron 表达式），默认每天北京时间 01:10 |
| `CRON_TIMEZONE` | `Asia/Shanghai` | 调度器使用的时区 |
| `RUN_ON_STARTUP` | `false` | 设为 `true` 时容器启动后立即执行一次签到 |
| `CHECKIN_CONCURRENCY` | 全部并行 | 多账号签到并发路数：默认有几个账号就几路全部并行；设 N 限最多 N 路；设 1 = 逐个串行（每账号内部仍保持 30s 的 VIP 领取节奏） |
| `USERINFO` | - | 登录凭据（JSON 数组），与 Actions 的 Secret 格式一致；与凭据文件二选一 |
| `USERINFO_FILE` | `/app/data/userinfo.json` | 凭据文件路径（位于挂载卷内，勿改）；入口脚本会自动读取并作为 `USERINFO` 注入 |
| [通知渠道变量](https://github.com/qfmc7040/KGM-AUTO-CHECKIN/edit/main/README.md#%E9%80%9A%E7%9F%A5%E6%B8%A0%E9%81%93%E5%8F%98%E9%87%8F) | - | `WECOM_BOT_KEY`、`DINGTALK_BOT_KEY`、`FEISHU_BOT_KEY`、`TG_BOT_TOKEN` 等，与下文 Actions 通知 Secret 同名，建议写在 `.env` 中 |
| `PAT` + `GITHUB_REPOSITORY` | - | 可选。仅当还想把每周刷新的 token 同步回 GitHub 仓库 Secret 时才需要 |

### 数据与安全

- 挂载卷 `./data/` 存放登录凭据（`userinfo.json`）和登录二维码，**请妥善保管，不要提交到仓库**（已加入 `.gitignore`）
- 通知密钥、WebUI 密码等私密配置写在 `.env` 文件（已被 `.gitignore` 忽略，模板见 `.env.example`），**不要直接写进 docker-compose.yml 提交**
- 每周日签到时候酷狗 token 会自动刷新并**写回 `data/userinfo.json`**，凭据长期有效，无需手动维护
- `data/checkin_state.json` 记录当日已完成签到的账号，供手动触发"立即签到"时跳过（按北京时间日期滚动，跨天自动失效；删除该文件可强制重新执行）
- 日期/星期计算固定按北京时间处理，与容器 `TZ` 无关；调度时区由 `CRON_TIMEZONE` 控制
- `data/` 目录属主由容器入口脚本在启动时自动修正（见上方「关于 `./data` 目录属主」），一般无需手工 chown；
  启动横幅的「凭据目录」一行会直接显示是否可写，不可写时给出具体修复命令
- 凭据写失败不会静默：顶栏徽章显示「凭据: 目录不可写」，扫码 / 手机号登录会提示「凭据未保存」而不是假装成功

### 常用命令速查

```bash
docker compose up -d --build                                # 构建/更新并启动
docker compose logs -f --tail 100                           # 跟踪日志
docker compose down                                         # 停止并删除容器
# WebUI 控制台: http://localhost:14725 （扫码登录 / 手机号登录 / 一键签到 / 账号管理）
docker compose run --rm kgcheckin node scheduler.js once    # 命令行方式手动立即签到
docker compose run --rm kgcheckin node scheduler.js next    # 预览接下来 3 次签到时间
docker compose run --rm kgcheckin node qrcodeLogin.js gen   # 命令行生成登录二维码
docker compose run --rm kgcheckin node qrcodeLogin.js wait  # 命令行等待扫码保存凭据
docker compose pull && docker compose up -d --build         # 拉取新代码后更新
```

## <summary>⚠️Github Actions部署教程⚠️</summary>

1. Fork 本仓库

1. 创建添加令牌
   - **创建令牌**  
     复制下方官网链接，在浏览器中打开

     ```html copy
     https://github.com/settings/personal-access-tokens/new
     ```

   - **登录 GitHub 官网**  
     若登陆后未跳转至token生成页，请再次粘贴链接进行访问
   - **在设置页面配置权限**  
      **Token name 备注**：随意填写
      **Expiration (有效期)**：建议自定义有效期，长期无人维护时不要选择过长
      **Repository access (仓库范围)**：只选择当前 fork 的仓库
      **Repository permissions (仓库权限)**：`Metadata` 保持只读，`Secrets` 设置为读写
      ![精细化个人访问令牌权限](imgs/精细化个人访问令牌权限.png)
   - 滑动到底部，点击绿色的 Generate token 保存按钮
   - 复制生成的字符串，回到本仓库添加到[Secret](https://github.com/qfmc7040/KGM-AUTO-CHECKIN#secret-%E4%BD%8D%E7%BD%AE)，变量名 `PAT`，value 为复制的令牌

1. 登录（两种独立的登录方式，任选其一）

   3.1 二维码登录(推荐)

   运行 Actions `二维码登录`，点击 Run → 在运行摘要页面（Summary）查看二维码图片，使用酷狗音乐 APP 扫码并确认登录即可。

   3.2 手机号登录

   添加手机号到 Secret `PHONE`，运行 Actions `手机号登录`，操作步骤选择「发送验证码」获取验证码，把验证码添加到 Secret `CODE`；再次运行 Actions `手机号登录`，操作步骤选择「登录」即可。

   ⬆️ $${\color{red}与上文给仓库添加PAT秘钥同一位置}$$ ⬆️

1. 启用 Actions `签到`，每天北京时间 01:10 自动签到（可在 `签到.yml` 中设置 cron）。启用 Actions `仓库保活` 以保证签到可以长期执行。

1. （可选）配置运行结果通知

   在仓库 Settings → Secrets and variables → Actions 中添加对应渠道的 Secret，签到完成后将自动推送结果通知。支持以下渠道（全部可选，配置多个将同时发送）：

### 通知渠道变量

   | 通知渠道 | Secret 变量名 | 说明 |
   |---------|-------------|------|
   | 企业微信机器人 | `WECOM_BOT_KEY` | 企业微信群机器人 webhook 的 key |
   | 钉钉机器人 | `DINGTALK_BOT_KEY` | 钉钉机器人 access_token |
   | 钉钉加签 | `DINGTALK_SECRET` | 钉钉机器人加签密钥（可选） |
   | 飞书机器人 | `FEISHU_BOT_KEY` | 飞书自定义机器人 webhook 的 key |
   | 云湖机器人 | `YUNHU_BOT_KEY` | 云湖机器人 webhook 的 key |
   | Server酱 | `SERVERCHAN_SENDKEY` | Server酱 SendKey |
   | PushPlus | `PUSHPLUS_TOKEN` | PushPlus token |
   | PushPlus群组 | `PUSHPLUS_TOPIC` | PushPlus 群组编码（可选） |
   | Telegram | `TG_BOT_TOKEN` | Telegram Bot Token |
   | Telegram | `TG_CHAT_ID` | Telegram 接收消息的 Chat ID |
   | Bark (iOS) | `BARK_KEY` | Bark key 或完整 URL |
   | Bark分组 | `BARK_GROUP` | Bark 消息分组（可选） |
   | Discord | `DISCORD_WEBHOOK` | Discord Webhook 完整 URL |
   | 邮箱 SMTP | `MAIL_HOST` | SMTP 服务器地址（如 `smtp.qq.com`） |
   | 邮箱 SMTP | `MAIL_PORT` | SMTP 端口（默认 465） |
   | 邮箱 SMTP | `MAIL_USER` | 发件邮箱账号 |
   | 邮箱 SMTP | `MAIL_PASS` | 发件邮箱授权码（非登录密码） |
   | 邮箱 SMTP | `MAIL_TO` | 收件邮箱地址 |

   通知内容包含：运行日期、账号数量、成功/失败统计、各账号听歌领取状态、VIP 领取次数、VIP 到期时间、错误信息等。

### 按账号的失效邮件提醒（可选）

上面的 `MAIL_TO` 只通知「配置者本人」。如果这个 WebUI 给多个用户使用，还可以让每个用户**自己预留邮箱**，之后某个账号的登录凭据失效时，系统只给该账号的用户单独发一封提醒邮件。

工作方式：

1. 用户在 WebUI 里扫码登录 / 手机号登录成功后，会弹出「预留通知邮箱」，填邮箱 → 收 6 位验证码 → 验证通过才落库；也可以随时在「账号管理」里补绑、更换或解绑。跳过不影响签到。
2. 每天签到遇到酷狗返回 `error_code == 20018`（登录凭据失效）时，`main.js` 会给这些账号里「已绑定且已验证邮箱」的用户各发一封提醒邮件，正文说明账号、发现时间、原因和处理方式。
3. 同一账号默认 **7 天最多提醒一次**；重新登录成功后标记会被清除，若再次失效可立即再收到提醒。

以下环境变量仅在用到该功能时才需要配置（默认值即为推荐值）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `MAIL_HOST` / `MAIL_PORT` / `MAIL_USER` / `MAIL_PASS` | - | 复用上面的 SMTP 发件配置；缺任一则无法绑定邮箱、也不发失效提醒 |
| `MAIL_FROM_NAME` | `酷狗签到助手` | 发件人显示名（From 头里的名称部分） |
| `MAIL_INVALID_NOTIFY` | 开启 | 设为 `false` / `0` 关闭按账号的失效邮件 |
| `MAIL_NOTICE_COOLDOWN_DAYS` | `7` | 同一账号的提醒冷却天数（最小 1） |
| `WEBUI_EMAIL_SEND_USER_LIMIT` | `3/60` | 验证码发送限流：每账号每小时次数（按账号计数，不依赖来源 IP） |
| `WEBUI_PUBLIC_URL` | 空 | WebUI 公网地址，会附加在失效邮件正文里方便点开重新登录 |

说明与限制：

- 邮箱验证码只存在内存中（10 分钟有效，最多试 5 次），服务重启后需重新获取，不影响已绑定的邮箱。
- 邮箱以明文保存在 `data/userinfo.json` 的账号条目里（与 token 同文件、同权限）；服务端日志与验证码提示一律脱敏为 `ab***@example.com`，「账号管理」面板（需独立密码解锁）内显示完整地址，便于用户核对自己填的是否正确。
- 不配置 SMTP 时，WebUI 里的「绑定邮箱」按钮会禁用，账号面板顶部横幅也会说明原因。
- 已失效的历史账号不会被补发：只有「失效前已完成验证的邮箱」才会收到提醒。

API源代码来自 [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) ~~图省事直接搬来~~

## 令牌（Token）机制说明

项目中包含两类令牌：

1. **GitHub Personal Access Token (PAT)**：用于自动将酷狗登录信息写入仓库 Secret `USERINFO`，以及每周日自动刷新酷狗登录 Token。

2. **酷狗登录 Token**：存储在 `USERINFO` Secret 中，用于酷狗 API 身份认证。通过登录获取，每周日自动刷新。

## Secret 位置

  ### 步骤一
   
   ![步骤一](./imgs/步骤一.jpg)
  ### 步骤二
   
   ![步骤二](./imgs/步骤二.jpg)
  ### 步骤三
   
   ![步骤三](./imgs/步骤三.jpg)
  ### 步骤四
   
   ![步骤四](./imgs/步骤四.jpg)

## 致谢

- 感谢 [@MakcRe](https://github.com/MakcRe) 提供 API 源代码
- 感谢 [@itfw](https://github.com/itfw) 提供二维码显示问题的解决方案
- 感谢 [@klaas8](https://github.com/klaas8) 提供自动写入secret的方法
- 感谢 [@develop202](https://github.com/develop202/kgcheckin) 原项目
