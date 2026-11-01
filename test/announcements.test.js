/**
 * utils/announcements.js 单元测试（node:test，无第三方依赖）。
 * 运行：node --test test/
 *
 * 覆盖重点：
 *   1. 文件缺失 / JSON 损坏时不抛异常（公告坏了不能连累 WebUI 启动）；
 *   2. 读写往返保真，单条脏数据被跳过而不影响其余公告；
 *   3. 字段规范化与校验（空标题+空正文必须拒绝、长度截断、level 回落）；
 *   4. 排序与「草稿不对外可见」的过滤规则——这两条直接决定访客看到什么。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  LEVELS,
  newAnnouncementId,
  normalizeAnnouncement,
  readAnnouncements,
  sortAnnouncements,
  unreadAnnouncements,
  validateAnnouncement,
  visibleAnnouncements,
  writeAnnouncements,
} from '../utils/announcements.js'

/** 每个用例一个独立临时目录，避免相互干扰 */
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgcheckin-ann-'))
  return path.join(dir, 'announcements.json')
}

test('读不存在的文件返回空列表且不抛异常', () => {
  const r = readAnnouncements(tmpFile())
  assert.deepEqual(r.items, [])
})

test('JSON 损坏时返回空列表且不抛异常', () => {
  const file = tmpFile()
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8')
  assert.deepEqual(readAnnouncements(file).items, [])
})

test('结构不符（顶层是对象但没有 items 数组）时返回空列表', () => {
  const file = tmpFile()
  fs.writeFileSync(file, JSON.stringify({ items: 'nope' }), 'utf8')
  assert.deepEqual(readAnnouncements(file).items, [])
})

test('读写往返保真', () => {
  const file = tmpFile()
  const item = normalizeAnnouncement({
    id: 'fixed-id',
    title: '维护通知',
    body: '今晚 23:00 维护',
    level: 'warn',
    pinned: true,
  })
  assert.deepEqual(writeAnnouncements(file, [item]), { ok: true })
  const back = readAnnouncements(file)
  assert.equal(back.items.length, 1)
  assert.equal(back.items[0].id, 'fixed-id')
  assert.equal(back.items[0].title, '维护通知')
  assert.equal(back.items[0].level, 'warn')
  assert.equal(back.items[0].pinned, true)
  assert.equal(back.items[0].draft, false)
  assert.ok(back.updatedAt, '写盘后应带 updatedAt')
})

test('写盘后不留下 .tmp 文件', () => {
  const file = tmpFile()
  writeAnnouncements(file, [normalizeAnnouncement({ title: 't', body: 'b' })])
  assert.equal(fs.existsSync(`${file}.tmp`), false)
})

test('单条脏数据被跳过，其余公告保留', () => {
  const file = tmpFile()
  fs.writeFileSync(file, JSON.stringify({
    items: [
      'not-an-object',
      { id: 'keep', title: '正常', body: '正文' },
      null,
    ],
  }), 'utf8')
  const items = readAnnouncements(file).items
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'keep')
})

test('重复 id 只保留第一条（避免前端已读记录互相覆盖）', () => {
  const file = tmpFile()
  fs.writeFileSync(file, JSON.stringify({
    items: [
      { id: 'dup', title: '先来的', body: 'a' },
      { id: 'dup', title: '后来的', body: 'b' },
    ],
  }), 'utf8')
  const items = readAnnouncements(file).items
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '先来的')
})

test('标题与正文超长时按上限截断', () => {
  const item = normalizeAnnouncement({
    title: 'a'.repeat(MAX_TITLE_LENGTH + 50),
    body: 'b'.repeat(MAX_BODY_LENGTH + 500),
  })
  assert.equal(item.title.length, MAX_TITLE_LENGTH)
  assert.equal(item.body.length, MAX_BODY_LENGTH)
})

test('非法的 level 回落到 info，pinned/draft 只认布尔 true', () => {
  const item = normalizeAnnouncement({ title: 't', body: 'b', level: 'critical', pinned: 'yes', draft: 1 })
  assert.equal(item.level, 'info')
  assert.equal(item.pinned, false)
  assert.equal(item.draft, false)
})

