# syntax=docker/dockerfile:1
# kgcheckin —— 酷狗概念版自动签到（Docker 版）
FROM node:20-alpine

ENV NODE_ENV=production \
    TZ=UTC

WORKDIR /app

# ── 根目录依赖（express、qrcode、node-cron）──
# 注意：--ignore-scripts 跳过根 package.json 的 install 生命周期脚本
# （该脚本会执行 cd api && npm ci 全量安装，Dockerfile 中改为下方显式按需安装）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# ── API 服务生产依赖（先只拷贝清单文件，充分利用构建缓存）──
COPY api/package.json api/package-lock.json ./api/
RUN cd api \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /root/.npm

# ── 业务源码 ──
COPY main.js sent.js phoneLogin.js qrcodeLogin.js scheduler.js ./
COPY utils ./utils
COPY api ./api
COPY webui ./webui

# ── 运行时目录与权限 ──
# /app/data：挂载卷（userinfo.json 凭据、二维码输出）
#
# 入口脚本以 root 启动（不再用 USER node），依次做三件事：
#   1. 把挂载卷 data 目录的属主修正为 PUID:PGID（未指定时沿用宿主目录现有属主，
#      再回落到 1000:1000）；
#   2. 用 docker/entrypoint-drop.mjs 降权到该 uid/gid 执行 CMD，业务进程本身仍以普通用户运行；
#   3. chown 失败（NFS root-squash / 只读挂载）只警告不阻断，由 WebUI 的可写自检
#      把原因和修复命令报给用户。
# 这样即使 ./data 是 sudo 或 Docker 守护进程以 root 创建的（fork 后首次 up 的典型情况），
# 容器内普通用户也能写入 userinfo.json，用户无需手动 chown，更不该 chmod 777
# （data 里是完整登录 token）。
#
# 降权为什么不用 su-exec / gosu：
#   alpine 官方镜像不含这两个工具，安装需要 `apk add`，而部分用户网络访问不到
#   dl-cdn.alpinelinux.org（Connection refused），构建会直接失败。镜像自带 node，
#   用 node 的 setgid/setuid 实现等价降权，零额外依赖，离线也能构建。
COPY docker/entrypoint.sh docker/entrypoint-drop.mjs /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R node:node /app/data

# 凭据文件与二维码输出统一放到挂载卷内
ENV USERINFO_FILE=/app/data/userinfo.json \
    QR_DIR=/app/data/qr \
    QR_KEYS_FILE=/app/data/qrkeys.json \
    WEBUI_PORT=3000

# 容器内端口规划（无需对外全部暴露）：
#   3000 WebUI 控制台（compose 按需映射）
#   3010 登录用常驻 API 服务（webui/server.js 懒启动）
#   3020 签到子进程专用 API 服务（每次签到临时拉起）
#
# 健康检查：命中 WebUI 的免鉴权 /healthz（设了 WEBUI_PASSWORD 也返回 200）。
# 用 node 内置 fetch，无需额外安装 curl。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEBUI_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "webui/server.js"]
