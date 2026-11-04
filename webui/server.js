/**
 * kgcheckin WebUI 服务。
 *
 * 容器内一体化运行：
 *   - Web 控制台（扫码登录 / 手机号登录 / 一键签到 / 账号管理）
 *   - 内置定时调度（node-cron，替代独立 scheduler 进程）
 *   - 常驻酷狗 API 服务子进程（端口 WEBUI_API_PORT，懒启动 + 空闲自动关闭）供登录类操作使用
 *   - 签到任务以子进程运行 main.js，其 API 服务使用独立端口 CHECKIN_API_PORT，与登录服务互不冲突
 *
 * 环境变量：
 *   WEBUI_PORT        Web 控制台监听端口（默认 3000）
 *   WEBUI_PASSWORD    可选访问密码；设置后所有 /api/* 需携带 X-WebUI-Key 头（或 ?key= 查询参数，供 SSE 使用）
 *   WEBUI_TRUST_PROXY 反向代理部署时设置（如 "1"）：信任 X-Forwarded-For 以取真实 IP。
 *                     未设置时不信任该头，避免伪造 IP 绕过按 IP 的防爆破计数。
 *   ACCOUNTS_PASSWORD admin 管理员密码；设置后 admin 可查看/管理所有账号（未设置则 admin 不可用）
 *   ACCOUNTS_BOOTSTRAP_PASSWORD 首次启动（尚无 accounts_auth.json）时用它初始化 admin 密码
 *   ACCOUNTS_DISABLE_ID_DEFAULT 设为 true 时关闭「未设密码账号可用酷狗ID 登录」（默认允许，便于首次改密）。
 *                     酷狗ID 并非秘密，公网暴露时建议设 true 并让 admin 预先分发密码。
 *   ACCOUNTS_MAX_ATTEMPTS 单账号连续错误锁定阈值（默认 3）
 *   ACCOUNTS_IP_MAX_ATTEMPTS 单 IP 连续错误锁定阈值（默认 ACCOUNTS_MAX_ATTEMPTS × 5）
 *   ACCOUNTS_LOCK_MINUTES 锁定时长（默认 5 分钟）
 *   WEBUI_API_PORT    登录用 API 服务端口（默认 3010）
 *   CHECKIN_API_PORT  签到子进程 API 服务端口（默认 3020）
 *   WEBUI_PHONE_SEND_GLOBAL_LIMIT  发送验证码的全局限流，格式 "次数/分钟"（默认 "20/60"，即全服务每小时 20 次）
 *   WEBUI_PHONE_SEND_PHONE_LIMIT 发送验证码的手机号限流，格式 "次数/分钟"（默认 "2/1440"，即每号 24 小时 2 次）
 *   WEBUI_QR_GEN_IP_LIMIT        生成登录二维码的 IP 限流，格式 "次数/分钟"（默认 "1/3"，即每 IP 3 分钟 1 次）
 *   WEBUI_EMAIL_SEND_USER_LIMIT  发送邮箱验证码的单账号限流，格式 "次数/分钟"（默认 "3/60"）
 *                     除二维码生成外，各项限流均按账号/手机号/全局计数，不依赖来源 IP——
 *                     容器端口映射下 req.ip 恒为网桥地址，反向代理下又取自可伪造的
 *                     X-Forwarded-For，按 IP 计数在两种部署下都没有意义。二维码生成仍按 IP
 *                     并对「内网/本机」豁免，此时反向代理部署必须正确设置 WEBUI_TRUST_PROXY，
 *                     否则公网请求会被视为来自代理内网地址而全部豁免。
 *   MAIL_FROM_NAME    邮件发件人显示名（默认「酷狗签到助手」）
 *   MAIL_INVALID_NOTIFY  是否在账号登录凭据失效时给该账号绑定的邮箱发提醒（默认开启，设 false 关闭）
 *   MAIL_NOTICE_COOLDOWN_DAYS 同一账号的失效提醒最小间隔天数（默认 7）
 *   CRON_SCHEDULE     签到计划任务（默认 "10 1 * * *"，每天北京时间 01:10）
 *   CRON_TIMEZONE     调度时区（默认 Asia/Shanghai）
 *   RUN_ON_STARTUP    "true" 时容器启动后立即执行一次签到
 *   USERINFO_FILE     凭据文件路径（Docker 镜像默认 /app/data/userinfo.json）
 */

import express from 'express'
import cron from 'node-cron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

import { close_api, delay, send, startService, waitForApi } from '../utils/utils.js'
import { upsertUser, writeUserinfoFile, parseUserinfoJson, probeDirWritable } from '../utils/userinfo.js'
import { buildDeviceCookie, generateDevice, migrateUserinfoDevice } from '../utils/device.js'
import { maskEmail, maskIdentifier, summarizeResponse } from '../utils/safeLog.js'
import { printGreen, printMagenta, printRed, printYellow } from '../utils/colorOut.js'
import { nextCronRuns } from '../utils/date.js'
import { clearInvalidCredential, readCheckinStatus } from '../utils/checkinStatus.js'
import {
  MAX_BODY_LENGTH,
  MAX_ITEMS,
  MAX_TITLE_LENGTH,
  normalizeAnnouncement,
  readAnnouncements,
  sortAnnouncements,
  validateAnnouncement,
  visibleAnnouncements,
  writeAnnouncements,
} from '../utils/announcements.js'
import {
  buildEmailCodeMail,
  clearMailNotice,
  genEmailCode,
  invalidNotifyEnabled,
  isValidEmail,
  mailConfigReady,
  noticeCooldownMs,
  sendAccountMail,
} from '../utils/mailNotice.js'

const require = createRequire(import.meta.url)
const QRCode = require('qrcode')

/**
 * 懒加载 api 侧的设备标识工具（calculateMid / isUUIDv4）。
 * api/ 是独立 CJS 包（依赖装在 api/node_modules）。加载失败只影响启动横幅那一行，
 * 不能让整个 WebUI 起不来，因此返回 null 由调用方降级处理。
 * @returns {{calculateMid: Function, isUUIDv4: Function}|null}
 */
let apiDeviceUtil
function loadApiDeviceUtil() {
  if (apiDeviceUtil !== undefined) return apiDeviceUtil
  try {
    const util = require('../api/util/util.js')
    apiDeviceUtil = { calculateMid: util.calculateMid, isUUIDv4: util.isUUIDv4 }
  } catch {
    apiDeviceUtil = null
  }
  return apiDeviceUtil
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ────────────────────────── 配置 ──────────────────────────

/**
 * 解析布尔型环境变量：只有 1/true/yes/on 视为开启。
 * 直接写 `if (process.env.X)` 会把 "0"、"false" 这类字符串也当成开启。
 */
function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase())
}

/**
 * 解析 WEBUI_TRUST_PROXY：既支持布尔开关，也支持「信任的代理跳数」。
 * 返回 false 表示不信任；true 表示信任全部；数字表示信任的跳数。
 */
function parseTrustProxy(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s || ['0', 'false', 'no', 'off'].includes(s)) return false
  if (['true', 'yes', 'on'].includes(s)) return true
  const hop = parseInt(s, 10)
  return Number.isInteger(hop) && hop > 0 ? hop : false
}

const WEBUI_PORT = Number(process.env.WEBUI_PORT || 3000)
const WEBUI_PASSWORD = String(process.env.WEBUI_PASSWORD || '').trim()
// 仅当显式配置时才信任 X-Forwarded-For（反向代理部署）。默认关闭：
// 无条件信任会让攻击者伪造 XFF 头绕过按 IP 的防爆破计数。
const WEBUI_TRUST_PROXY_RAW = process.env.WEBUI_TRUST_PROXY
const WEBUI_TRUST_PROXY = parseTrustProxy(WEBUI_TRUST_PROXY_RAW)
const ACCOUNTS_PASSWORD = String(process.env.ACCOUNTS_PASSWORD || '').trim()
const ACCOUNTS_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.ACCOUNTS_MAX_ATTEMPTS || '3', 10))
const ACCOUNTS_LOCK_MINUTES = Math.max(0.01, parseFloat(process.env.ACCOUNTS_LOCK_MINUTES || '5'))
const ACCOUNTS_LOCK_MS = ACCOUNTS_LOCK_MINUTES * 60 * 1000
// per-IP 阈值放宽（同 NAT 下多个用户不应互相拖累）；per-账号桶仍用 ACCOUNTS_MAX_ATTEMPTS
const ACCOUNTS_IP_MAX_ATTEMPTS = Math.max(
  ACCOUNTS_MAX_ATTEMPTS,
  parseInt(process.env.ACCOUNTS_IP_MAX_ATTEMPTS || String(ACCOUNTS_MAX_ATTEMPTS * 5), 10) || ACCOUNTS_MAX_ATTEMPTS * 5
)
// 未设置密码的账号是否允许以「酷狗ID 作为默认密码」登录（默认允许，便于用户首次改密）。
// 设为 true 可关闭该行为，此时未设密码的账号必须由 admin 先设置密码。
// ⚠ 酷狗ID 并非秘密，开启默认密码意味着知道 ID 的人即可登录并改密，公网部署请谨慎。
const ACCOUNTS_DISABLE_ID_DEFAULT = envFlag('ACCOUNTS_DISABLE_ID_DEFAULT')
// 首次启动用于初始化 admin 的引导密码（accounts_auth.json 不存在时使用）
const ACCOUNTS_BOOTSTRAP_PASSWORD = String(process.env.ACCOUNTS_BOOTSTRAP_PASSWORD || '').trim()
const WEBUI_API_PORT = process.env.WEBUI_API_PORT || '3010'
const CHECKIN_API_PORT = process.env.CHECKIN_API_PORT || '3020'
const SCHEDULE = process.env.CRON_SCHEDULE || '10 1 * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Shanghai'
const RUN_ON_STARTUP = envFlag('RUN_ON_STARTUP')
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000

// ── 手动「立即签到」限流 ──
// 防止反复触发签到（每次都会拉起 API 子进程并请求酷狗接口）。
// 只按账号维度计数（见下面的 CHECKIN_PER_USERID_DAILY），不按来源 IP：
// 端口映射部署下 req.ip 恒为网桥地址，开 trust proxy 后又取自可伪造的
// X-Forwarded-For，两种情况下按 IP 计数都不可靠。

// ── 单账号签到的每日配额 ──
// 按 userid 计数（不分 IP）：每天最多 CHECKIN_PER_USERID_DAILY 次。
// 这是「单账号签到」唯一的限流维度；
// admin 验证后的「全部账号签到」不占用该配额。
const CHECKIN_PER_USERID_DAILY = (() => {
  const raw = String(process.env.CHECKIN_PER_USERID_DAILY ?? '').trim()
  if (raw === '') return 2
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 2
})()
// userid -> { date: 'YYYY-MM-DD', count: N, lastAt: ms }
const perUseridUsage = new Map()
const PER_USERID_MAP_MAX = 5000

/** 北京时间日期字符串（与 main.js 的调度口径一致）。 */
function beijingToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/**
 * 查询某 userid 今日已用次数。
 * @param {string} userid
 * @returns {{ used: number, limit: number, remaining: number }}
 */
function perUseridQuota(userid) {
  const today = beijingToday()
  const rec = perUseridUsage.get(String(userid))
  const used = rec && rec.date === today ? rec.count : 0
  return { used, limit: CHECKIN_PER_USERID_DAILY, remaining: Math.max(0, CHECKIN_PER_USERID_DAILY - used) }
}

/** 记录某 userid 的一次单账号签到（跨天自动归零）。 */
function markPerUseridUsed(userid) {
  if (CHECKIN_PER_USERID_DAILY <= 0) return
  const today = beijingToday()
  const key = String(userid)
  const rec = perUseridUsage.get(key)
  const count = rec && rec.date === today ? rec.count + 1 : 1
  perUseridUsage.set(key, { date: today, count, lastAt: Date.now() })
  if (perUseridUsage.size > PER_USERID_MAP_MAX) {
    for (const [k, v] of perUseridUsage) {
      if (v.date !== today) perUseridUsage.delete(k)
    }
  }
}

