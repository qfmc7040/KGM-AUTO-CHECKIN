/**
 * 公告文件（data/announcements.json）读写。
 *
 * 用途：WebUI 控制台顶栏的站点公告——管理员（admin）发布通知，所有访客在页面上看到。
 * 由 webui/server.js 读写；本模块只负责「文件 ↔ 结构化数据」和字段校验，
 * 不参与鉴权（发布权限由 server.js 的 verifyAdminGuarded 把关）。
 *
 * 文件内容形如：
 *   { "updatedAt": "2026-11-01T00:00:00.000Z",
 *     "seq": 2,
 *     "items": [
 *       { "id": "a1b2c3", "title": "维护通知", "body": "今晚 23:00 维护", "level": "warn",
 *         "pinned": true, "draft": false, "createdAt": "2026-11-01T01:00:00.000Z",
 *         "updatedAt": "2026-11-01T01:00:00.000Z" }
 *     ] }
 *
 * 关键约束：
 *   1. 字段一律来自本模块的规范化（normalizeAnnouncement），server.js 不得把请求体原样写盘。
 *      这样即使发布的接口被改写，落盘结构也不会漂移。
 *   2. 本文件是**单份文档**（所有公告共用一个数组），读写必须整体进行；
 *      写盘沿用项目既有做法：先写 .tmp 再 rename，避免进程被杀时留下半截 JSON。
 *   3. 读取时对单条记录做容错：结构不符的条目直接跳过，不让一条脏数据拖垮整个公告列表。
 *   4. 写入的公告正文长度上限见 MAX_BODY_LENGTH：公告会被前端整段渲染，
 *      没有上限时一个超长正文就能把所有人的页面拖慢。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 标题 / 正文长度上限（字符数，按 UTF-16 计） */
export const MAX_TITLE_LENGTH = 100
export const MAX_BODY_LENGTH = 2000
/** 单次可保存的公告条数上限：防止文件无限膨胀 */
export const MAX_ITEMS = 200
/** 公告级别：info 普通 / warn 提醒 / err 重要（前端据此着色，err 会弹窗提示） */
export const LEVELS = ['info', 'warn', 'err']

/** 是否为可用的普通对象（排除 null / 数组） */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 生成公告 id：时间戳 + 随机后缀。
 * 不用自增序号，避免与文件里已有的 id 冲突（文件可能被手工编辑过）。
 * @returns {string}
 */
export function newAnnouncementId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 把任意输入规范成一条合法公告。
 * 非法字段一律回落到安全默认值（而非抛错）：公告是「尽力展示」的内容，
 * 一条字段写错不应导致整次保存失败。
 * @param {object} raw 原始输入（可能来自请求体或已经损坏的文件）
 * @param {{id?: string, createdAt?: string}} [fallback] id / createdAt 缺失时的兜底值
 * @returns {{id: string, title: string, body: string, level: string, pinned: boolean, draft: boolean, createdAt: string, updatedAt: string}}
 */
export function normalizeAnnouncement(raw, fallback = {}) {
  const src = isPlainObject(raw) ? raw : {}
  const now = new Date().toISOString()
  const id = String(src.id || fallback.id || '').trim() || newAnnouncementId()
  const createdAt = toIsoString(src.createdAt) || toIsoString(fallback.createdAt) || now
  return {
    id,
    title: String(src.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    body: String(src.body ?? '').trim().slice(0, MAX_BODY_LENGTH),
    level: LEVELS.includes(src.level) ? src.level : 'info',
    pinned: src.pinned === true,
    draft: src.draft === true,
    createdAt,
    updatedAt: toIsoString(src.updatedAt) || now,
  }
}

/**
 * 把任意值转成 ISO 时间字符串；无法解析时返回空串（由调用方决定兜底）。
 * @param {unknown} value
 * @returns {string}
 */
function toIsoString(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : ''
}

/**
 * 校验一条公告是否可用于发布。
 * 与 normalizeAnnouncement 的分工：normalize 只管「字段合法化」，
 * 本函数回答「这条公告能不能发布」——由 server.js 在保存前调用，失败即 400。
 * @param {{title: string, body: string}} item 已规范化的公告
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateAnnouncement(item) {
  // 这里再 trim 一次而不是信任调用方已经规范化过：只差这一点，「标题全是空格」的公告
  // 就会被发布出去，然后在前端显示成一条点不开也删不掉的空白公告。
  const title = String(item?.title ?? '').trim()
  const body = String(item?.body ?? '').trim()
  if (!title && !body) return { ok: false, error: '标题与正文不能同时为空' }
  return { ok: true }
}

/**
 * 读取公告文件。
 * 文件缺失 / JSON 损坏 / 结构不符时返回空列表（不抛异常，调用方无需 try）。
 * 单条记录结构不符（非对象、id 重复）时跳过该条，保留其余公告。
 * @param {string} file 公告文件路径
 * @returns {{items: Array<object>, updatedAt: string}}
 */
export function readAnnouncements(file) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return { items: [], updatedAt: '' }
  }
  const rawItems = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : [])
  const seen = new Set()
  const items = []
  for (const raw of rawItems) {
    if (!isPlainObject(raw)) continue
    const item = normalizeAnnouncement(raw)
    // 重复 id 会让前端的已读记录互相覆盖（读了 A 却被当成读了 B），这里直接丢弃后来的
    if (seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
    if (items.length >= MAX_ITEMS) break
  }
  return {
    items,
    updatedAt: isPlainObject(parsed) ? toIsoString(parsed.updatedAt) : '',
  }
}

/**
 * 原子写入公告列表（tmp + rename）。
 * @param {string} file 公告文件路径
 * @param {Array<object>} items 公告列表（会先规范化；超出 MAX_ITEMS 的部分丢弃）
 * @returns {{ok: true} | {ok: false, error: string}} 写入结果；失败不抛异常，由调用方决定如何提示
 */
export function writeAnnouncements(file, items) {
  const list = (Array.isArray(items) ? items : [])
    .filter(isPlainObject)
    .slice(0, MAX_ITEMS)
    .map(raw => normalizeAnnouncement(raw))
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = { updatedAt: new Date().toISOString(), seq: list.length, items: list }
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略清理失败 */ }
    return { ok: false, error: error?.message || String(error) }
  }
}

/**
 * 公告排序：置顶的在前，其次按创建时间倒序（新的在前）。
 * 采用副本排序，不修改传入数组。
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function sortAnnouncements(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const ta = Date.parse(a.createdAt) || 0
    const tb = Date.parse(b.createdAt) || 0
    return tb - ta
  })
}

/**
 * 过滤出访客可见的公告：草稿不下发，并按 sortAnnouncements 排序。
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function visibleAnnouncements(items) {
  return sortAnnouncements((Array.isArray(items) ? items : []).filter(it => it && it.draft !== true))
}

/**
 * 计算「未读」公告：可见且未被客户端标记已读的公告。
 * 已读状态存在浏览器本地（localStorage），服务端只负责把当前列表和 id 给出去，
 * 因此这里只做集合差集，不涉及任何账号身份。
 * @param {Array<object>} items 公告列表（通常是 visibleAnnouncements 的结果）
 * @param {string[]|Set<string>} readIds 客户端已读的公告 id
 * @returns {Array<object>} 未读公告（保持传入顺序）
 */
export function unreadAnnouncements(items, readIds) {
  const read = readIds instanceof Set ? readIds : new Set(Array.isArray(readIds) ? readIds.map(String) : [])
  return (Array.isArray(items) ? items : []).filter(it => it && !read.has(String(it.id)))
}
