#!/bin/sh
# kgcheckin 容器入口脚本：
# 1. 以 root 启动时，先把挂载卷 data 目录的属主修正为 PUID:PGID，再降权执行 CMD；
#    PUID/PGID 留空时自动沿用 data 目录现有属主，目录不存在或属主为 root 时回落 1000:1000。
#    这样 fork 后首次 `docker compose up`（./data 由守护进程以 root 创建）也能直接写入凭据，
#    无需用户手动 chown，更不必 chmod 777（data 内是完整登录 token）。
# 2. 未直接提供 USERINFO 环境变量时，自动从挂载的凭据文件（USERINFO_FILE）读取；
# 3. exec 执行容器命令（默认：node webui/server.js）。
#
# 安全说明：
# - 只有「修正挂载卷属主 + 立刻降权」这一步以 root 运行，业务进程始终是普通用户；
#   若容器本身以非 root 启动（docker run --user / compose 的 user:），脚本跳过修正直接 exec。
# - 此处把凭据导出为环境变量，是为兼容 scheduler.js / main.js 的独立运行方式
#   （GitHub Actions 同样用环境变量）。环境变量可被同容器内的其他进程读取
#   （/proc/<pid>/environ），因此 WebUI 模式（webui/server.js）不再走该路径，
#   而是通过 stdin 把凭据传给签到子进程。
set -e

# 脚本自身所在目录（镜像内为 /usr/local/bin），用于定位同目录的降权执行器
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

DATA_DIR="${DATA_DIR:-$(dirname "${USERINFO_FILE:-/app/data/userinfo.json}")}"

# ── 未直接提供 USERINFO 时从凭据文件读取 ──
# 必须在降权之前做：root 能读任意文件，且导出的环境变量会随 exec 传给降权后的进程。
if [ -z "$USERINFO" ] && [ -n "$USERINFO_FILE" ] && [ -f "$USERINFO_FILE" ]; then
  USERINFO="$(cat "$USERINFO_FILE")"
  export USERINFO
  echo "[entrypoint] 已从 $USERINFO_FILE 读取登录凭据 (USERINFO)"
fi

if [ "$(id -u)" = "0" ]; then
  # ── 解析目标 uid/gid ──
  # 显式指定的优先；未指定则沿用 data 目录当前属主（NAS / 自定义 uid 场景最贴合）；
  # 目录不存在或属主为 root（说明是 sudo / 守护进程创建的）时回落到 1000:1000。
  if [ -z "${PUID:-}" ] || [ -z "${PGID:-}" ]; then
    if [ -d "$DATA_DIR" ]; then
      _uid="$(stat -c %u "$DATA_DIR" 2>/dev/null || true)"
      _gid="$(stat -c %g "$DATA_DIR" 2>/dev/null || true)"
      [ -z "${PUID:-}" ] && [ -n "$_uid" ] && [ "$_uid" != "0" ] && PUID="$_uid"
      [ -z "${PGID:-}" ] && [ -n "$_gid" ] && [ "$_gid" != "0" ] && PGID="$_gid"
    fi
  fi
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"

  mkdir -p "$DATA_DIR"

  # ── 修正属主（幂等）──
  # 每次都跑一遍 chown -R：data 里只有几个小 JSON 和二维码图片，代价可忽略，
  # 好处是能把历史遗留的 root 属主文件（旧版本 sudo 跑过）一并修好。
  # chown 失败不阻断启动（NFS root-squash 等场景），改为在日志里给出明确提示，
  # 后续由 WebUI 的可写自检把「写不进去」的原因告诉用户。
  if chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null; then
    echo "[entrypoint] data 目录属主已确认为 $PUID:$PGID ($DATA_DIR)"
  else
    echo "[entrypoint] ⚠ 无法修改 $DATA_DIR 属主为 $PUID:$PGID（NFS root-squash / 只读挂载？）" >&2
    echo "[entrypoint]   若凭据写入失败，请在宿主机执行: sudo chown -R $PUID:$PGID ./data" >&2
  fi

  # ── 降权执行 ──
  # 容器内没有该 uid 的 passwd 条目也没关系，按数字 uid/gid 直接切换。
  # 用镜像自带的 node 执行降权（见 entrypoint-drop.mjs）：
  #   alpine 官方镜像没有 su-exec/gosu，`apk add` 在部分网络下会因访问不到
  #   dl-cdn.alpinelinux.org 而失败，导致整个构建中断；node 无需额外安装。
  DROP="$SELF_DIR/entrypoint-drop.mjs"
  if [ ! -f "$DROP" ]; then
    echo "[entrypoint] ⚠ 缺少降权脚本 $DROP，将以 root 运行业务进程" >&2
    echo "[entrypoint]   请重新构建镜像：docker compose up -d --build" >&2
    exec "$@"
  fi
  exec node "$DROP" "$PUID:$PGID" "$@"
fi

# 非 root 启动（docker run --user / compose 的 user:）：属主已由调用方决定，直接执行
exec "$@"