// ── 通用滑动窗口限流 ──
// 保护会向酷狗发起真实请求、且可被公网匿名调用的接口（发送验证码 / 生成登录二维码）。
// 采用时间戳数组的滑动窗口：窗口内计数达到上限即拒绝，并返回剩余等待时间。
// 按账号/手机号计数的桶不依赖来源 IP；仅二维码生成仍按 IP，且内网/本机豁免。

/**
 * 解析 "次数/分钟" 形式的限流配置，为空或非法时回落默认值。
 * @param {string|undefined} raw
 * @param {number} defCount
 * @param {number} defMinutes
 * @returns {{ count: number, windowMs: number }}
 */
function parseRateSpec(raw, defCount, defMinutes) {
  const fallback = { count: defCount, windowMs: defMinutes * 60 * 1000 }
  const s = String(raw ?? '').trim()
  if (s === '') return fallback
  const m = s.match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)$/)
  if (!m) return fallback
  const count = parseInt(m[1], 10)
  const minutes = parseFloat(m[2])
  if (!Number.isFinite(count) || !Number.isFinite(minutes)) return fallback
  return { count, windowMs: minutes * 60 * 1000 }
}

// 以下限流除二维码生成外均不依赖来源 IP：容器端口映射下 req.ip 恒为网桥地址
// （如 172.17.0.1），开 trust proxy 后又取自可伪造的 X-Forwarded-For，
// 按 IP 计数在两种部署下都无法代表真实调用方。
const PHONE_SEND_GLOBAL_LIMIT = parseRateSpec(process.env.WEBUI_PHONE_SEND_GLOBAL_LIMIT, 20, 60)
const PHONE_SEND_PHONE_LIMIT = parseRateSpec(process.env.WEBUI_PHONE_SEND_PHONE_LIMIT, 2, 24 * 60)
const QR_GEN_IP_LIMIT = parseRateSpec(process.env.WEBUI_QR_GEN_IP_LIMIT, 1, 3)
// 邮箱验证码会真实发出邮件：按目标账号限制，防止针对某个账号反复触发、
// 把别人的收件箱当靶子。该接口已由 accountsGuard 认证为本人（或 admin），
// 调用方身份明确，无需再叠加不可靠的 IP 维度。
const EMAIL_SEND_USER_LIMIT = parseRateSpec(process.env.WEBUI_EMAIL_SEND_USER_LIMIT, 3, 60)

// key -> 窗口内命中时间戳数组（递增）。桶数超过 RATE_MAP_MAX 时清理过期桶，避免内存无限增长。
const rateBuckets = new Map()
const RATE_MAP_MAX = 5000

/** 取桶并丢弃窗口外的旧时间戳。 */
function rateBucket(key, windowMs) {
  const now = Date.now()
  const cutoff = now - windowMs
  let hits = rateBuckets.get(key)
  if (!hits) {
    hits = []
    rateBuckets.set(key, hits)
  }
  while (hits.length && hits[0] <= cutoff) hits.shift()
  if (rateBuckets.size > RATE_MAP_MAX) {
    for (const [k, v] of rateBuckets) {
      if (!v.length || v[v.length - 1] <= cutoff) rateBuckets.delete(k)
    }
  }
  return hits
}

/**
 * 检查并记录一次访问。
 * @param {string} key 桶标识（含维度前缀，如 `sms:phone:13800138000`、`qr:1.2.3.4`）
 * @param {{ count: number, windowMs: number }} spec
 * @returns {{ allowed: boolean, retryAfterMs: number }}
 */
function rateLimitHit(key, spec) {
  if (!spec || spec.count <= 0 || spec.windowMs <= 0) return { allowed: true, retryAfterMs: 0 }
  const hits = rateBucket(key, spec.windowMs)
  if (hits.length >= spec.count) {
    return { allowed: false, retryAfterMs: Math.max(0, hits[0] + spec.windowMs - Date.now()) }
  }
  hits.push(Date.now())
  return { allowed: true, retryAfterMs: 0 }
}