test('每个合法 level 都被保留', () => {
  for (const level of LEVELS) {
    assert.equal(normalizeAnnouncement({ title: 't', body: 'b', level }).level, level)
  }
})

test('缺失的 id 与 createdAt 会被补齐', () => {
  const item = normalizeAnnouncement({ title: 't', body: 'b' })
  assert.ok(item.id, '应自动生成 id')
  assert.ok(Date.parse(item.createdAt))
  assert.ok(Date.parse(item.updatedAt))
})

test('id 冲突时沿用文件里已有的 id（编辑公告不换身份）', () => {
  const item = normalizeAnnouncement({ title: 't', body: 'b' }, { id: 'old-id', createdAt: '2026-01-01T00:00:00.000Z' })
  assert.equal(item.id, 'old-id')
  assert.equal(item.createdAt, '2026-01-01T00:00:00.000Z')
})

test('标题与正文不能同时为空', () => {
  assert.deepEqual(validateAnnouncement({ title: '', body: '' }), { ok: false, error: '标题与正文不能同时为空' })
  assert.deepEqual(validateAnnouncement({ title: '  ', body: '  ' }), { ok: false, error: '标题与正文不能同时为空' })
  assert.deepEqual(validateAnnouncement({ title: '只有标题', body: '' }), { ok: true })
  assert.deepEqual(validateAnnouncement({ title: '', body: '只有正文' }), { ok: true })
})

test('排序：置顶在前，其余按创建时间倒序，且不修改原数组', () => {
  const list = [
    { id: '1', pinned: false, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: '2', pinned: true, createdAt: '2026-01-02T00:00:00.000Z' },
    { id: '3', pinned: false, createdAt: '2026-03-01T00:00:00.000Z' },
    { id: '4', pinned: true, createdAt: '2026-01-05T00:00:00.000Z' },
  ]
  const before = list.map(i => i.id)
  // 置顶组内部同样按创建时间倒序：4（01-05）在 2（01-02）之前
  assert.deepEqual(sortAnnouncements(list).map(i => i.id), ['4', '2', '3', '1'])
  assert.deepEqual(list.map(i => i.id), before, '原数组顺序不应改变')
})

test('草稿不对外可见，但置顶排序在过滤后仍生效', () => {
  const list = [
    { id: 'd', draft: true, pinned: true, createdAt: '2026-01-09T00:00:00.000Z' },
    { id: 'a', draft: false, pinned: false, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', draft: false, pinned: false, createdAt: '2026-01-05T00:00:00.000Z' },
  ]
  assert.deepEqual(visibleAnnouncements(list).map(i => i.id), ['b', 'a'])
})

test('未读计算：已读集合之外的公告才算未读', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(unreadAnnouncements(items, ['a', 'c']).map(i => i.id), ['b'])
  assert.deepEqual(unreadAnnouncements(items, new Set(['b'])).map(i => i.id), ['a', 'c'])
  assert.deepEqual(unreadAnnouncements(items, []).map(i => i.id), ['a', 'b', 'c'])
  // 已读集合里混入非字符串 / 空值不应抛异常
  assert.deepEqual(unreadAnnouncements(items, [null, 'a']).map(i => i.id), ['b', 'c'])
})

test('生成的 id 不重复', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newAnnouncementId()))
  assert.equal(ids.size, 200)
})

test('写入前会做字段规范化（非法 level 不会落盘）', () => {
  const file = tmpFile()
  writeAnnouncements(file, [{ id: 'x', title: 't', body: 'b', level: 'bogus' }])
  assert.equal(readAnnouncements(file).items[0].level, 'info')
})

test('超过条数上限的公告被丢弃', () => {
  const file = tmpFile()
  const many = Array.from({ length: 260 }, (_, i) => ({ id: `id-${i}`, title: 't', body: 'b' }))
  writeAnnouncements(file, many)
  assert.equal(readAnnouncements(file).items.length, 200)
})
