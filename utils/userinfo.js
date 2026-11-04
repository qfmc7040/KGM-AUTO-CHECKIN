/**
 * 用户信息管理工具
 * 提供登录脚本共享的用户信息更新与保存逻辑
 */

import fs from 'node:fs'
import path from 'node:path'
import { printBlue, printGreen, printRed, printYellow } from './colorOut.js'
import { hasSecretWriteToken, setRepoSecret } from './githubSecrets.js'
import { maskIdentifier, sanitizeForLog, shouldPrintSensitiveValue } from './safeLog.js'
import { isValidDevice } from './device.js'

/**
 * 解析 USERINFO JSON 文本。
 * 兼容 UTF-8 BOM（Windows 记事本保存的文件自带 BOM，会导致 JSON.parse 直接失败）与首尾空白。
 * @param {string} text
 * @returns {Array|null} 解析成功返回数组；为空/格式错误/非数组时返回 null
 */
function parseUserinfoJson(text) {
  if (!text) return null
  try {
    const parsed = JSON.parse(String(text).replace(/^\uFEFF/, '').trim())
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 将登录用户信息更新或追加到 userinfo 数组中
 * @param {Array} userinfo - 用户信息数组
 * @param {{ userid: string, token: string, device?: object }} loginUser - 新登录的用户
 * @param {boolean} append - 是否追加模式（已存在则更新，否则添加）
 */
function upsertUser(userinfo, loginUser, append) {
  if (append) {
    for (const user of userinfo) {
      if (user.userid == loginUser.userid) {
        printYellow(`userid: ${maskIdentifier(user.userid)} 此账号已存在, 仅更新登录信息`)
        user.token = loginUser.token
        // 重新登录 = 换用登录流程预生成的新设备标识（统一方案：所有账号每账号一套）
        if (isValidDevice(loginUser.device)) {
          user.device = { ...loginUser.device }
        }
        return
      }
    }
  }
  const entry = { userid: loginUser.userid, token: loginUser.token }
  if (isValidDevice(loginUser.device)) entry.device = { ...loginUser.device }
  userinfo.push(entry)
}

/**
 * 探测目录是否可写：真的写一个临时文件再删掉，而不是只看 stat 权限位。
 * 只读挂载（ro）、NFS root-squash、属主不对（宿主机 ./data 被 sudo 或 Docker
 * 守护进程以 root 创建的典型情况）都会在这里表现为 EACCES/EROFS——正好对应
 * 「扫码登录成功但凭据没保存」这一现象。
 * @param {string} dir 目标目录（不存在时会尝试创建）
 * @returns {{ writable: boolean, reason: string }} reason 为错误码或错误信息
 */
function probeDirWritable(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.rmSync(probe, { force: true })
    return { writable: true, reason: '' }
  } catch (error) {
    try { fs.rmSync(probe, { force: true }) } catch { /* 忽略清理失败 */ }
    return { writable: false, reason: error.code || error.message }
  }
}

/**
 * 权限类错误的修复提示（仅 Docker 挂载卷场景有意义）。
 * @param {string} file
 * @param {Error} error
 */
function printWritePermissionHint(file, error) {
  const code = error && error.code
  if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') return
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  printRed('  原因：凭据目录对当前运行用户不可写（权限 / 只读挂载）。')
  printRed('  在宿主机执行下面这条命令修正属主后重启容器（不要用 chmod 777：data 内是完整 token）：')
  printRed(`    sudo chown -R ${uid}:${gid} ./data`)
  printRed(`  或在该项目的 .env 中显式设置 PUID=${uid} / PGID=${gid} 后重新 up。`)
  printYellow(`  （当前进程 uid:gid = ${uid}:${gid}，目标文件 ${file}）`)
}

/**
 * 将 userinfo JSON 原子化写入本地凭据文件（Docker 部署挂载卷）。
 * 未配置 USERINFO_FILE 时不做任何事，返回 false。
 * @param {string} userinfoJSON
 * @returns {boolean} 是否写入成功
 */
function writeUserinfoFile(userinfoJSON) {
  const file = process.env.USERINFO_FILE
  if (!file) return false
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 先写临时文件再改名，避免写入中途被读取到半截 JSON
    fs.writeFileSync(tmp, userinfoJSON, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (error) {
    printRed(`写入 USERINFO 文件失败 (${file})`)
    console.dir(sanitizeForLog({ message: error.message }), { depth: null })
    printWritePermissionHint(file, error)
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略清理失败 */ }
    return false
  }
}

/**
 * 保存 userinfo 到 GitHub Secret，失败时降级为日志输出。
 * Docker 部署时配置了 USERINFO_FILE，则优先写本地文件（不再依赖 PAT / Secret）。
 * @param {Array} userinfo - 用户信息数组
 */
function saveUserinfo(userinfo) {
  if (!userinfo.length) return

  const userinfoJSON = JSON.stringify(userinfo)

  // Docker 模式：凭据持久化到挂载卷文件
  if (process.env.USERINFO_FILE) {
    if (writeUserinfoFile(userinfoJSON)) {
      printGreen(`USERINFO 已保存到 ${process.env.USERINFO_FILE}`)
      return
    }
    // 写文件失败时继续走原有 Secret/日志流程
  }

  if (hasSecretWriteToken()) {
    try {
      setRepoSecret('USERINFO', userinfoJSON)
      printGreen('secret <USERINFO> 更改成功')
    } catch (error) {
      printRed('自动写入 secret <USERINFO> 出错')
      console.dir(sanitizeForLog({ message: error.message }), { depth: null })
      printUserinfoFallback(userinfoJSON)
    }
  } else {
    printYellow('PAT/GH_TOKEN 未配置，无法自动写入 secret <USERINFO>')
    printUserinfoFallback(userinfoJSON)
  }
}

/**
 * 降级方案：按配置决定是否在日志中输出 USERINFO
 */
function printUserinfoFallback(userinfoJSON) {
  if (shouldPrintSensitiveValue()) {
    printGreen('登录信息如下，把它添加到secret USERINFO 即可')
    printYellow('注意：日志包含登录 token，请用完后删除 Actions 日志')
    printBlue(userinfoJSON)
  } else {
    printYellow('为避免泄露 token，默认不在日志输出 USERINFO')
    printYellow('如必须手动复制，请重新运行并将 print_userinfo 选择为 是')
  }
}

export { upsertUser, saveUserinfo, writeUserinfoFile, parseUserinfoJson, probeDirWritable }