/** 剩余秒数的人类可读形式。 */
function formatWait(secs) {
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600)
    const m = Math.ceil((secs % 3600) / 60)
    return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`
  }
  if (secs >= 60) return `${Math.ceil(secs / 60)} 分钟`
  return `${secs} 秒`
}

/** 限流规格的可读描述（启动横幅用）。 */
function describeRateLimit(spec) {
  if (!spec || spec.count <= 0 || spec.windowMs <= 0) return '已关闭'
  return `每 ${formatWait(Math.round(spec.windowMs / 1000))} ${spec.count} 次`
}

/**
 * 把本地 API 服务的失败响应拼成一行可读原因（用于报错文案）。
 * 酷狗业务失败会带 error_code（如 20006 = appid/clientver/mid/dfid 不对）；
 * 本地网络/代理异常只有 msg（api 侧构造的 `{ status: 0, msg }`）。
 * @param {any} r 本地 API 返回的 JSON
 * @returns {string} 形如 "status=0，error_code=20006，msg=err appid(srcappid) or ..."
 */
function formatApiFailure(r) {
  const parts = [`status=${r?.status ?? 'unknown'}`]
  const errorCode = r?.error_code ?? r?.errcode
  if (errorCode !== undefined && errorCode !== null) parts.push(`error_code=${errorCode}`)
  const msg = r?.msg || r?.error_msg || r?.message
  if (msg) parts.push(`msg=${String(msg).slice(0, 200)}`)
  return parts.join('，')
}

/**
 * 描述当前生效的设备标识 MID（启动横幅用，脱敏展示）。
 *
 * 与 api/server.js 的取值规则保持一致：
 *   1. KUGOU_API_MID 显式指定时直接使用；
 *   2. 否则由 KUGOU_API_GUID 派生（UUID v4 先 MD5，再 calculateMid）；
 *   3. 两者都没有时 api 每次启动随机生成 —— 设备标识不稳定，酷狗可能返回
 *      status=0 / error_code=20006，或静默丢弃验证码短信。
 *
 * 注意：这里读的是本进程 process.env，也正是 utils/pickApiEnv 传给 api 子进程的值。
 * WebUI 不自行加载 .env（Docker 部署由 docker-compose 注入变量）。
 *
 * @returns {{ configured: boolean, text: string }}
 */
function describeDeviceMid() {
  const envMid = String(process.env.KUGOU_API_MID ?? '').trim()
  if (envMid) return { configured: true, text: `${maskIdentifier(envMid)}（来自 KUGOU_API_MID）` }

  const envGuid = String(process.env.KUGOU_API_GUID ?? '').trim()
  if (envGuid) {
    const util = loadApiDeviceUtil()
    if (util) {
      const seed = util.isUUIDv4(envGuid) ? crypto.createHash('md5').update(envGuid).digest('hex') : envGuid
      return { configured: true, text: `${maskIdentifier(util.calculateMid(seed))}（由 KUGOU_API_GUID 派生）` }
    }
    return { configured: true, text: '由 KUGOU_API_GUID 派生（无法预演，详见 api 日志）' }
  }

  return { configured: false, text: '随机（未配置 KUGOU_API_GUID / KUGOU_API_MID）' }
}

/**
 * 超过限流时抛出 429（错误中间件会附带 Retry-After 头与响应体 retryAfter 字段）。
 * @param {string} key
 * @param {{ count: number, windowMs: number }} spec
 * @param {string} label 提示语主语，如「验证码发送」
 */
function enforceRateLimit(key, spec, label) {
  const r = rateLimitHit(key, spec)
  if (r.allowed) return
  const secs = Math.max(1, Math.ceil(r.retryAfterMs / 1000))
  const err = new Error(`${label}过于频繁，请 ${formatWait(secs)}后再试`)
  err.status = 429
  err.code = 'rate-limited'
  err.retryAfterMs = r.retryAfterMs
  throw err
}

// 本进程内 utils（startService/send/waitForApi）统一使用登录专用端口
process.env.API_PORT = WEBUI_API_PORT
if (!process.env.USERINFO_FILE) {
  process.env.USERINFO_FILE = path.join(ROOT, 'data', 'userinfo.json')
}
const USERINFO_FILE = process.env.USERINFO_FILE

/**
 * 凭据目录可写性自检结果（启动时探测一次，之后在每次写失败后重新探测）。
 * 目的：把「扫码登录成功但没保存」的沉默失败，变成启动横幅 + 顶栏徽章 + 登录弹窗
 * 三处都能看见的明确提示，并直接给出宿主机侧的修复命令。
 * Docker 场景的典型成因：宿主机 ./data 由 sudo 或 Docker 守护进程以 root 创建，
 * 容器内普通用户（uid 1000）既不能建 .tmp 也不能 rename。
 */
const dataDir = path.dirname(USERINFO_FILE)
const dataWritable = probeDirWritable(dataDir)

/** 重新探测可写性（写失败后调用，避免一次探测结果长期误导） */
function recheckDataWritable() {
  const r = probeDirWritable(dataDir)
  dataWritable.writable = r.writable
  dataWritable.reason = r.reason
  return dataWritable.writable
}

/** 当前进程 uid/gid，用于给出准确的 chown 命令（非 Linux 环境下 getuid 不存在，回落 1000） */
function currentUidGid() {
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
    gid: typeof process.getgid === 'function' ? process.getgid() : 1000,
  }
}

const BOOT_AT = new Date().toISOString()

// ────────────────────────── 凭据文件 ──────────────────────────

function readUserinfo() {
  try {
    // parseUserinfoJson 兼容 UTF-8 BOM（Windows 记事本保存的文件）
    return parseUserinfoJson(fs.readFileSync(USERINFO_FILE, 'utf8')) || []
  } catch {
    return []
  }
}

function readUserinfoRaw() {
  try {
    // 去除 BOM 后作为整体文本传给签到子进程（main.js 侧亦有兜底解析）
    return fs.readFileSync(USERINFO_FILE, 'utf8').replace(/^\uFEFF/, '').trim()
  } catch {
    return ''
  }
}

function saveUserinfo(arr) {
  const ok = writeUserinfoFile(JSON.stringify(arr))
  // 写失败后立刻复测目录：若是权限问题，前端徽章与登录提示会据此给出修复命令
  if (!ok) recheckDataWritable()
  return ok
}

/**
 * 启动时一次性迁移：给缺少设备标识的账号条目补上全局固定标识。
 * 修改后立即落盘（幂等：已有 device 的条目不动）。
 */
function migrateDevicesOnBoot() {
  try {
    const arr = readUserinfo()
    const changed = migrateUserinfoDevice(arr)
    if (changed > 0) {
      saveUserinfo(arr)
      printYellow(`[webui] 已为 ${changed} 个存量账号补齐设备标识（全局固定值）`)
    }
  } catch { /* 迁移失败不阻断启动 */ }
}

// ────────────────────────── 登录用 API 服务管理 ──────────────────────────
// 懒启动 + 引用计数 + 空闲超时自动关闭；登录操作按请求短暂持有。

const loginApi = {
  child: null,
  refCount: 0,
  idleTimer: null,
  starting: null,

  async acquire() {
    if (this.starting) await this.starting
    if (!this.child) {
      this.starting = (async () => {
        printYellow(`[webui] 启动本地 API 服务 (port ${WEBUI_API_PORT})...`)
        const child = startService()
        try {
          await waitForApi(undefined, 30000)
        } catch (e) {
          close_api(child)
          throw e
        }
        this.child = child
        printGreen('[webui] 本地 API 服务已就绪')
      })()
      try {
        await this.starting
      } finally {
        this.starting = null
      }
    }
    this.refCount++
    clearTimeout(this.idleTimer)
  },

  release() {
    this.refCount = Math.max(0, this.refCount - 1)
    if (this.refCount === 0) {
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.shutdown(), IDLE_SHUTDOWN_MS)
    }
  },

  shutdown() {
    if (!this.child) return
    close_api(this.child)
    this.child = null
    printYellow('[webui] 本地 API 服务空闲，已关闭')
  },

  running() {
    return Boolean(this.child)
  },
}

/** 在持有 API 服务期间执行 fn（自动获取/释放） */
async function withApi(fn) {
  await loginApi.acquire()
  try {
    return await fn()
  } finally {
    loginApi.release()
  }
}

// ────────────────────────── 签到任务 ──────────────────────────

const LOG_BUFFER_MAX = 800
const checkinState = {
  running: false,
  lastRun: null, // { startedAt, endedAt, exitCode, ok, trigger }
  logs: [],      // 环形缓冲 { ts, level, text }，text 含原始 ANSI 转义
  sseClients: new Set(),
}

function pushLog(level, text) {
  const entry = { ts: new Date().toISOString(), level, text }
  checkinState.logs.push(entry)
  if (checkinState.logs.length > LOG_BUFFER_MAX) {
    checkinState.logs.splice(0, checkinState.logs.length - LOG_BUFFER_MAX)
  }
  // 同步镜像到容器 stdout，保证 docker compose logs 也能看到签到明细
  console.log(`[checkin] ${text}`)
  const payload = `data: ${JSON.stringify(entry)}\n\n`
  for (const client of checkinState.sseClients) {
    try { client.write(payload) } catch { /* 断开的连接在 close 时清理 */ }
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of checkinState.sseClients) {
    try { client.write(payload) } catch { /* ignore */ }
  }
}

/**
 * 启动一次签到子进程（node main.js）。
 * 子进程通过 API_PORT 使用独立端口拉起自己的 API 服务，与登录服务互不冲突；
 * 凭据优先取挂载卷文件内容，其次继承环境变量 USERINFO。
 */
/**
 * 结束一次签到：复位运行状态并广播（exit 与 spawn error 共用）。
 * 重复调用是安全的（状态已复位也只会再广播一次结束事件）。
 * @param {number} exitCode
 */
function finishCheckin(exitCode) {
  checkinState.running = false
  checkinState.currentOnlyUserid = null
  checkinState.lastRun = {
    ...checkinState.lastRun,
    endedAt: new Date().toISOString(),
    exitCode,
    ok: exitCode === 0,
    running: false,
  }
  pushLog(exitCode === 0 ? 'ok' : 'err', `────── 签到任务结束（退出码 ${exitCode}）──────`)
  broadcast('end', checkinState.lastRun)
}

function startCheckin(trigger = 'manual', options = {}) {
  if (checkinState.running) return false

  // 单账号模式：仅把该账号的凭据传给子进程，实现"用 userid 执行对应账号的签到"
  const onlyUserid = options.onlyUserid ? String(options.onlyUserid) : null

  checkinState.running = true
  const startedAt = new Date().toISOString()
  checkinState.lastRun = { startedAt, trigger, running: true, onlyUserid }
  checkinState.currentOnlyUserid = onlyUserid

  const triggerLabel = trigger === 'cron' ? '定时调度'
    : trigger === 'startup' ? '启动触发'
    : onlyUserid ? `手动触发 · 账号 ${maskIdentifier(onlyUserid)}`
    : '手动触发'
  pushLog('sys', `────── 签到任务开始（${triggerLabel} · ${startedAt}）──────`)
  broadcast('start', checkinState.lastRun)

  let userinfoRaw = readUserinfoRaw()
  if (onlyUserid) {
    // 只保留目标账号；从原始数组过滤，确保其它账号的 token 完全不进入子进程
    try {
      const arr = parseUserinfoJson(userinfoRaw) || []
      const target = arr.filter(u => String(u.userid) === onlyUserid)
      userinfoRaw = JSON.stringify(target)
    } catch {
      userinfoRaw = ''
    }
  }

  // 凭据通过 stdin 传给子进程，而不是放进环境变量：
  // 环境变量可被同容器/同主机的其他进程经 /proc/<pid>/environ 读取，等于把 token 暴露给任意进程。
  const env = { ...process.env, API_PORT: CHECKIN_API_PORT }
  delete env.USERINFO           // 防止父进程环境变量里的旧凭据泄漏给子进程
  if (userinfoRaw) env.USERINFO_STDIN = '1'
  // 手动触发时跳过当日已完成签到的账号（定时/启动触发不设置，保持完整执行）
  if (trigger === 'manual') {
    env.CHECKIN_SKIP_DONE = '1'
  }
  // 让子进程把各账号的 VIP 到期时间写盘，供「账号管理」面板展示
  // （日志里不再刷「VIP到期时间」，避免每账号 2 行噪音）
  env.CHECKIN_STATUS_FILE = checkinStatusFile()

  let child
  try {
    child = spawn(process.execPath, [path.join(ROOT, 'main.js')], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (e) {
    // 某些环境下 spawn 会同步抛错（如沙箱 EPERM）；必须复位状态，否则永久 409
    pushLog('err', `签到进程启动失败：${e.message}`)
    finishCheckin(1)
    throw e
  }

  // 写入凭据后立即关闭 stdin，供子进程读取
  if (userinfoRaw) {
    child.stdin.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ })
    child.stdin.end(userinfoRaw, 'utf8')
  } else {
    child.stdin.end()
  }

  const onStream = buf => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (line.trim()) pushLog('log', line)
    }
  }
  child.stdout.on('data', onStream)
  child.stderr.on('data', onStream)

  child.on('error', err => {
    // spawn 失败（EPERM/ENOMEM/EACCES 等）时子进程不会触发 exit，若不在这里复位，
    // checkinState.running 会永久为 true，之后所有签到请求都返回 409。
    pushLog('err', `签到进程启动失败：${err.message}`)
    finishCheckin(1)
  })

  child.on('exit', code => {
    finishCheckin(code ?? 1)
  })

  return true
}

// ────────────────────────── 计划预览 ──────────────────────────

/** 预览 cron 接下来 n 次执行时间（按 CRON_TIMEZONE 时区计算） */
function nextRuns(n = 3) {
  return nextCronRuns(SCHEDULE, TIMEZONE, n)
}

// ────────────────────────── Express 应用 ──────────────────────────

const app = express()
app.disable('x-powered-by')
// 仅在显式配置 WEBUI_TRUST_PROXY 时才信任反向代理头（否则 XFF 可被伪造以绕过防爆破）
if (WEBUI_TRUST_PROXY !== false) {
  app.set('trust proxy', WEBUI_TRUST_PROXY)
}
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

/** 请求来源 IP（统一入口，便于后续调整代理策略） */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

/**
 * 归一化 IP：去掉 IPv4-mapped IPv6 前缀，便于统一比较。
 * @param {string} ip
 * @returns {string}
 */
function normalizeIp(ip) {
  const s = String(ip || '').trim().toLowerCase()
  return s.startsWith('::ffff:') ? s.slice(7) : s
}

/**
 * 是否为内网 / 本机地址（RFC1918 + 回环 + IPv6 链路本地与 ULA）。
 * 用于「手动签到」限流豁免：内网运维操作不应被外网防滥用策略误伤。
 * 注意：这只是可用性豁免，不是安全边界——外网请求经反向代理后 req.ip
 * 为代理内网地址时会被豁免，因此 WEBUI_TRUST_PROXY 必须正确配置。
 * @param {string} rawIp
 * @returns {boolean}
 */
function isPrivateIp(rawIp) {
  const ip = normalizeIp(rawIp)
  if (!ip) return false
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true
  // IPv6 链路本地 fe80::/10 与 ULA fc00::/7
  if (ip.includes(':')) return ip.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(ip)
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true                       // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true          // 192.168.0.0/16
  if (a === 169 && b === 254) return true          // 169.254.0.0/16（含 Docker 内网）
  if (a === 127) return true                       // 127.0.0.0/8
  return false
}

/** 计时安全的字符串比较（先散列到等长，避免时序侧信道） */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest()
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest()
  return crypto.timingSafeEqual(ha, hb)
}

// 可选访问密码：/api/* 需要 X-WebUI-Key 头（SSE 可用 ?key= 查询参数）
app.use('/api', (req, res, next) => {
  if (!WEBUI_PASSWORD) return next()
  const key = req.headers['x-webui-key'] || req.query.key
  if (safeEqual(key, WEBUI_PASSWORD)) return next()
  return res.status(401).json({ error: '未授权：请在页面右上角输入访问密码', code: 'webui-auth' })
})

// 容器健康检查端点：刻意放在密码校验之外且不访问 /api/*，
// 否则设置了 WEBUI_PASSWORD 后健康检查会因 401 而被误判为不健康。
// 仅回传存活信息，不泄露账号数量、调度配置等任何细节。
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, uptime: Math.floor(process.uptime()) })
})

// ── 账号管理模块独立密码锁（防爆破）──
// 与全局访问密码相互独立。防爆破采用「IP + 目标账号」双维度：
//   - per-IP：防止单机对多个账号扫描；阈值放宽（同 NAT 用户不应互相拖累）
//   - per-账号：防止分布式撞库针对同一账号
// 任一维度达到阈值即锁定，成功登录时两个桶同时清零。
const failsByIp = new Map()   // ip     -> { fails, lockUntil, lastFailAt }
const failsByAcct = new Map() // userid -> { fails, lockUntil, lastFailAt }
const FAILS_MAP_MAX = 2000
const FAILS_TTL_MS = 24 * 60 * 60 * 1000

function bucketState(map, key) {
  let st = map.get(key)
  if (!st) {
    st = { fails: 0, lockUntil: 0, lastFailAt: 0 }
    map.set(key, st)
  }
  // 惰性清理：Map 过大时移除「未锁定且超过 TTL」的条目，避免无界增长
  if (map.size > FAILS_MAP_MAX) {
    const now = Date.now()
    for (const [k, v] of map) {
      if (v.lockUntil < now && now - v.lastFailAt > FAILS_TTL_MS) map.delete(k)
    }
  }
  return st
}

/** 记录一次失败；返回本次是否触发锁定 */
function registerFail(map, key, threshold, now) {
  const st = bucketState(map, key)
  st.fails++
  st.lastFailAt = now
  if (st.fails >= threshold) {
    st.lockUntil = now + ACCOUNTS_LOCK_MS
    st.fails = 0
    return true
  }
  return false
}

function clearFails(map, key) {
  const st = map.get(key)
  if (st) { st.fails = 0; st.lockUntil = 0 }
}

/** ── 邮箱绑定票根 ──
 * 用户刚刚扫码 / 短信登录成功时，服务端签发一张短期票根，前端带着它调用邮箱接口，
 * 就无需再输入一次账号密码。票根只对「该登录成功的账号」有效，且：
 *   - 24 字节随机数，无法猜测；
 *   - 10 分钟过期（够用户收完邮件再回来填验证码）；
 *   - 只存在内存里，进程重启即全部失效（重启后重新登录即可）。
 */
const BIND_TICKETS = new Map()
const BIND_TICKET_TTL_MS = 10 * 60 * 1000
const BIND_TICKETS_MAX = 500

/** 为刚登录成功的账号签发票根，返回随机串 */
function issueBindTicket(userid) {
  const now = Date.now()
  // 惰性清理：过期条目 + 容量上限，避免内存随登录次数无界增长
  if (BIND_TICKETS.size > BIND_TICKETS_MAX) {
    for (const [k, v] of BIND_TICKETS) {
      if (v.expiresAt <= now) BIND_TICKETS.delete(k)
    }
    if (BIND_TICKETS.size > BIND_TICKETS_MAX) BIND_TICKETS.clear()
  }
  const token = crypto.randomBytes(24).toString('hex')
  BIND_TICKETS.set(token, { userid: String(userid), expiresAt: now + BIND_TICKET_TTL_MS })
  return token
}

/** 解析票根；无效/过期返回 null */
function readBindTicket(token) {
  const hit = BIND_TICKETS.get(String(token || ''))
  if (!hit) return null
  if (Date.now() > hit.expiresAt) {
    BIND_TICKETS.delete(String(token))
    return null
  }
  return hit
}

/** ── 每账号独立密码 + admin 管理员 ──
 * 密码哈希存于凭据同目录的 accounts_auth.json。
 * 存储格式：{ "<userid>": { algo:'scrypt', salt:'<hex>', hash:'<hex>' } }
 * 旧格式（裸 sha256 hex 字符串）在登录成功后惰性迁移为 scrypt。
 * 未设置过密码的账号，默认密码即其酷狗ID（便于用户登录后自助修改密码）；
 * 该行为可用 ACCOUNTS_DISABLE_ID_DEFAULT=true 关闭。
 * ⚠ 酷狗ID 并非秘密：保留默认密码意味着知道 ID 的人即可登录该账号并改密。
 * admin 为预留管理员账号，密码为环境变量 ACCOUNTS_PASSWORD（未设置则 admin 不可用）。
 */
const ACCOUNTS_AUTH_FILE = path.join(path.dirname(USERINFO_FILE), 'accounts_auth.json')

/** 旧版密码哈希（单轮 SHA-256 + 静态盐）——仅用于校验并迁移历史数据 */
function legacyHashAccountPassword(pwd) {
  return crypto.createHash('sha256').update(`kgcheckin:${pwd}`).digest('hex')
}

/** 生成 scrypt 密码记录 */
function makePasswordRecord(pwd) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(pwd), salt, 64).toString('hex')
  return { algo: 'scrypt', salt, hash }
}

/** 校验密码：兼容旧格式；返回 { ok, needsRehash } */
function verifyPassword(pwd, stored) {
  if (typeof stored === 'string') {
    // 旧格式：静态盐 SHA-256
    return { ok: safeEqual(legacyHashAccountPassword(pwd), stored), needsRehash: true }
  }
  if (!stored || stored.algo !== 'scrypt' || !stored.salt || !stored.hash) {
    return { ok: false, needsRehash: false }
  }
  try {
    const expected = Buffer.from(stored.hash, 'hex')
    const actual = crypto.scryptSync(String(pwd), stored.salt, expected.length)
    return { ok: crypto.timingSafeEqual(actual, expected), needsRehash: false }
  } catch {
    return { ok: false, needsRehash: false }
  }
}

function readAccountsAuth() {
  try {
    // 兼容 UTF-8 BOM
    return JSON.parse(fs.readFileSync(ACCOUNTS_AUTH_FILE, 'utf8').replace(/^﻿/, '')) || {}
  } catch { return {} }
}

/** 凭据文件是否已初始化（用于判断是否需要 bootstrap admin） */
function accountsAuthExists() {
  try { return fs.existsSync(ACCOUNTS_AUTH_FILE) } catch { return false }
}

function saveAccountsAuth(map) {
  const tmp = `${ACCOUNTS_AUTH_FILE}.tmp`
  try {
    fs.mkdirSync(path.dirname(ACCOUNTS_AUTH_FILE), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
    fs.renameSync(tmp, ACCOUNTS_AUTH_FILE)
    return true
  } catch (e) {
    printRed(`[webui] 写入账号密码文件失败：${e.message}`)
    // 与凭据文件同一目录，写失败多半也是权限问题：复测后让前端徽章同步显示
    recheckDataWritable()
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
    return false
  }
}

/** 启动时初始化：用 ACCOUNTS_BOOTSTRAP_PASSWORD 建立 admin 记录（仅首次） */
function bootstrapAccountsAuth() {
  if (!ACCOUNTS_BOOTSTRAP_PASSWORD) return
  if (accountsAuthExists()) return
  const map = { admin: makePasswordRecord(ACCOUNTS_BOOTSTRAP_PASSWORD) }
  if (saveAccountsAuth(map)) {
    printGreen('[webui] 已使用 ACCOUNTS_BOOTSTRAP_PASSWORD 初始化 admin 密码')
  }
}

/** 提取请求中提供的账号身份凭据（头 / 查询参数 / JSON body） */
function providedAccountsCreds(req) {
  const id = req.headers['x-accounts-id'] ?? req.query.id ?? req.body?.userid
  // 查询参数改用 accountsKey，避免与全局访问密码（?key=）及二维码 key 语义冲突
  const key = req.headers['x-accounts-key'] ?? req.query.accountsKey ?? req.body?.password
  return { id: id == null ? '' : String(id).trim(), key: key == null ? '' : String(key) }
}

/**
 * 校验身份。成功返回作用域 { admin:true } 或 { admin:false, userid, migrated }；
 * 失败返回 null；「需要先设置密码」返回 { needInitPassword:true }。
 */
function verifyAccountsCreds(id, key, req) {
  if (!id || !key) return null
  if (id === 'admin') {
    // admin 密码来源：ACCOUNTS_PASSWORD 环境变量，或 bootstrap 写入的哈希记录
    if (ACCOUNTS_PASSWORD && safeEqual(key, ACCOUNTS_PASSWORD)) return { admin: true }
    const storedAdmin = readAccountsAuth().admin
    if (storedAdmin) {
      const r = verifyPassword(key, storedAdmin)
      if (r.ok) return { admin: true }
    }
    return null
  }
  // 账号必须存在于凭据文件（防止任意 userid 探测登录）
  if (!readUserinfo().some(u => String(u.userid) === id)) return null

  const auth = readAccountsAuth()
  const stored = auth[id]

  if (!stored) {
    // 未设置过密码的账号：默认密码即酷狗ID（用户可凭此登录后自助修改密码）。
    //
    // ⚠ 安全提示：酷狗ID 并非秘密（账号列表接口会返回，用户之间也会互相告知），
    //   因此任何知道该 ID 的人都能登录此账号并修改密码，把号主锁在外面。
    //   该策略仅为"便于用户首次改密"而保留；若面板对公网暴露，建议：
    //     1) 设置 WEBUI_PASSWORD，或
    //     2) 由 admin 预先为各账号设置密码（设置后此分支不再生效），或
    //     3) 设置 ACCOUNTS_DISABLE_ID_DEFAULT=true 关闭该行为。
    if (ACCOUNTS_DISABLE_ID_DEFAULT) return { needInitPassword: true }
    if (safeEqual(key, id)) {
      return { admin: false, userid: id, mustChangePassword: true }
    }
    // 默认密码已启用但用户输入的不是酷狗ID：属于密码错误，必须计入失败次数，
    // 否则可对未设密码的账号无限次尝试（needInitPassword 不计失败）。
    return null
  }

  const { ok, needsRehash } = verifyPassword(key, stored)
  if (!ok) return null
  // 旧格式惰性迁移为 scrypt（失败不影响本次登录）
  if (needsRehash) {
    auth[id] = makePasswordRecord(key)
    saveAccountsAuth(auth)
  }
  return { admin: false, userid: id }
}

function accountsGuard(req, res, next) {
  const ip = clientIp(req)
  const now = Date.now()

  // 登录成功后签发的一次性票根可免密码通过：用户刚扫码/短信登录成功，
  // 此时让他再输一遍账号密码才能绑定邮箱是多余的门槛。
  // 票根本身就是登录凭据（随机 24 字节、10 分钟有效、仅对该账号有效），
  // 因此不降低安全性；密码路径的失败计数仍然照常工作。
  // 票根只放行「邮箱绑定」相关接口：登录凭据能证明本人身份，但不应顺带获得
  // 改密码 / 删除账号等面板权限（那些仍要求账号密码）。
  const bindTicket = String(req.body?.ticket ?? req.query?.ticket ?? '').trim()
  const isEmailPath = req.path.startsWith('/email/')
  if (bindTicket && isEmailPath) {
    const hit = readBindTicket(bindTicket)
    if (hit) {
      req.accountsScope = { admin: false, userid: hit.userid, viaTicket: true }
      return next()
    }
    // 票根过期/无效时必须直接报错，不能继续走下面的账号密码兜底：
    // 浏览器里可能还留着「上一次解锁的另一个账号」的凭据，兜底成功就会把用户在
    // 「账号 A」弹窗里填的邮箱悄悄绑到账号 B 上，属于错绑而非报错。
    return res.status(401).json({
      error: '登录票根已失效（10 分钟内有效），请重新登录该账号，或到「账号管理」解锁后再绑定邮箱',
      code: 'bind-ticket-expired',
    })
  }

  const ipSt = bucketState(failsByIp, ip)

  // 锁定期间一律拒绝（即使密码正确，防止绕过冷却继续尝试）
  if (ipSt.lockUntil > now) {
    const left = Math.ceil((ipSt.lockUntil - now) / 1000)
    return res.status(423).json({
      error: `账号管理已锁定，请 ${left} 秒后再试`,
      code: 'accounts-auth',
      retryAfter: left,
    })
  }

  const { id, key } = providedAccountsCreds(req)

  // per-账号锁定检查（与 IP 维度独立）
  if (id) {
    const acctSt = bucketState(failsByAcct, id)
    if (acctSt.lockUntil > now) {
      const left = Math.ceil((acctSt.lockUntil - now) / 1000)
      return res.status(423).json({
        error: `该账号尝试次数过多，请 ${left} 秒后再试`,
        code: 'accounts-auth',
        retryAfter: left,
      })
    }
  }

  // 未提供凭据不算失败：前端打开面板即会先请求，此处只提示需要凭据
  if (!id && !key) {
    return res.status(401).json({ error: '请输入酷狗ID和密码', code: 'accounts-auth', needPassword: true })
  }

  const scope = verifyAccountsCreds(id, key, req)

  if (scope && scope.needInitPassword) {
    // 未设置过密码且默认密码已被关闭（ACCOUNTS_DISABLE_ID_DEFAULT=true）
    return res.status(401).json({
      error: '该账号尚未设置密码，且默认密码已关闭；请联系管理员为其设置密码',
      code: 'accounts-auth',
      needInitPassword: true,
    })
  }

  if (scope) {
    clearFails(failsByIp, ip)
    if (id) clearFails(failsByAcct, id)
    req.accountsScope = scope
    return next()
  }

  // 失败：两个维度同时计数
  const acctLocked = id ? registerFail(failsByAcct, id, ACCOUNTS_MAX_ATTEMPTS, now) : false
  const ipLocked = registerFail(failsByIp, ip, ACCOUNTS_IP_MAX_ATTEMPTS, now)

  if (acctLocked) {
    printRed(`[webui] 账号管理：账号 ${maskIdentifier(id)} 连续 ${ACCOUNTS_MAX_ATTEMPTS} 次密码错误，锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`)
  }
  if (ipLocked) {
    printRed(`[webui] 账号管理：${ip} 连续 ${ACCOUNTS_IP_MAX_ATTEMPTS} 次密码错误，锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`)
    return res.status(423).json({
      error: `密码错误次数过多，已锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`,
      code: 'accounts-auth',
      retryAfter: Math.ceil(ACCOUNTS_LOCK_MS / 1000),
    })
  }
  if (acctLocked) {
    return res.status(423).json({
      error: `该账号密码错误次数过多，已锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`,
      code: 'accounts-auth',
      retryAfter: Math.ceil(ACCOUNTS_LOCK_MS / 1000),
    })
  }

  const acctLeft = id
    ? Math.max(0, ACCOUNTS_MAX_ATTEMPTS - bucketState(failsByAcct, id).fails)
    : Math.max(0, ACCOUNTS_MAX_ATTEMPTS - 1)
  printYellow(`[webui] 账号管理：${ip} 密码错误（第 ${ipSt.fails}/${ACCOUNTS_IP_MAX_ATTEMPTS} 次）`)
  return res.status(401).json({
    error: `酷狗ID或密码错误，剩余尝试次数 ${acctLeft}`,
    code: 'accounts-auth',
    attemptsLeft: acctLeft,
  })
}

/**
 * 校验 admin 凭据，并把失败计入与 /api/accounts 相同的防爆破桶。
 *
 * ⚠ /api/checkin/run 的「全部账号签到」不在 accountsGuard 作用域内。若此处不计失败，
 * 攻击者可在该端点上无限次猜解 admin 密码（两个入口共享同一份 admin 密码）。
 * 两个入口共用 failsByIp / failsByAcct，任一入口触发锁定即全局生效。
 *
 * @returns {{ scope: object|null, locked: boolean, retryAfter: number, message: string }}
 */
function verifyAdminGuarded(req) {
  const ip = clientIp(req)
  const now = Date.now()

  const ipSt = bucketState(failsByIp, ip)
  if (ipSt.lockUntil > now) {
    const left = Math.ceil((ipSt.lockUntil - now) / 1000)
    return { scope: null, locked: true, retryAfter: left, message: `尝试次数过多，已锁定，请 ${left} 秒后再试` }
  }
  const acctSt = bucketState(failsByAcct, 'admin')
  if (acctSt.lockUntil > now) {
    const left = Math.ceil((acctSt.lockUntil - now) / 1000)
    return { scope: null, locked: true, retryAfter: left, message: `admin 密码错误次数过多，已锁定，请 ${left} 秒后再试` }
  }

  const { id, key } = providedAccountsCreds(req)
  if (!id || !key) {
    // 未提供凭据不算失败（与 accountsGuard 一致）：用户可能只是先点了按钮，
    // 否则连点几次就会把 admin 把自己锁掉。
    return { scope: null, locked: false, retryAfter: 0, message: '全部账号签到需要管理员（admin）账号与密码验证' }
  }
  const scope = verifyAccountsCreds(id, key, req)
  if (scope && scope.admin) {
    clearFails(failsByIp, ip)
    clearFails(failsByAcct, 'admin')
    return { scope, locked: false, retryAfter: 0, message: '' }
  }

  // 失败：与 /api/accounts 完全一致的计数与阈值
  const acctLocked = registerFail(failsByAcct, 'admin', ACCOUNTS_MAX_ATTEMPTS, now)
  const ipLocked = registerFail(failsByIp, ip, ACCOUNTS_IP_MAX_ATTEMPTS, now)
  if (acctLocked || ipLocked) {
    printRed(`[webui] 全量签到：${ip} admin 验证连续失败，锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`)
    return {
      scope: null,
      locked: true,
      retryAfter: Math.ceil(ACCOUNTS_LOCK_MS / 1000),
      message: `密码错误次数过多，已锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`,
    }
  }
  const left = Math.max(0, ACCOUNTS_MAX_ATTEMPTS - bucketState(failsByAcct, 'admin').fails)
  return {
    scope: null,
    locked: false,
    retryAfter: 0,
    message: `管理员账号或密码错误，剩余尝试次数 ${left}`,
  }
}

app.use('/api/accounts', accountsGuard)

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

/** 校验酷狗手机号格式 */
function assertPhone(phone) {
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) {
    const err = new Error('手机号格式不正确')
    err.status = 400
    throw err
  }
}

// ── 状态 ──
app.get('/api/status', wrap(async (req, res) => {
  res.json({
    bootAt: BOOT_AT,
    schedule: {
      cron: SCHEDULE,
      timezone: TIMEZONE,
      valid: cron.validate(SCHEDULE),
      nextRuns: nextRuns(3),
      // 复杂 cron 表达式无法预览，前端据此给出提示而非显示空白
      previewSupported: nextRuns(1).length > 0,
    },
    checkin: {
      running: checkinState.running,
      lastRun: checkinState.lastRun,
    },
    // 只暴露账号数量；账号明细走受独立密码保护的 GET /api/accounts
    accountCount: readUserinfo().length,
    accountsLockEnabled: true,
    apiServiceRunning: loginApi.running(),
    // 凭据目录是否可写：前端据此在顶栏徽章与登录成功提示里如实告知「没保存」及原因
    credential: {
      file: USERINFO_FILE,
      dir: dataDir,
      writable: dataWritable.writable,
      reason: dataWritable.reason || '',
      ...currentUidGid(),
    },
  })
}))

/**
 * 公开的「账号过期」清单（不校验账号管理独立密码）。
 * 只返回 昵称 + 脱敏 userid + 检测日期，绝不返回完整 userid / token：
 * 目的是让用户在主窗口一眼看到「哪些账号过期了」，而账号明细仍走 /api/accounts。
 * 注意：仍受全局访问密码（WEBUI_PASSWORD）保护，那是整个 WebUI 的入口密码。
 */
app.get('/api/expired', wrap(async (req, res) => {
  const invalidCreds = readCheckinStatusFile().invalidCreds
  const accounts = readUserinfo()
    .filter(u => invalidCreds[String(u.userid)])
    .map(u => ({
      // 昵称取凭据文件里已缓存的（不为此额外请求酷狗接口，避免未授权请求与风控）
      nickname: u.nickname ? String(u.nickname) : null,
      useridMasked: maskIdentifier(u.userid),
      detectedAt: invalidCreds[String(u.userid)],
    }))
  res.json({ count: accounts.length, accounts })
}))

// ── 站点公告 ──
// 读取无需任何账号（登录页外的访客也能看到公告），但仍受全局访问密码保护；
// 发布 / 修改 / 删除必须通过 admin 验证，且与「账号管理」「全量签到」共用同一套
// 防爆破计数桶（failsByIp / failsByAcct('admin')），不额外发明权限模型。

/** 公告文件路径：与 checkinStatusFile 同样的推导方式，跟随 USERINFO_FILE 所在目录 */
function announcementsFile() {
  const base = process.env.USERINFO_FILE
    ? path.dirname(process.env.USERINFO_FILE)
    : path.join(ROOT, 'data')
  return path.join(base, 'announcements.json')
}

/** 读取全部公告（含草稿）；文件损坏时返回空列表，不抛异常 */
function readAnnouncementItems() {
  return readAnnouncements(announcementsFile())
}

/** admin 校验失败时抛出与其它管理接口一致的错误（423=锁定，401=未通过验证） */
function requireAnnouncementAdmin(req) {
  const admin = verifyAdminGuarded(req)
  if (admin.scope) return admin.scope
  const err = new Error(admin.message)
  err.status = admin.locked ? 423 : 401
  err.code = admin.locked ? 'accounts-auth' : 'admin-required'
  if (admin.retryAfter > 0) err.retryAfterMs = admin.retryAfter * 1000
  throw err
}

/** 把规范化后的公告落盘；失败时抛 500（公告文件不可写是服务端问题，不该静默吞掉） */
function persistAnnouncements(items) {
  const result = writeAnnouncements(announcementsFile(), items)
  if (!result.ok) {
    printRed(`[webui] 写入公告文件失败：${result.error}`)
    const err = new Error('公告保存失败：无法写入数据文件，请检查 data 目录权限')
    err.status = 500
    throw err
  }
}

/**
 * 公告列表（公开，不需要账号验证）。
 * 只返回非草稿公告：草稿是管理员写着还没发布的内容，不能提前泄漏给访客。
 */
app.get('/api/announcements', wrap(async (req, res) => {
  const { items, updatedAt } = readAnnouncementItems()
  const visible = visibleAnnouncements(items)
  res.json({
    count: visible.length,
    updatedAt,
    // 字段逐个挑出来返回，避免以后往文件里加了内部字段就被顺手暴露出去
    items: visible.map(it => ({
      id: it.id,
      title: it.title,
      body: it.body,
      level: it.level,
      pinned: it.pinned,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
    })),
  })
}))

/** 公告管理列表（admin）：含草稿，供「公告管理」标签页编辑 */
app.get('/api/announcements/manage', wrap(async (req, res) => {
  requireAnnouncementAdmin(req)
  const { items, updatedAt } = readAnnouncementItems()
  res.json({
    count: items.length,
    updatedAt,
    limits: { title: MAX_TITLE_LENGTH, body: MAX_BODY_LENGTH, items: MAX_ITEMS },
    items: sortAnnouncements(items),
  })
}))

/** 发布公告（admin） */
app.post('/api/announcements', wrap(async (req, res) => {
  requireAnnouncementAdmin(req)
  const { items } = readAnnouncementItems()
  if (items.length >= MAX_ITEMS) {
    const err = new Error(`公告数量已达上限（${MAX_ITEMS} 条），请先删除不再需要的公告`)
    err.status = 400
    throw err
  }
  const item = normalizeAnnouncement(req.body || {})
  const check = validateAnnouncement(item)
  if (!check.ok) {
    const err = new Error(check.error)
    err.status = 400
    throw err
  }
  persistAnnouncements([...items, item])
  res.status(201).json({ ok: true, item })
}))

/** 修改公告（admin）：id 与 createdAt 保持不变，其余字段整体覆盖 */
app.put('/api/announcements/:id', wrap(async (req, res) => {
  requireAnnouncementAdmin(req)
  const id = String(req.params.id || '').trim()
  const { items } = readAnnouncementItems()
  const index = items.findIndex(it => it.id === id)
  if (index < 0) {
    const err = new Error('公告不存在或已被删除')
    err.status = 404
    throw err
  }
  const item = normalizeAnnouncement(req.body || {}, { id, createdAt: items[index].createdAt })
  const check = validateAnnouncement(item)
  if (!check.ok) {
    const err = new Error(check.error)
    err.status = 400
    throw err
  }
  const next = [...items]
  next[index] = item
  persistAnnouncements(next)
  res.json({ ok: true, item })
}))

/** 删除公告（admin） */
app.delete('/api/announcements/:id', wrap(async (req, res) => {
  requireAnnouncementAdmin(req)
  const id = String(req.params.id || '').trim()
  const { items } = readAnnouncementItems()
  const next = items.filter(it => it.id !== id)
  if (next.length === items.length) {
    const err = new Error('公告不存在或已被删除')
    err.status = 404
    throw err
  }
  persistAnnouncements(next)
  res.json({ ok: true, deleted: id, count: next.length })
}))

// ── 扫码登录 ──
// qr/key → qr/check 之间的设备标识映射（内存暂存，重启即失效；容量上限防泄漏增长）
const pendingQrDevices = new Map()
const PENDING_QR_DEVICES_MAX = 100
function rememberQrDevices(items, deviceCookies) {
  if (pendingQrDevices.size > PENDING_QR_DEVICES_MAX) pendingQrDevices.clear()
  for (let i = 0; i < items.length; i++) {
    pendingQrDevices.set(items[i].key, { cookie: deviceCookies[i].cookie, device: deviceCookies[i].device })
  }
}
function takeQrDevice(key) {
  return pendingQrDevices.get(key) || null
}

// phone/send → phone/login 之间的设备标识映射（同一手机号在 10 分钟内复用同一套；
// 超出保留期或换号重新发送时，发送步骤会覆盖为新的一套）
const pendingPhoneDevices = new Map()
const PENDING_PHONE_DEVICES_MAX = 100
const PENDING_PHONE_DEVICES_TTL = 10 * 60 * 1000
function rememberPhoneDevice(phone, device) {
  if (pendingPhoneDevices.size > PENDING_PHONE_DEVICES_MAX) pendingPhoneDevices.clear()
  pendingPhoneDevices.set(phone, { device, at: Date.now() })
}
function takePhoneDevice(phone) {
  const hit = pendingPhoneDevices.get(phone)
  if (!hit) return null
  if (Date.now() - hit.at > PENDING_PHONE_DEVICES_TTL) {
    pendingPhoneDevices.delete(phone)
    return null
  }
  return hit.device
}

app.post('/api/qr/gen', wrap(async (req, res) => {
  // 每次生成都会向酷狗申请新的登录 key，按 IP 限流（内网/本机豁免）
  const qrIp = normalizeIp(clientIp(req))
  if (!isPrivateIp(qrIp)) enforceRateLimit(`qr:${qrIp}`, QR_GEN_IP_LIMIT, '二维码生成')

  const number = Math.min(5, Math.max(1, parseInt(req.body?.number, 10) || 1))
  const items = []
  // 每个二维码预生成一套设备标识：登录流程全程用它（key/check），登录成功即归该账号。
  // 一个 key 一套，多账号同时扫码互不关联。
  const deviceCookies = []
  await withApi(async () => {
    for (let n = 0; n < number; n++) {
      const device = generateDevice()
      const cookie = buildDeviceCookie(device)
      deviceCookies.push({ device, cookie })
      const r = await send(`/login/qr/key?timestrap=${Date.now()}`, 'GET', { cookie })
      if (r?.status !== 1 || !r?.data?.qrcode) {
        // 只报 status 无法定位问题：酷狗业务失败会带 error_code（如 20006 表示
        // appid/clientver/mid/dfid 不对），本地出网/代理异常则只有 msg。
        const detail = formatApiFailure(r)
        const err = new Error(`获取二维码密钥失败（${detail}）`)
        err.status = 502
        throw err
      }
      const key = r.data.qrcode
      const url = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`
      const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 })
      items.push({ key, url, dataUrl, device: deviceCookies[n].device })
      if (number > 1 && n < number - 1) await delay(500)
    }
  })
  printMagenta(`[webui] 已生成 ${items.length} 个登录二维码，等待扫码...`)
  // device 内含设备指纹（GUID/MID/DEV），不发给前端，仅服务端暂存到内存会话
  rememberQrDevices(items, deviceCookies)
  res.json({ items: items.map(({ key, url, dataUrl }) => ({ key, url, dataUrl })) })
}))

