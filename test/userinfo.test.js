/**
 * utils/userinfo.js 的目录可写性探测单元测试（node:test，无第三方依赖）。
 * 运行：node --test test/
 *
 * 覆盖重点：
 *   1. 目录可写时返回 writable:true（这是正常部署的基线）；
 *   2. 目录不存在时自动创建后仍判定可写（首次 up 场景）；
 *   3. 目标路径不是目录（例如同名文件占位）时返回 writable:false 且带原因，
 *      而不是抛异常——WebUI 启动自检依赖它「永不抛错」；
 *   4. writeUserinfoFile 在不可写时返回 false 而不抛异常（调用方据此提示用户）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { probeDirWritable, writeUserinfoFile } from '../utils/userinfo.js'

/** 每个用例一个独立临时目录 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kgcheckin-userinfo-'))
}

test('可写目录返回 writable:true', () => {
  const r = probeDirWritable(tmpDir())
  assert.equal(r.writable, true)
  assert.equal(r.reason, '')
})

test('目录不存在时自动创建并判定可写', () => {
  const dir = path.join(tmpDir(), 'nested', 'data')
  const r = probeDirWritable(dir)
  assert.equal(r.writable, true)
  assert.equal(fs.existsSync(dir), true)
})

test('探测文件不残留（写完即删）', () => {
  const dir = tmpDir()
  probeDirWritable(dir)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('目标路径被文件占位时返回 writable:false 且不抛异常', () => {
  const dir = tmpDir()
  // 用同名文件占住目录位置：mkdirSync 会以 ENOTDIR/EEXIST 失败
  const occupied = path.join(dir, 'data')
  fs.writeFileSync(occupied, 'not a dir', 'utf8')
  const r = probeDirWritable(occupied)
  assert.equal(r.writable, false)
  assert.equal(typeof r.reason, 'string')
  assert.notEqual(r.reason, '')
})

test('writeUserinfoFile 在不可写路径上返回 false 而不抛异常', () => {
  const dir = tmpDir()
  const occupied = path.join(dir, 'data')
  fs.writeFileSync(occupied, 'not a dir', 'utf8')
  const prev = process.env.USERINFO_FILE
  process.env.USERINFO_FILE = path.join(occupied, 'userinfo.json')
  try {
    assert.equal(writeUserinfoFile('[{"userid":"1","token":"t"}]'), false)
  } finally {
    if (prev === undefined) delete process.env.USERINFO_FILE
    else process.env.USERINFO_FILE = prev
  }
})

test('writeUserinfoFile 可写时返回 true 且内容可被读回', () => {
  const file = path.join(tmpDir(), 'userinfo.json')
  const prev = process.env.USERINFO_FILE
  process.env.USERINFO_FILE = file
  try {
    assert.equal(writeUserinfoFile('[{"userid":"1","token":"t"}]'), true)
    assert.equal(fs.readFileSync(file, 'utf8'), '[{"userid":"1","token":"t"}]')
  } finally {
    if (prev === undefined) delete process.env.USERINFO_FILE
    else process.env.USERINFO_FILE = prev
  }
})

test('未配置 USERINFO_FILE 时直接返回 false（不做任何写入）', () => {
  const prev = process.env.USERINFO_FILE
  delete process.env.USERINFO_FILE
  try {
    assert.equal(writeUserinfoFile('[{"userid":"1","token":"t"}]'), false)
  } finally {
    if (prev !== undefined) process.env.USERINFO_FILE = prev
  }
})
