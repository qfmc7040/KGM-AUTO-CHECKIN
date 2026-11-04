// kgcheckin 容器降权执行器：按 PUID:PGID 降低权限后运行容器命令。
//
// 为什么不用 su-exec / gosu：
//   alpine 官方镜像里没有它们，安装需要 `apk add`，而部分用户网络访问不到
//   dl-cdn.alpinelinux.org（构建直接失败）。镜像本身自带 node，用 node 的
//   setgid/setuid 完成同样的降权，零额外依赖、离线也能构建。
//
// 用法（由 docker/entrypoint.sh 在 root 分支调用）：
//   node entrypoint-drop.mjs <uid:gid> <cmd> [args...]
//
// 行为：
// - 清空附加组 → setgid → setuid（顺序不能反，setuid 之后再改 gid 就没权限了）；
// - 参数原样透传给目标进程（不经过 shell，不存在引号/转义问题）；
// - 转发 SIGTERM / SIGINT / SIGHUP / SIGQUIT，让 `docker stop` 能正常结束业务进程；
// - 目标进程的退出码原样返回（被信号杀死时按 128+signal 返回）。
import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'

const [spec, cmd, ...args] = process.argv.slice(2)

if (!spec || !cmd) {
  console.error('[entrypoint] 用法: entrypoint-drop.mjs <uid:gid> <cmd> [args...]')
  process.exit(2)
}

const parts = spec.split(':')
const [uidText, gidText] = parts
// 必须是严格的「数字:数字」，避免 '1026:'、'1026:abc'、'1:2:3' 之类被 Number() 静默转成 0
const valid = parts.length === 2 && /^\d+$/.test(uidText ?? '') && /^\d+$/.test(gidText ?? '')
const uid = valid ? Number(uidText) : NaN
const gid = valid ? Number(gidText) : NaN
if (!valid || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
  console.error(`[entrypoint] 无效的 uid:gid: ${spec}`)
  process.exit(2)
}

// 仅在确实需要时切换，避免非 root 场景下 setgroups 抛出 EPERM。
const isPosix = typeof process.getuid === 'function'
try {
  if (isPosix && typeof process.getgroups === 'function') {
    const groups = process.getgroups()
    // 附加组里只要还有别的 gid 就清空（root 才能做，正好对应调用场景）
    if (groups.length > 1 || (groups.length === 1 && groups[0] !== gid)) {
      process.setgroups([gid])
    }
  }
  if (isPosix && process.getgid() !== gid) process.setgid(gid)
  if (isPosix && process.getuid() !== uid) process.setuid(uid)
} catch (error) {
  console.error(`[entrypoint] ⚠ 无法切换到 ${uid}:${gid}（${error.code || error.message}）`)
  console.error('[entrypoint]   容器是否以 root 启动？或 PUID/PGID 是否被限制？')
  process.exit(1)
}

if (isPosix && (process.getuid() !== uid || process.getgid() !== gid)) {
  console.error(`[entrypoint] ⚠ 降权后身份仍是 ${process.getuid()}:${process.getgid()}，期望 ${uid}:${gid}`)
  process.exit(1)
}

const child = spawn(cmd, args, { stdio: 'inherit', env: process.env })

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
  process.on(signal, () => {
    // 子进程已退出时 kill 会返回 false，忽略即可
    child.kill(signal)
  })
}

child.on('error', (error) => {
  console.error(`[entrypoint] ⚠ 无法启动 ${cmd}: ${error.message}`)
  process.exit(127)
})

child.on('exit', (code, signal) => {
  if (signal) {
    const number = osConstants.signals[signal] ?? 1
    process.exit(128 + number)
  }
  process.exit(code === null ? 1 : code)
})