app.get('/api/qr/status', wrap(async (req, res) => {
  // 参数名用 qrcode，避免与全局访问密码的 ?key= 语义冲突（旧名兼容一个版本）
  const key = String(req.query.qrcode || req.query.key || '').trim()
  if (!key) {
    const err = new Error('缺少 qrcode key')
    err.status = 400
    throw err
  }
  const result = await withApi(async () => {
    // 用生成二维码时预生成的设备标识发 check，保证登录会话与扫码会话设备一致
    const qrDevice = takeQrDevice(key)
    const headers = qrDevice ? { cookie: qrDevice.cookie } : {}
    const r = await send(`/login/qr/check?key=${encodeURIComponent(key)}&timestrap=${Date.now()}`, 'GET', headers)
    const s = r?.data?.status
    if (s === 4 && r?.data?.userid && r?.data?.token) {
      // 登录成功：凭据写入挂载卷（追加/更新，不动已有账号）；设备标识用扫码会话那套
      const arr = readUserinfo()
      const loggedUserid = String(r.data.userid)
      upsertUser(arr, { userid: loggedUserid, token: String(r.data.token), device: qrDevice?.device }, true)
      const saved = saveUserinfo(arr)
      if (saved) clearInvalidCredentialMark(loggedUserid)
      pendingQrDevices.delete(key)
      // 票根：前端拿到它就能立刻为该账号绑定通知邮箱，不必再输一次账号密码
      return { status: 4, userid: maskIdentifier(loggedUserid), saved, bindTicket: issueBindTicket(loggedUserid) }
    }
    return { status: s ?? -1 }
  })
  if (result.status === 4) {
    printGreen(`[webui] 扫码登录成功，账号 ${result.userid} 已${result.saved ? '保存到凭据文件' : '获取（写文件失败）'}`)
  }
  res.json(result)
}))

// ── 手机号登录 ──

/** 把酷狗上游响应转成可读的错误描述（区分业务错误 / 风控 / 网络层异常） */
function describeUpstreamError(r) {
  if (r?.ssaCode) return '触发酷狗安全验证（风控），请稍后再试或改用扫码登录'
  if (r?.error_code != null) {
    return `${r.data || r.msg || '发送被拒绝'}（error_code ${r.error_code}）`
  }
  if (r?.msg && typeof r.msg === 'object') {
    // request.js 网络层异常时 msg 是 axios 错误对象
    return `请求酷狗服务失败：${r.msg.message || r.msg.code || '网络异常'}`
  }
  return r?.msg || r?.message || `status=${r?.status ?? 'unknown'}`
}

app.post('/api/phone/send', wrap(async (req, res) => {
  const phone = String(req.body?.phone || '').trim()
  assertPhone(phone)
  // 双重限流，均不依赖来源 IP：
  //   ① 全局总量——防「换号刷量」，本服务不被当作短信网关的唯一保证；
  //   ② 手机号——防「针对某一号码轰炸」。
  // 顺序先全局后号码：号码桶每号每天只有 2 次，若先判号码，被全局拒绝的请求会
  // 白白吃掉用户当天的额度；全局桶留有 10 倍余量，被号码桶拒绝的重复点击多花
  // 几个额度无碍。
  enforceRateLimit('sms:global', PHONE_SEND_GLOBAL_LIMIT, '验证码发送')
  enforceRateLimit(`sms:phone:${phone}`, PHONE_SEND_PHONE_LIMIT, '该手机号的验证码发送')
  // 手机号登录流程整段用同一套预生成设备标识（发送验证码 + 登录），成功后归该账号。
  // 注意：同一手机号若中途刷新页面重新发送验证码，会换一套新设备——酷狗侧表现为
  // 设备切换，属可接受行为（同一手机号本来就可能多设备）。
  const phoneDevice = generateDevice()
  rememberPhoneDevice(phone, phoneDevice)
  const r0 = await withApi(() => send(`/captcha/sent?mobile=${phone}`, 'GET', { cookie: buildDeviceCookie(phoneDevice) }))
  if (r0?.status !== 1) {
    const err = new Error(`验证码发送失败：${describeUpstreamError(r0)}`)
    err.status = 502
    throw err
  }
  printGreen(`[webui] 验证码已发送至 ${phone.slice(0, 2)}*******${phone.slice(-2)}`)
  // 成功响应体也记录（脱敏后），便于短信未送达时诊断上游行为
  printYellow(`[webui] 发送响应: ${JSON.stringify(summarizeResponse(r0))}`)
  res.json({ ok: true })
}))

app.post('/api/phone/login', wrap(async (req, res) => {
  const phone = String(req.body?.phone || '').trim()
  const code = String(req.body?.code || '').trim()
  assertPhone(phone)
  if (!/^\d{4,6}$/.test(code)) {
    const err = new Error('验证码格式不正确')
    err.status = 400
    throw err
  }
  // 复用发送验证码时的设备标识；若已过期/未发送过（如直接调用），退化为本请求新生成的一套
  const phoneDevice = takePhoneDevice(phone) || generateDevice()
  const r = await withApi(() => send(`/login/cellphone?mobile=${phone}&code=${code}`, 'GET', { cookie: buildDeviceCookie(phoneDevice) }))
  if (r?.status === 1 && r?.data?.userid && r?.data?.token) {
    const arr = readUserinfo()
    const loggedUserid = String(r.data.userid)
    upsertUser(arr, { userid: loggedUserid, token: String(r.data.token), device: phoneDevice }, true)
    const saved = saveUserinfo(arr)
    if (saved) clearInvalidCredentialMark(loggedUserid)
    pendingPhoneDevices.delete(phone)
    const userid = maskIdentifier(loggedUserid)
    printGreen(`[webui] 手机号登录成功，账号 ${userid} ${saved ? '已保存到凭据文件' : '获取成功（写文件失败，凭据未持久化）'}`)
    // 票根：前端拿到它就能立刻为该账号绑定通知邮箱
    return res.json({ ok: true, userid, saved, bindTicket: issueBindTicket(loggedUserid) })
  }
  if (r?.error_code === 34175) {
    const err = new Error('该手机号绑定了多个酷狗账号，暂不支持手机号登录，请使用扫码登录')
    err.status = 400
    throw err
  }
  const err = new Error(`登录失败：${describeUpstreamError(r)}`)
  err.status = 401
  throw err
}))

// ── 一键签到 ──
// 两种模式：
//   1) 单账号：请求体传 userid → 只签该账号，每个 userid 每天最多 N 次（默认 2）
//   2) 全量：请求头带 admin 凭据（X-Accounts-Id / X-Accounts-Key）→ 签所有账号，
//      不占单账号配额，仍沿用「今日已签到则跳过」机制
app.post('/api/checkin/run', wrap(async (req, res) => {
  if (checkinState.running) {
    const err = new Error('签到任务正在进行中，请稍候')
    err.status = 409
    throw err
  }
  const accounts = readUserinfo()
  if (!accounts.length && !process.env.USERINFO) {
    const err = new Error('尚未配置任何账号凭据，请先登录')
    err.status = 400
    throw err
  }

  const rawUserid = req.body?.userid != null ? String(req.body.userid).trim() : ''

  // ── 模式一：指定 userid，只签该账号 ──
  if (rawUserid) {
    const target = accounts.find(u => String(u.userid) === rawUserid)
    if (!target) {
      const err = new Error('该 userid 不在已配置的账号中，请先在「扫码登录」或「手机号登录」中添加')
      err.status = 404
      throw err
    }

    // 每 userid 每天 N 次（不分 IP，全局计数）。这是本接口唯一的限流维度：
    // 按来源 IP 计数在端口映射与反向代理两种部署下都不可靠，已移除。
    if (CHECKIN_PER_USERID_DAILY > 0) {
      const q = perUseridQuota(rawUserid)
      if (q.remaining <= 0) {
        const err = new Error(
          `账号 ${maskIdentifier(rawUserid)} 今日已手动签到 ${q.used} 次，达到上限（${q.limit} 次/天），请明日再试`
        )
        err.status = 429
        err.code = 'per-userid-quota-exceeded'
        throw err
      }
    }

    startCheckin('manual', { onlyUserid: rawUserid })
    if (CHECKIN_PER_USERID_DAILY > 0) markPerUseridUsed(rawUserid)
    const q = perUseridQuota(rawUserid)
    return res.status(202).json({ ok: true, mode: 'single', userid: maskIdentifier(rawUserid), remaining: q.remaining })
  }

  // ── 模式二：全部账号，必须通过 admin 验证（失败计入防爆破，与 /api/accounts 共用桶） ──
  const admin = verifyAdminGuarded(req)
  if (!admin.scope) {
    const err = new Error(admin.message)
    err.status = admin.locked ? 423 : 401
    err.code = admin.locked ? 'accounts-auth' : 'admin-required'
    if (admin.retryAfter > 0) err.retryAfterMs = admin.retryAfter * 1000
    throw err
  }

  // admin 全量签到不占单账号配额；认证本身即门槛——失败计入 failsByIp 防爆破，
  // 不再叠加按 IP 的冷却（同上，IP 维度在两种部署下都不可靠）。
  startCheckin('manual')
  res.status(202).json({ ok: true, mode: 'all' })
}))

/** 单账号签到的今日配额查询（前端展示"今日剩余次数"用） */
app.get('/api/checkin/quota', wrap(async (req, res) => {
  const userid = req.query.userid != null ? String(req.query.userid).trim() : ''
  if (!userid) return res.json({ limit: CHECKIN_PER_USERID_DAILY, perUserid: true })
  const q = perUseridQuota(userid)
  res.json({ userid: maskIdentifier(userid), limit: q.limit, used: q.used, remaining: q.remaining })
}))

app.get('/api/checkin/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(`event: hello\ndata: ${JSON.stringify({
    running: checkinState.running,
    lastRun: checkinState.lastRun,
    replayed: checkinState.logs.length,
  })}\n\n`)
  for (const entry of checkinState.logs) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`)
  }
  checkinState.sseClients.add(res)
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n') } catch { /* ignore */ }
  }, 15000)
  req.on('close', () => {
    clearInterval(heartbeat)
    checkinState.sseClients.delete(res)
  })
})

// ── 账号管理（受 accountsGuard 保护：每账号独立密码，admin 可管理全部）──

/** 签到状态文件路径：由 main.js 写入各账号的 VIP 到期时间，账号管理面板读取展示。 */
function checkinStatusFile() {
  const base = process.env.USERINFO_FILE
    ? path.dirname(process.env.USERINFO_FILE)
    : path.join(ROOT, 'data')
  return path.join(base, 'checkin_status.json')
}

/** 读取签到状态文件（VIP 到期时间 + 凭据失效标记）。失败返回空结构。
 *  解析逻辑与 main.js 写盘共用 utils/checkinStatus.js，避免两边格式不一致。 */
function readCheckinStatusFile() {
  return readCheckinStatus(checkinStatusFile())
}

/** 账号重新登录成功后清除「凭据失效」标记，避免面板一直挂着「需重新登录」的过期提示 */
function clearInvalidCredentialMark(userid) {
  try {
    clearInvalidCredential(checkinStatusFile(), userid)
  } catch { /* 清理失败不影响登录结果，下次签到成功时也会自动清除 */ }
}

/** 验证身份凭据（解锁面板用）；失败计数与锁定由 accountsGuard 统一处理 */
app.post('/api/accounts/unlock', wrap(async (req, res) => {
  res.json({ ok: true, admin: req.accountsScope.admin })
}))

/** 账号管理面板展示用：解析账号昵称（完整、不脱敏；面板本身受独立密码保护）。
 *  凭据文件已存昵称时直接返回；缺失时经 /user/detail 懒加载并回写文件。
 *  单个账号失败（token 过期/网络异常等）不影响其余账号，也不阻断列表接口。
 *  注意：不得在日志中输出完整昵称。 */
async function resolveAccountNicknames(accounts) {
  const missing = accounts.filter(u => !u.nickname)
  if (missing.length) {
    try {
      await withApi(async () => {
        for (const u of missing) {
          try {
            const headers = { cookie: buildDeviceCookie(u, `token=${u.token}; userid=${u.userid}`) }
            const detail = await send(`/user/detail?timestrap=${Date.now()}`, 'GET', headers)
            if (detail?.data?.nickname != null) u.nickname = String(detail.data.nickname)
          } catch { /* 单账号失败跳过，保持无昵称 */ }
        }
      })
    } catch { /* API 服务不可用：本次仅返回已存昵称 */ }
    if (missing.some(u => u.nickname)) {
      // 回写昵称（含完整 token，仅写本地凭据文件；失败不致命，下次加载会重新懒加载）
      saveUserinfo(readUserinfo().map(u => {
        const found = accounts.find(a => String(a.userid) === String(u.userid))
        return found && found.nickname ? { ...u, nickname: found.nickname } : u
      }))
    }
  }
  return accounts.map(u => (u.nickname ? String(u.nickname) : null))
}

/** 按身份作用域过滤账号：admin 见全部；普通用户仅见自己 */
function scopeFilter(accounts, scope) {
  if (scope.admin) return accounts.map((u, i) => ({ u, i }))
  return accounts.map((u, i) => ({ u, i })).filter(({ u }) => String(u.userid) === scope.userid)
}

app.get('/api/accounts', wrap(async (req, res) => {
  const scope = req.accountsScope
  const all = readUserinfo()
  const visible = scopeFilter(all, scope)
  const nicknames = await resolveAccountNicknames(visible.map(v => v.u))
  const auth = readAccountsAuth()
  const status = readCheckinStatusFile()
  const vipExpiry = status.vipExpiry
  const invalidCreds = status.invalidCreds
  res.json({
    accounts: visible.map(({ u, i }, vi) => ({
      index: i,
      // userid 完整返回：面板整体受独立密码保护，脱敏会妨碍用户核对与搜索自己的账号
      userid: String(u.userid),
      // 脱敏 userid：给「账号过期」这类对外展示用的小窗口，避免把完整 ID 摆在大字号列表里
      useridMasked: maskIdentifier(u.userid),
      // 兼容字段：前端删除等操作按完整 id 进行
      rawUserid: String(u.userid),
      nickname: nicknames[vi],
      tokenLength: String(u.token || '').length,
      // 是否已自行设置过密码：false 表示当前仍在使用「酷狗ID」作为默认密码
      hasPassword: Boolean(auth[String(u.userid)]),
      // VIP 到期时间：来自最近一次签到写的状态文件；尚未签到时为 null
      vipExpiry: vipExpiry[String(u.userid)] || null,
      // 登录凭据是否已失效（酷狗返回 20018）：true 时面板提示「需重新登录」，重新登录成功后自动清除
      credentialInvalid: Boolean(invalidCreds[String(u.userid)]),
      credentialInvalidAt: invalidCreds[String(u.userid)] || null,
      // 通知邮箱：面板整体受独立密码保护（与完整 userid 同理），故返回完整地址供用户核对；
      // 日志与对外接口（/api/expired）一律使用 maskEmail 脱敏，不得输出完整邮箱。
      email: u.email ? String(u.email) : null,
      emailVerified: u.emailVerified === true,
      emailVerifiedAt: u.emailVerifiedAt ? String(u.emailVerifiedAt) : null,
    })),
    admin: scope.admin,
    lockEnabled: true,
    // 以默认密码（酷狗ID）登录时为 true，前端据此提示尽快改密
    mustChangePassword: Boolean(scope.mustChangePassword),
    // SMTP 是否可用：未配置时前端隐藏「绑定邮箱」入口并提示先配置 MAIL_*，避免用户白填
    mailConfigured: mailConfigReady(),
  })
}))

/** 按 userid 删除账号（推荐）：避免前端缓存下标与列表不一致时删错账号 */
app.delete('/api/accounts/by-id/:userid', wrap(async (req, res) => {
  const scope = req.accountsScope
  const targetId = String(req.params.userid || '').trim()
  const arr = readUserinfo()
  const index = arr.findIndex(u => String(u.userid) === targetId)
  if (index === -1) {
    const err = new Error('账号不存在')
    err.status = 404
    throw err
  }
  if (!scope.admin && targetId !== scope.userid) {
    const err = new Error('只能删除自己的账号')
    err.status = 403
    throw err
  }
  arr.splice(index, 1)
  saveUserinfo(arr)
  const auth = readAccountsAuth()
  if (targetId in auth) {
    delete auth[targetId]
    saveAccountsAuth(auth)
  }
  printYellow(`[webui] 已删除账号 ${maskIdentifier(targetId)}，剩余 ${arr.length} 个账号`)
  res.json({ ok: true, remaining: arr.length })
}))

app.delete('/api/accounts/:index', wrap(async (req, res) => {
  const scope = req.accountsScope
  const index = parseInt(req.params.index, 10)
  const arr = readUserinfo()
  if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
    const err = new Error('账号序号不存在')
    err.status = 404
    throw err
  }
  // TOCTOU 防护：调用方传入的 expectUserid 必须与当前下标对应的账号一致，
  // 否则说明列表在用户操作期间已变化，拒绝删除以免误删他人账号。
  const expectUserid = req.query.expectUserid != null ? String(req.query.expectUserid).trim() : ''
  if (expectUserid && String(arr[index].userid) !== expectUserid) {
    const err = new Error('账号列表已变化，请刷新后重试')
    err.status = 409
    throw err
  }
  // 非 admin 只能删除自己的账号
  if (!scope.admin && String(arr[index].userid) !== scope.userid) {
    const err = new Error('只能删除自己的账号')
    err.status = 403
    throw err
  }
  const removedUserid = String(arr[index].userid)
  const removed = maskIdentifier(removedUserid)
  arr.splice(index, 1)
  saveUserinfo(arr)
  // 清理该账号的自定义密码（若存在）
  const auth = readAccountsAuth()
  if (removedUserid in auth) {
    delete auth[removedUserid]
    saveAccountsAuth(auth)
  }
  printYellow(`[webui] 已删除账号 ${removed}，剩余 ${arr.length} 个账号`)
  res.json({ ok: true, remaining: arr.length })
}))

/** 修改账号密码：普通用户只能改自己；admin 可改任意账号（body.targetUserid 指定目标）。
 *  admin 自身的密码可由此处修改（写入 accounts_auth.json），环境变量 ACCOUNTS_PASSWORD 仍优先生效。 */
app.post('/api/accounts/password', wrap(async (req, res) => {
  const scope = req.accountsScope
  const newPwd = String(req.body?.newPassword || '')
  if (!newPwd || newPwd.length < 4 || newPwd.length > 64) {
    const err = new Error('新密码长度需为 4-64 位')
    err.status = 400
    throw err
  }
  // 目标账号：admin 显式指定 targetUserid（缺省即 admin 自身）；普通用户固定为自己
  const targetUserid = scope.admin
    ? (req.body?.targetUserid ? String(req.body.targetUserid) : 'admin')
    : scope.userid

  if (targetUserid !== 'admin' && !readUserinfo().some(u => String(u.userid) === targetUserid)) {
    const err = new Error('目标账号不存在')
    err.status = 404
    throw err
  }

  const auth = readAccountsAuth()
  auth[targetUserid] = makePasswordRecord(newPwd)
  if (!saveAccountsAuth(auth)) {
    const err = new Error('密码写入失败，请检查凭据目录权限')
    err.status = 500
    throw err
  }
  printYellow(`[webui] 账号 ${targetUserid === 'admin' ? 'admin' : maskIdentifier(targetUserid)} 的密码已更新`)
  res.json({ ok: true })
}))

// ── 通知邮箱绑定（每个账号绑定自己的邮箱，凭据失效时按账号发信）──
//
// 设计要点：
//   1. 必须验证：验证码发到所填邮箱，填回来才落库。否则任何能调用接口的人都能
//      把别人的邮箱绑到自己的账号上，变成对第三方的骚扰通道。
//   2. 只绑定「自己」：admin 可以代任意账号操作（便于批量维护），普通用户与票根
//      只能操作自己那个 userid。
//   3. 验证码只存 sha256 哈希，10 分钟过期，最多尝试 5 次；不落盘（进程重启即作废，
//      用户重新获取即可）。

const EMAIL_CODE_TTL_MS = 10 * 60 * 1000
const EMAIL_CODE_MAX_ATTEMPTS = 5
const EMAIL_CODES_MAX = 2000

/** userid -> { email, codeHash, expiresAt, attempts } */
const emailCodes = new Map()

/** 哈希验证码（避免把明文码留在内存/可能的转储里） */
function hashEmailCode(code) {
  return crypto.createHash('sha256').update(`kgcheckin-mail:${code}`).digest('hex')
}

/**
 * 解析本次邮箱操作的目标账号。
 *
 * 路由挂在 /api/accounts/email/* 下，accountsGuard 已经先跑过：
 *   - 密码路径：req.accountsScope = { admin, userid }
 *   - 票根路径：req.accountsScope = { admin:false, userid, viaTicket:true }
 * 所以这里只需要处理「admin 代他人操作」与「缺少目标」两种情况。
 * @returns {string} 目标 userid
 */
function resolveEmailTarget(req) {
  const scope = req.accountsScope
  if (!scope) {
    const err = new Error('需要先登录账号或解锁账号管理')
    err.status = 401
    err.code = 'accounts-auth'
    throw err
  }
  const target = req.body?.targetUserid != null ? String(req.body.targetUserid).trim() : ''
  if (scope.admin && target) {
    if (!readUserinfo().some(u => String(u.userid) === target)) {
      const err = new Error('目标账号不存在')
      err.status = 404
      throw err
    }
    return target
  }
  if (scope.userid) return String(scope.userid)
  const err = new Error('缺少目标账号（admin 需指定 targetUserid）')
  err.status = 400
  throw err
}

/** 发送验证码 */
app.post('/api/accounts/email/code', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim()
  if (!isValidEmail(email)) {
    const err = new Error('邮箱格式不正确')
    err.status = 400
    throw err
  }
  if (!mailConfigReady()) {
    const err = new Error('服务端尚未配置 SMTP（MAIL_HOST / MAIL_USER / MAIL_PASS），暂时无法发送验证码')
    err.status = 503
    err.code = 'mail-not-configured'
    throw err
  }

  const targetUserid = resolveEmailTarget(req)

  // 限流只按目标账号：targetUserid 已由 accountsGuard 认证为本人（或 admin 指定），
  // 调用方身份明确，用于防「针对某人反复发信」的正是账号维度；IP 维度在端口映射
  // 与反向代理部署下不可靠，已移除。
  enforceRateLimit(`mail:user:${targetUserid}`, EMAIL_SEND_USER_LIMIT, '该账号的邮箱验证码发送')

  const code = genEmailCode()
  const account = readUserinfo().find(u => String(u.userid) === targetUserid)
  const accountLabel = account?.nickname
    ? `${account.nickname}（${maskIdentifier(targetUserid)}）`
    : maskIdentifier(targetUserid)
  const mail = buildEmailCodeMail({ code, expireMinutes: EMAIL_CODE_TTL_MS / 60000, accountLabel })

  const ok = await sendAccountMail({ to: email, ...mail })
  if (!ok) {
    const err = new Error('验证码邮件发送失败，请检查邮箱地址或稍后重试')
    err.status = 502
    err.code = 'mail-send-failed'
    throw err
  }

  // 同一账号只保留最新一次验证码：旧码立即作废，避免多封邮件里的码都能用
  if (emailCodes.size > EMAIL_CODES_MAX) {
    const now = Date.now()
    for (const [k, v] of emailCodes) if (v.expiresAt <= now) emailCodes.delete(k)
    if (emailCodes.size > EMAIL_CODES_MAX) emailCodes.clear()
  }
  emailCodes.set(targetUserid, {
    email,
    codeHash: hashEmailCode(code),
    expiresAt: Date.now() + EMAIL_CODE_TTL_MS,
    attempts: 0,
  })

  printGreen(`[webui] 邮箱验证码已发送至 ${maskEmail(email)}（账号 ${maskIdentifier(targetUserid)}）`)
  res.json({
    ok: true,
    email: maskEmail(email),
    expireMinutes: EMAIL_CODE_TTL_MS / 60000,
  })
}))

/** 校验验证码并落库 */
app.post('/api/accounts/email/verify', wrap(async (req, res) => {
  const code = String(req.body?.code || '').trim()
  if (!/^\d{6}$/.test(code)) {
    const err = new Error('验证码格式不正确（6 位数字）')
    err.status = 400
    throw err
  }
  const targetUserid = resolveEmailTarget(req)
  const pending = emailCodes.get(targetUserid)
  if (!pending) {
    const err = new Error('请先获取邮箱验证码')
    err.status = 400
    err.code = 'email-code-missing'
    throw err
  }
  if (Date.now() > pending.expiresAt) {
    emailCodes.delete(targetUserid)
    const err = new Error('验证码已过期，请重新获取')
    err.status = 400
    err.code = 'email-code-expired'
    throw err
  }
  if (pending.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    emailCodes.delete(targetUserid)
    const err = new Error('验证码错误次数过多，请重新获取')
    err.status = 429
    err.code = 'email-code-too-many-attempts'
    throw err
  }
  // 计时安全比较（先各自 sha256，等长后再比）
  if (!safeEqual(hashEmailCode(code), pending.codeHash)) {
    pending.attempts++
    const left = EMAIL_CODE_MAX_ATTEMPTS - pending.attempts
    const err = new Error(left > 0 ? `验证码不正确，剩余尝试次数 ${left}` : '验证码错误次数过多，请重新获取')
    err.status = left > 0 ? 400 : 429
    throw err
  }

  // 验证通过：写入凭据文件的账号条目（其它字段原样保留）
  const arr = readUserinfo()
  const account = arr.find(u => String(u.userid) === targetUserid)
  if (!account) {
    const err = new Error('账号不存在')
    err.status = 404
    throw err
  }
  const prevEmail = String(account.email || '').trim().toLowerCase()
  account.email = pending.email
  account.emailVerified = true
  account.emailVerifiedAt = new Date().toISOString()
  if (!saveUserinfo(arr)) {
    const err = new Error('邮箱写入失败，请检查凭据目录权限')
    err.status = 500
    throw err
  }
  emailCodes.delete(targetUserid)
  // 换了新邮箱才重置提醒冷却：旧地址可能已经收不到了，新地址应当能立刻收到下一封。
  // 重复验证同一个地址不能清冷却，否则用户只要重填一次就能绕过「7 天最多一封」。
  if (prevEmail !== pending.email.toLowerCase()) clearMailNotice(targetUserid)

  printGreen(`[webui] 账号 ${maskIdentifier(targetUserid)} 已绑定并验证邮箱 ${maskEmail(pending.email)}`)
  res.json({ ok: true, email: pending.email, emailVerified: true })
}))

/** 解绑邮箱（用户主动取消通知，或邮箱填错需要重来） */
app.post('/api/accounts/email/unbind', wrap(async (req, res) => {
  const targetUserid = resolveEmailTarget(req)
  const arr = readUserinfo()
  const account = arr.find(u => String(u.userid) === targetUserid)
  if (!account) {
    const err = new Error('账号不存在')
    err.status = 404
    throw err
  }
  delete account.email
  delete account.emailVerified
  delete account.emailVerifiedAt
  if (!saveUserinfo(arr)) {
    const err = new Error('邮箱解绑失败，请检查凭据目录权限')
    err.status = 500
    throw err
  }
  emailCodes.delete(targetUserid)
  clearMailNotice(targetUserid)
  printYellow(`[webui] 账号 ${maskIdentifier(targetUserid)} 已解绑通知邮箱`)
  res.json({ ok: true })
}))

// ── 兜底 ──
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }))
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500
  if (status >= 500) printRed(`[webui] ${req.method} ${req.path} 失败：${err.message}`)
  // 限流类错误附带标准 Retry-After（秒），便于客户端/脚本自动等待
  if (err.retryAfterMs > 0) {
    res.set('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)))
  }
  // 限流错误在响应体里也带上 retryAfter（秒），前端据此禁用按钮并倒计时
  res.status(status).json({
    error: err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.retryAfterMs > 0 ? { retryAfter: Math.ceil(err.retryAfterMs / 1000) } : {}),
  })
})

// ────────────────────────── 启动 ──────────────────────────

const BANNER = `
  ┌─────────────────────────────────────┐
  │   kgcheckin webui  ·  酷狗概念签到   │
  └─────────────────────────────────────┘`

// 首次启动：若配置了 ACCOUNTS_BOOTSTRAP_PASSWORD 且尚无密码文件，则初始化 admin
bootstrapAccountsAuth()
// 存量账号设备标识迁移（幂等）
migrateDevicesOnBoot()

app.listen(WEBUI_PORT, () => {
  console.log(BANNER)
  printGreen(`[webui] 控制台已启动: http://127.0.0.1:${WEBUI_PORT}`)
  printYellow(`  计划任务: ${cron.validate(SCHEDULE) ? SCHEDULE : `${SCHEDULE} (无效！定时签到未启用)`}（${TIMEZONE}）`)
  printYellow(`  下次执行: ${nextRuns(1)[0] || '-'}`)
  printYellow(`  凭据文件: ${USERINFO_FILE}（${readUserinfo().length} 个账号）`)
  if (dataWritable.writable) {
    printGreen(`  凭据目录: ${dataDir} 可写`)
  } else {
    // 沉默失败是这个问题最坑的地方：登录明明成功，凭据却没落盘，重启就丢。
    // 启动时就红字报出来，并直接给宿主机侧可执行的修复命令。
    const { uid, gid } = currentUidGid()
    printRed(`  ⚠ 凭据目录不可写: ${dataDir}（${dataWritable.reason || '未知原因'}）`)
    printRed('    扫码/手机号登录会成功，但凭据写不进 userinfo.json，重启即丢；')
    printRed('    手动签到也会读不到账号。请在宿主机执行下面这条命令后重启容器：')
    printRed(`      sudo chown -R ${uid}:${gid} ./data`)
    printRed(`    或在该项目的 .env 中设置 PUID=${uid} / PGID=${gid} 后重新 up（入口脚本会自动修正属主）。`)
    printRed('    不要用 chmod 777：data 目录里是完整登录 token。')
  }
  printYellow(`  访问密码: ${WEBUI_PASSWORD ? '已启用' : '未启用（仅建议在可信内网使用）'}`)
  printYellow(`  账号管理: 每账号独立密码（scrypt）· admin ${ACCOUNTS_PASSWORD || readAccountsAuth().admin ? '已启用' : '未启用'} · 账号 ${ACCOUNTS_MAX_ATTEMPTS} 次 / IP ${ACCOUNTS_IP_MAX_ATTEMPTS} 次错误锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`)
  if (ACCOUNTS_DISABLE_ID_DEFAULT) {
    printYellow('  账号默认密码: 已关闭（未设密码的账号需由 admin 设置密码后才能登录）')
  } else {
    printYellow('  ⚠ 账号默认密码 = 酷狗ID（便于用户首次登录后自行改密）')
    printYellow('    酷狗ID 在账号列表与用户之间可见，知道 ID 即可登录该账号并改密；')
    printYellow('    公网部署建议设置 WEBUI_PASSWORD，或设 ACCOUNTS_DISABLE_ID_DEFAULT=true 并分发密码。')
  }
  if (!readAccountsAuth().admin && !ACCOUNTS_PASSWORD) {
    printYellow('  提示：未配置 ACCOUNTS_PASSWORD，admin 不可用；可设 ACCOUNTS_BOOTSTRAP_PASSWORD 初始化 admin 密码')
  }
  if (WEBUI_TRUST_PROXY !== false) {
    printYellow(`  反向代理: 已信任 X-Forwarded-For（WEBUI_TRUST_PROXY=${WEBUI_TRUST_PROXY_RAW}）`)
  } else {
    // 未信任代理头时，req.ip 恒为代理/网桥地址：账号防爆破的 IP 桶会把所有外网用户
    // 挤进同一个桶（互相拖累），二维码限流则因来源是内网地址被整体豁免。
    const raw = String(WEBUI_TRUST_PROXY_RAW ?? '').trim()
    if (raw) {
      printYellow(`  反向代理: 已明确关闭（WEBUI_TRUST_PROXY=${raw}），不信任 X-Forwarded-For`)
    } else {
      printRed('  ⚠ 未设置 WEBUI_TRUST_PROXY：经反向代理的公网请求会被视为同一个内网来源，')
      printRed('    账号防爆破的 IP 桶会互相拖累、二维码限流会被豁免；公网部署请设为 1。')
    }
  }
  printYellow(`  验证码限流: 全局 ${describeRateLimit(PHONE_SEND_GLOBAL_LIMIT)} · 手机号 ${describeRateLimit(PHONE_SEND_PHONE_LIMIT)}（不依赖来源 IP）`)
  printYellow(`  二维码限流: IP ${describeRateLimit(QR_GEN_IP_LIMIT)}（内网/本机豁免）`)
  if (mailConfigReady()) {
    const bound = readUserinfo().filter(u => u && u.email && u.emailVerified === true).length
    printYellow(`  通知邮箱: 已配置 SMTP · ${bound} 个账号已验证邮箱 · 失效提醒 ${invalidNotifyEnabled() ? '开启' : '关闭'}（同一账号冷却 ${Math.round(noticeCooldownMs() / 86400000)} 天）`)
  } else {
    printYellow('  通知邮箱: 未配置 SMTP（MAIL_HOST / MAIL_USER / MAIL_PASS），无法绑定邮箱与发送失效提醒')
  }
  const deviceMid = describeDeviceMid()
  if (deviceMid.configured) {
    printYellow(`  设备 MID: ${deviceMid.text}`)
  } else {
    printRed('  ⚠ 设备 MID: 未配置（每次启动随机生成，酷狗可能返回 status=0 / error_code=20006，')
    printRed('    验证码短信也可能被风控静默丢弃）；请在 .env 中设置 KUGOU_API_GUID 或 KUGOU_API_MID。')
  }
  if (CHECKIN_PER_USERID_DAILY > 0) {
    printYellow(`  手动签到配额: 每账号每天 ${CHECKIN_PER_USERID_DAILY} 次（按北京时间跨天重置）`)
  } else {
    printYellow('  手动签到配额: 已关闭（CHECKIN_PER_USERID_DAILY=0）')
  }
  // 启动时读一次公告文件：文件缺失 / 损坏都会走空列表，所以这行永远打得出来，
  // 也能让管理员一眼确认「公告文件到底被读到了几条」，不用打开页面去数。
  {
    const ann = readAnnouncementItems().items
    const annVisible = visibleAnnouncements(ann).length
    printYellow(`  站点公告: 共 ${ann.length} 条（对外可见 ${annVisible} 条，草稿 ${ann.length - annVisible} 条）· 文件 ${announcementsFile()}`)
  }

  if (cron.validate(SCHEDULE)) {
    cron.schedule(SCHEDULE, () => {
      if (checkinState.running) {
        printYellow('[webui] 上一次签到任务尚未结束，跳过本次定时触发')
        return
      }
      startCheckin('cron')
    }, { timezone: TIMEZONE })
  }

  if (RUN_ON_STARTUP) {
    printYellow('[webui] RUN_ON_STARTUP=true，即将执行一次启动签到')
    setTimeout(() => startCheckin('startup'), 2000)
  }
})
