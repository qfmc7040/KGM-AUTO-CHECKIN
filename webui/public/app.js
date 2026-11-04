/* kgcheckin webui 前端逻辑（无框架，原生 JS） */
/* eslint-env browser */
'use strict'

const $ = sel => document.querySelector(sel)
const $$ = sel => Array.from(document.querySelectorAll(sel))

/* ────────────────── 基础工具 ────────────────── */

let AUTH = sessionStorage.getItem('kc_auth') || ''
if (AUTH) $('#auth-state').textContent = '已解锁'

let authResolvers = []
// 弹窗已打开时复用的 Promise：否则 5 秒一次的 refreshStatus 会在每次 401 时
// 重新压入 resolver 并重置输入框，把用户正在输入的内容清掉。
let authPromise = null

function askAuth() {
  if (authPromise) return authPromise
  $('#auth-err').textContent = ''
  $('#auth-input').value = AUTH
  authPromise = new Promise(resolve => {
    authResolvers.push(resolve)
    $('#auth-dialog').showModal()
  })
  return authPromise
}

function resolveAuth(ok) {
  if ($('#auth-dialog').open) $('#auth-dialog').close()
  authResolvers.forEach(r => r(ok))
  authResolvers = []
  authPromise = null
}

$('#btn-auth-ok').addEventListener('click', submitAuth)
$('#auth-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth() })
$('#btn-auth-cancel').addEventListener('click', () => resolveAuth(false))
// Esc：拦截默认关闭行为，改为让等待中的请求以「取消」结束，避免 Promise 永久悬挂
$('#auth-dialog').addEventListener('cancel', e => { e.preventDefault(); resolveAuth(false) })

/**
 * 用给定密码探测 /api/status，只关心「通不通过」。
 * 不能走 api()：api() 遇 401 会 await askAuth()，而此刻正是弹窗在等待本次结果，
 * 两边互等即死锁（密码错误时界面无反应）。
 *
 * @param {string} key 待验证的访问密码
 * @returns {Promise<object>} 通过时返回响应体
 */
async function probeAuth(key) {
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers['X-WebUI-Key'] = key
  const res = await fetch('/api/status', { headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

async function submitAuth() {
  AUTH = $('#auth-input').value.trim()
  try {
    await probeAuth(AUTH)
    sessionStorage.setItem('kc_auth', AUTH)
    $('#auth-state').textContent = '已解锁'
    $('#auth-err').textContent = ''
    resolveAuth(true)
    refreshAll()
  } catch (e) {
    $('#auth-err').textContent = `// 密码错误：${e.message}`
  }
}

let ACCOUNTS_KEY = sessionStorage.getItem('kc_accts') || ''
let ACCOUNTS_ID = sessionStorage.getItem('kc_accts_id') || ''
/** 公告已读记录（localStorage）：按浏览器记，不跟账号绑定，匿名访客同样适用 */
const ANN_READ_KEY = 'kc_ann_read'

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (AUTH) headers['X-WebUI-Key'] = AUTH
  // 显式传入的账号凭据优先：避免账号管理面板已解锁时的全局 ACCOUNTS_KEY
  // 覆盖本次调用专门指定的 admin 密码（否则会用上一次的凭据去验全量签到）
  if (!headers['X-Accounts-Key'] && ACCOUNTS_KEY) headers['X-Accounts-Key'] = ACCOUNTS_KEY
  if (!headers['X-Accounts-Id'] && ACCOUNTS_ID) headers['X-Accounts-Id'] = ACCOUNTS_ID
  const res = await fetch(path, { ...opts, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // 全局访问密码未通过：弹窗后重试。
    // 账号管理模块的 401（code=accounts-auth）不走这里，由对应面板自行展示锁屏/倒计时
    if (res.status === 401 && data.code === 'webui-auth') {
      const granted = await askAuth()
      if (granted) return api(path, opts)
    }
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

/**
 * 构造带指定账号凭据的请求参数供 api() 使用。
 * 场景：公告管理面板要固定用「面板里输入的那组 admin 凭据」，
 * 而不是 api() 默认会附加的全局 ACCOUNTS_KEY（可能是别的账号的密码）。
 * 只传入非空值，空值时让 api() 走默认逻辑。
 * @param {string} accountsId
 * @param {string} accountsKey
 * @returns {{headers: object}}
 */
function credOpts(accountsId, accountsKey) {
  const headers = {}
  if (accountsId) headers['X-Accounts-Id'] = accountsId
  if (accountsKey) headers['X-Accounts-Key'] = accountsKey
  return { headers }
}

let toastTimer = null
function toast(msg, type = '') {
  const el = $('#toast')
  el.textContent = msg
  el.className = `toast show ${type}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.className = 'toast' }, 4000)
}

/** 按钮冷却倒计时：禁用并在按钮上显示剩余时间（用于验证码 / 二维码的服务端限流） */
function cooldownButton(btn, seconds, idleLabel) {
  const total = Math.max(1, Math.ceil(Number(seconds) || 0))
  clearInterval(btn._coolTimer)
  btn.disabled = true
  let left = total
  const render = () => {
    if (left <= 0) {
      clearInterval(btn._coolTimer)
      btn.disabled = false
      btn.textContent = idleLabel
      return
    }
    const mm = Math.floor(left / 60)
    const ss = left % 60
    btn.textContent = mm > 0
      ? `[ 冷却中(${mm}:${String(ss).padStart(2, '0')}) ]`
      : `[ 冷却中(${left}s) ]`
    left--
  }
  render()
  btn._coolTimer = setInterval(render, 1000)
}

/* ────────────────── 标签页 ────────────────── */

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab))
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`))
    if (tab.dataset.tab === 'accounts') loadAccounts()
    if (tab.dataset.tab === 'announce') openAnnounceTab()
  })
})

/* ────────────────── 状态徽章 / 账号列表 ────────────────── */

/** 凭据目录不可写时的修复提示（服务端 /api/status 的 credential 字段） */
function credentialFixHint() {
  const c = lastStatus && lastStatus.credential
  const uid = (c && c.uid) || 1000
  const gid = (c && c.gid) || 1000
  return `凭据未保存：data 目录不可写（${(c && c.reason) || '权限不足'}）。`
    + `请在宿主机执行 sudo chown -R ${uid}:${gid} ./data 后重启容器，`
    + `或在 .env 设置 PUID=${uid} / PGID=${gid}（不要用 chmod 777）。`
}

/** 登录成功提示文案：saved=false 时如实说明「没保存」而不是假装成功 */
function loginResultText(r) {
  return r.saved
    ? `// ✓ 登录成功，账号 ${r.userid} 已保存`
    : `// ⚠ 登录成功，但账号 ${r.userid} 的凭据未保存（data 目录不可写）`
}

function setChip(id, text, cls) {
  const el = $(id)
  el.textContent = text
  el.className = `chip ${cls || ''}`
}

let lastStatus = null

async function refreshStatus() {
  let s
  try {
    s = await api('/api/status')
  } catch (e) {
    setChip('#chip-cred', `▮ 服务: ${e.message}`, 'err')
    return
  }
  lastStatus = s

  const n = s.accountCount
  const cred = s.credential
  const writable = !cred || cred.writable !== false
  if (!writable) {
    // 目录不可写比「账号数量」重要得多：凭据根本存不住，必须优先红字示警
    setChip('#chip-cred', '▮ 凭据: 目录不可写', 'err')
  } else {
    setChip('#chip-cred', `▮ 凭据: ${n > 0 ? `${n} 个账号` : '未配置'}`, n > 0 ? 'ok' : 'warn')
  }

  const sched = s.schedule
  setChip(
    '#chip-cron',
    sched.valid ? `▮ 计划: ${sched.cron} → ${sched.nextRuns[0] || '--'}` : '▮ 计划: 无效',
    sched.valid ? 'info' : 'err'
  )
  $('#cron-tip').textContent = sched.valid
    ? (sched.previewSupported === false
        ? `⏰ 定时签到：${sched.cron}（${sched.timezone}）· 该表达式不支持预览执行时间`
        : `⏰ 定时签到：${sched.cron}（${sched.timezone}），接下来执行：${sched.nextRuns.join(' / ') || '-'}`)
    : '⚠ CRON_SCHEDULE 无效，定时签到未启用，只能手动签到'

  setChip('#chip-run', `▮ 签到: ${s.checkin.running ? '运行中' : s.checkin.lastRun ? (s.checkin.lastRun.ok ? '上次成功' : '上次失败') : '从未运行'}`,
    s.checkin.running ? 'warn' : s.checkin.lastRun ? (s.checkin.lastRun.ok ? 'ok' : 'err') : '')
  // 运行中时禁用两个签到按钮，避免重复触发
  const running = s.checkin.running
  const one = $('#btn-run-one')
  const all = $('#btn-run-all')
  if (one && !running) one.disabled = false
  if (all && !running) all.disabled = false
  if (running) { if (one) one.disabled = true; if (all) all.disabled = true }
  $('#run-state').textContent = running
    ? '// 签到任务运行中…'
    : s.checkin.lastRun
      ? `// 上次运行：${s.checkin.lastRun.trigger === 'cron' ? '定时' : s.checkin.lastRun.trigger === 'startup' ? '启动' : '手动'} · 退出码 ${s.checkin.lastRun.exitCode}`
      : '// 空闲'
}

/* ────────────────── 账号管理（独立密码锁）────────────────── */

let accountsTimer = null

function showAccountsLock(msg, isErr) {
  $('#accounts-lock').hidden = false
  $('#accounts-content').hidden = true
  const el = $('#accounts-lock-msg')
  el.textContent = msg || ''
  el.className = isErr ? 'err' : 'dim'
  // 回到锁屏即视为失去面板授权：清空账号明细缓存（昵称与完整 ID 属于面板数据）。
  // 过期清单不在此列——它来自公开脱敏接口 /api/expired，主窗口本来就能看，
  // 所以入口按钮与已打开的窗口都保留。
  accountsCache = []
  accountsAdmin = false
  // 锁屏后列表已清空，「只看已过期」与页码也复位，下次解锁从完整列表第 1 页开始
  accountsOnlyExpired = false
  accountsPage = 1
  updateExpiredBadge()
}

/** 账号列表的原始数据与当前搜索词（重新渲染时复用，避免搜索后刷新丢失） */
let accountsCache = []
let accountsAdmin = false
let accountsSearch = ''
/** 「只看已过期」开关：只保留登录凭据已失效（酷狗 20018）的账号，与搜索框叠加生效 */
let accountsOnlyExpired = false
/** 服务端是否配置了 SMTP：没配置就不让人点「绑定邮箱」，否则只会收到 503 */
let mailConfigured = false

/**
 * 分页状态：列表只渲染当前页，账号多时不必一次性铺满。
 * 页码以「筛选后的结果集」为基准，搜索或筛选变化时回到第 1 页。
 */
const ACCOUNTS_PAGE_SIZES = [20, 50, 100]
const ACCOUNTS_PAGE_SIZE_KEY = 'kg-accounts-page-size'
/** 每页条数（可选 20 / 50 / 100），默认 20；用户选择记忆在 localStorage */
let accountsPageSize = (() => {
  try {
    const saved = parseInt(localStorage.getItem(ACCOUNTS_PAGE_SIZE_KEY), 10)
    return ACCOUNTS_PAGE_SIZES.includes(saved) ? saved : ACCOUNTS_PAGE_SIZES[0]
  } catch {
    return ACCOUNTS_PAGE_SIZES[0] // 隐私模式下读不到 localStorage，用默认值
  }
})()
/** 当前页码，从 1 开始；越界由 renderAccountList 统一收敛 */
let accountsPage = 1

/**
 * 按昵称或酷狗ID 过滤账号。
 * 两种字段都做「包含」匹配，且忽略大小写，便于输入部分 ID 或昵称片段。
 * @param {Array} list
 * @param {string} keyword
 * @param {boolean} [onlyExpired] 只保留登录凭据已失效的账号（与关键字同时生效）
 */
function filterAccounts(list, keyword, onlyExpired) {
  const base = onlyExpired ? list.filter(a => a.credentialInvalid) : list
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return base
  return base.filter(a => {
    const id = String(a.rawUserid || '')
    const nick = String(a.nickname || '')
    return id.toLowerCase().includes(kw) || nick.toLowerCase().includes(kw)
  })
}

function renderAccounts(accounts, admin, mustChangePassword, serverMailConfigured) {
  accountsCache = accounts
  accountsAdmin = admin
  mailConfigured = serverMailConfigured === true
  // 以默认密码（酷狗ID）登录：提示尽快修改，避免他人凭 ID 登录并改密
  const warn = $('#accounts-default-pwd-warn')
  if (warn) {
    warn.hidden = !mustChangePassword
    warn.textContent = mustChangePassword
      ? '⚠ 当前使用的是默认密码（酷狗ID）。酷狗ID 对他人可见，请立即点击「修改密码」设置自己的密码。'
      : ''
  }
  // SMTP 未配置：先在面板顶部说明，避免用户逐个点「绑定邮箱」才发现不可用
  const mailWarn = $('#accounts-mail-warn')
  if (mailWarn) {
    mailWarn.hidden = mailConfigured
    mailWarn.textContent = mailConfigured
      ? ''
      : '⚠ 服务端未配置 SMTP（MAIL_HOST / MAIL_USER / MAIL_PASS）：无法绑定通知邮箱，登录失效时也不会发邮件。'
  }
  renderAccountList()
  updateExpiredBadge()
}

/** 同步「只看已过期」按钮：显示过期数量，并标出开关是否打开 */
function syncAccountsExpiredBtn(accounts) {
  const btn = $('#btn-accounts-expired')
  if (!btn) return
  const total = accounts.filter(a => a.credentialInvalid).length
  // 没有过期账号时按钮隐藏，避免点开一个永远为空的列表；
  // 但开关已经打开时必须保留按钮，否则用户没有入口关掉筛选。
  btn.hidden = total === 0 && !accountsOnlyExpired
  btn.textContent = `[ ⚠ 只看已过期（${total}） ]`
  btn.title = '只看登录凭据已失效（需重新扫码/手机号重新登录）的账号'
  btn.setAttribute('aria-pressed', accountsOnlyExpired ? 'true' : 'false')
}

/**
 * 同步分页栏：页码信息、上一页/下一页可用状态、每页条数下拉的选中值。
 * total=0 时整条分页栏隐藏，避免空列表下方挂一排灰按钮。
 * @param {number} total 筛选后的结果总数
 * @param {number} totalPages 总页数（至少 1）
 */
function renderAccountsPager(total, totalPages) {
  const pager = $('#accounts-pager')
  if (!pager) return
  pager.hidden = total === 0
  const sel = $('#accounts-page-size')
  if (sel) sel.value = String(accountsPageSize)
  if (total === 0) return
  const info = $('#accounts-page-info')
  if (info) {
    const start = (accountsPage - 1) * accountsPageSize + 1
    const end = Math.min(total, accountsPage * accountsPageSize)
    info.textContent = `// 第 ${accountsPage} / ${totalPages} 页 · 显示 ${start}-${end}，共 ${total} 条`
  }
  const prev = $('#btn-accounts-prev')
  const next = $('#btn-accounts-next')
  if (prev) prev.disabled = accountsPage <= 1
  if (next) next.disabled = accountsPage >= totalPages
}

/** 仅重绘列表部分（搜索时调用，不重复处理外层状态） */
function renderAccountList() {
  const box = $('#account-list')
  const accounts = accountsCache
  const admin = accountsAdmin
  $('#accounts-lock').hidden = true
  $('#accounts-content').hidden = false
  $('#accounts-who').textContent = admin ? '// 当前身份：admin（管理员）' : `// 当前身份：${ACCOUNTS_ID}`
  $('#btn-accounts-passwd').hidden = false

  if (!accounts.length) {
    box.innerHTML = '<div class="empty dim">// 暂无账号，请先在「扫码登录」或「手机号登录」中添加</div>'
    const cnt = $('#accounts-search-count')
    if (cnt) cnt.textContent = ''
    syncAccountsExpiredBtn(accounts)
    renderAccountsPager(0, 0)
    return
  }

  const shown = filterAccounts(accounts, accountsSearch, accountsOnlyExpired)
  const cntEl = $('#accounts-search-count')
  if (cntEl) {
    const totalExpired = accounts.filter(a => a.credentialInvalid).length
    if (accountsOnlyExpired) {
      // 开关打开时，数字口径是「过期账号里匹配了几个」，避免被总数误导
      const kw = accountsSearch.trim()
      cntEl.textContent = kw
        ? `// 已过期 ${shown.length} / ${totalExpired} 个账号（关键字已生效）`
        : `// 只看已过期：${totalExpired} 个账号`
    } else {
      cntEl.textContent = accountsSearch.trim()
        ? `// 匹配 ${shown.length} / ${accounts.length} 个账号`
        : `// 共 ${accounts.length} 个账号`
    }
  }
  syncAccountsExpiredBtn(accounts)

  if (!shown.length) {
    renderAccountsPager(0, 0)
    if (accountsOnlyExpired) {
      // 区分「一个都没过期」与「过期账号里没有关键字匹配」，否则用户会以为筛选坏了
      const kw = accountsSearch.trim()
      const totalExpired = accounts.filter(a => a.credentialInvalid).length
      box.innerHTML = kw && totalExpired
        ? `<div class="empty dim">// 已过期的账号中没有匹配「${escapeHtml(kw)}」的</div>`
        : '<div class="empty dim">// ✓ 当前没有登录凭据失效的账号</div>'
      return
    }
    box.innerHTML = `<div class="empty dim">// 没有匹配「${escapeHtml(accountsSearch.trim())}」的账号</div>`
    return
  }

  // 分页：按筛选后的结果集切片，页码越界时收敛到最后一页
  const size = accountsPageSize
  const totalPages = Math.max(1, Math.ceil(shown.length / size))
  if (accountsPage > totalPages) accountsPage = totalPages
  if (accountsPage < 1) accountsPage = 1
  const start = (accountsPage - 1) * size
  const pageItems = shown.slice(start, start + size)
  renderAccountsPager(shown.length, totalPages)

  box.innerHTML = ''
  pageItems.forEach(acct => {
    const div = document.createElement('div')
    div.className = 'account-item'
    // 昵称（完整，后端已按面板授权返回）显示在 userid 左侧；无昵称时保持原布局
    const nameHtml = acct.nickname
      ? `<span class="acct-name">${escapeHtml(acct.nickname)}</span><span class="acct-sep">·</span>`
      : ''
    const noPwdHint = acct.hasPassword
      ? ''
      : '<div class="acct-sub warn">⚠ 仍在使用默认密码（酷狗ID），建议尽快修改</div>'
    // 凭据失效：酷狗明确返回 20018，只能重新登录；重跑签到不会恢复
    const invalidHint = acct.credentialInvalid
      ? `<div class="acct-sub bad">⚠ 登录凭据已失效，请重新登录${acct.credentialInvalidAt ? `（${escapeHtml(String(acct.credentialInvalidAt))} 检测）` : ''}</div>`
      : ''
    // VIP 到期时间：签到不再把到期时间刷进日志，统一在此展示
    const vipHtml = acct.vipExpiry
      ? `<div class="acct-sub">VIP 到期: <span class="vip-expiry">${escapeHtml(String(acct.vipExpiry))}</span></div>`
      : '<div class="acct-sub dim">VIP 到期: 未获取（下次签到后显示）</div>'
    // 通知邮箱：绑定的目的只是「凭据失效时能联系到本人」，没绑也不影响签到
    const mailHint = acct.email && acct.emailVerified
      ? `<div class="acct-sub">通知邮箱: <span class="acct-mail">${escapeHtml(String(acct.email))}</span> ✓ 已验证</div>`
      : '<div class="acct-sub dim">通知邮箱: 未绑定（登录失效时不会收到邮件）</div>'
    // userid 完整显示（面板本身受独立密码保护）；搜索高亮匹配片段
    const idHtml = highlightMatch(String(acct.userid), accountsSearch)
    div.innerHTML = `
      <div class="acct-main">
        <div class="acct-id"><span class="idx">[${acct.index}]</span>${nameHtml}userid: ${idHtml}</div>
        <div class="acct-sub">token: ****（${acct.tokenLength} 字符）· 每周日签到时自动刷新</div>
        ${invalidHint}
        ${vipHtml}
        ${mailHint}
        ${noPwdHint}
      </div>`
    // 操作区：邮箱绑定 + 删除，竖排避免挤占账号信息
    const actions = document.createElement('div')
    actions.className = 'acct-actions'

    const mailBtn = document.createElement('button')
    mailBtn.className = 'btn ghost'
    mailBtn.textContent = acct.email && acct.emailVerified ? '[ 更换邮箱 ]' : '[ 绑定邮箱 ]'
    if (!mailConfigured) {
      mailBtn.disabled = true
      mailBtn.title = '服务端未配置 SMTP（MAIL_HOST / MAIL_USER / MAIL_PASS）'
    }
    mailBtn.addEventListener('click', async () => {
      // 验证成功后 askEmailBind 内部已刷新账号列表，这里不再重复请求
      await askEmailBind({
        userid: acct.userid,
        targetUserid: accountsAdmin ? String(acct.rawUserid) : undefined,
        currentEmail: acct.email || '',
      })
    })
    actions.appendChild(mailBtn)

    if (acct.email && acct.emailVerified) {
      const unBtn = document.createElement('button')
      unBtn.className = 'btn ghost'
      unBtn.textContent = '[ 解绑 ]'
      unBtn.addEventListener('click', async () => {
        if (!confirm(`确认解绑账号 ${acct.userid} 的通知邮箱？解绑后失效时不再发邮件。`)) return
        try {
          await api('/api/accounts/email/unbind', {
            method: 'POST',
            body: JSON.stringify(accountsAdmin ? { targetUserid: String(acct.rawUserid) } : {}),
          })
          toast('邮箱已解绑', 'ok')
          loadAccounts()
        } catch (e) {
          if (e.status === 423) lockdownAccounts(e.data && e.data.retryAfter, e.message)
          else toast(e.message, 'err')
        }
      })
      actions.appendChild(unBtn)
    }

    const btn = document.createElement('button')
    btn.className = 'btn danger-ghost'
    btn.textContent = '[ 删除 ]'
    btn.addEventListener('click', async () => {
      if (!confirm(`确认删除账号 ${acct.userid}？`)) return
      try {
        // 按 userid 删除：避免列表在操作期间变化导致误删他人账号
        await api(`/api/accounts/by-id/${encodeURIComponent(acct.rawUserid)}`, { method: 'DELETE' })
        toast('账号已删除', 'ok')
        loadAccounts()
        refreshStatus()
      } catch (e) {
        if (e.status === 423) lockdownAccounts(e.data && e.data.retryAfter, e.message)
        else toast(e.message, 'err')
      }
    })
    actions.appendChild(btn)
    div.appendChild(actions)
    box.appendChild(div)
  })
}

/** 把文本中与搜索词匹配的部分包成高亮 span（先转义再做匹配，避免 XSS） */
function highlightMatch(text, keyword) {
  const safe = escapeHtml(text)
  const kw = String(keyword || '').trim()
  if (!kw) return safe
  const safeKw = escapeHtml(kw)
  const idx = safe.toLowerCase().indexOf(safeKw.toLowerCase())
  if (idx === -1) return safe
  return `${safe.slice(0, idx)}<mark class="hit">${safe.slice(idx, idx + safeKw.length)}</mark>${safe.slice(idx + safeKw.length)}`
}

/** 锁定倒计时：禁用输入与按钮，结束自动恢复 */
function lockdownAccounts(seconds, msg) {
  const idInput = $('#accounts-id')
  const input = $('#accounts-pwd')
  const btn = $('#btn-accounts-unlock')
  showAccountsLock(msg || '', true)
  idInput.disabled = true
  input.disabled = true
  btn.disabled = true
  clearInterval(accountsTimer)
  let remain = Math.max(1, parseInt(seconds, 10) || 300)
  const tick = () => {
    if (remain <= 0) {
      clearInterval(accountsTimer)
      idInput.disabled = false
      input.disabled = false
      btn.disabled = false
      $('#accounts-lock-msg').textContent = '// 锁定已解除，请输入密码'
      $('#accounts-lock-msg').className = 'dim'
      return
    }
    const mm = String(Math.floor(remain / 60)).padStart(2, '0')
    const ss = String(remain % 60).padStart(2, '0')
    $('#accounts-lock-msg').textContent = `⏳ ${msg ? msg + ' · ' : ''}剩余 ${mm}:${ss}`
    remain--
  }
  tick()
  accountsTimer = setInterval(tick, 1000)
}

async function loadAccounts() {
  clearInterval(accountsTimer)
  try {
    const r = await api('/api/accounts')
    renderAccounts(r.accounts, r.admin, r.mustChangePassword, r.mailConfigured)
  } catch (e) {
    if (e.status === 423) {
      lockdownAccounts(e.data && e.data.retryAfter, e.message)
      return
    }
    // 401：需要输入凭据（未提供凭据不计失败次数）
    showAccountsLock(e.status === 401 ? '' : `// 加载失败：${e.message}`, e.status !== 401)
  }
}

async function tryUnlock() {
  const idInput = $('#accounts-id')
  const input = $('#accounts-pwd')
  const btn = $('#btn-accounts-unlock')
  if (input.disabled) return
  const id = idInput.value.trim()
  const pwd = input.value.trim()
  if (!id || !pwd) {
    showAccountsLock('// 请输入酷狗ID和密码', true)
    return
  }
  btn.disabled = true
  try {
    const r = await api('/api/accounts/unlock', { method: 'POST', body: JSON.stringify({ userid: id, password: pwd }) })
    ACCOUNTS_ID = id
    ACCOUNTS_KEY = pwd
    sessionStorage.setItem('kc_accts_id', id)
    sessionStorage.setItem('kc_accts', pwd)
    input.value = ''
    await loadAccounts()
  } catch (e) {
    if (e.status === 423) {
      lockdownAccounts(e.data && e.data.retryAfter, e.message)
      return
    }
    showAccountsLock(`// ${e.message}`, true)
    btn.disabled = false
  }
}

$('#btn-accounts-unlock').addEventListener('click', tryUnlock)
$('#accounts-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock() })
$('#accounts-id').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock() })

$('#btn-accounts-lock').addEventListener('click', () => {
  ACCOUNTS_KEY = ''
  ACCOUNTS_ID = ''
  sessionStorage.removeItem('kc_accts')
  sessionStorage.removeItem('kc_accts_id')
  showAccountsLock('')
})

/* ── 修改密码 ── */
$('#btn-accounts-passwd').addEventListener('click', async () => {
  const isAdmin = ACCOUNTS_ID === 'admin'
  const targetUserid = isAdmin
    ? prompt('输入要修改密码的账号酷狗ID（留空取消）：')
    : ACCOUNTS_ID
  if (!targetUserid) return
  const newPassword = prompt(`为账号 ${targetUserid} 设置新密码（4-64 位）：`)
  if (newPassword == null) return
  if (newPassword.length < 4 || newPassword.length > 64) {
    toast('新密码长度需为 4-64 位', 'err')
    return
  }
  try {
    await api('/api/accounts/password', {
      method: 'POST',
      body: JSON.stringify({ newPassword, ...(isAdmin ? { targetUserid } : {}) }),
    })
    toast('密码已更新', 'ok')
    // 若修改的是自己的密码，更新本地凭据
    if (!isAdmin) {
      ACCOUNTS_KEY = newPassword
      sessionStorage.setItem('kc_accts', newPassword)
    }
  } catch (e) {
    toast(e.message, 'err')
  }
})

/* ────────────────── 通知邮箱（预留 + 验证）────────────────── */

// 当前弹窗的目标账号。来自两处：
//   1. 登录成功后的票根（ticket）——用户无需再输账号密码
//   2. 账号管理面板（已解锁，api() 自动带 X-Accounts-Id/Key）
let emailCtx = null
let emailResolve = null

/**
 * 打开「预留通知邮箱」弹窗。
 * @param {{userid?: string, ticket?: string, targetUserid?: string, currentEmail?: string|null}} ctx
 * @returns {Promise<boolean>} 是否完成了绑定（跳过/关闭为 false）
 */
function askEmailBind(ctx) {
  // 弹窗已在等待中：先结束上一个，避免 Promise 永久悬挂
  if (emailResolve) resolveEmailDialog(false)
  emailCtx = ctx || {}
  $('#email-input').value = emailCtx.currentEmail || ''
  $('#email-code').value = ''
  $('#email-code-row').hidden = true
  $('#btn-email-verify').disabled = true
  $('#email-msg').textContent = ''
  $('#email-msg').className = 'tip'
  $('#email-hint').textContent = emailCtx.userid
    ? `// 账号 ${emailCtx.userid}：留下邮箱，登录凭据失效时通知你重新登录（可跳过）`
    : '// 留下邮箱，登录凭据失效时通知你重新登录（可跳过）'
  emailResolve = null
  const p = new Promise(resolve => { emailResolve = resolve })
  $('#email-dialog').showModal()
  return p
}

function resolveEmailDialog(ok) {
  if ($('#email-dialog').open) $('#email-dialog').close()
  const r = emailResolve
  emailResolve = null
  emailCtx = null
  if (r) r(ok)
}

function setEmailMsg(text, isErr) {
  const el = $('#email-msg')
  el.textContent = text || ''
  el.className = isErr ? 'tip err' : 'tip'
}

/** 把弹窗上下文转成接口 body（票根 / 面板凭据 / admin 指定目标二选一） */
function emailBody(extra) {
  const body = { ...(extra || {}) }
  if (emailCtx && emailCtx.ticket) body.ticket = emailCtx.ticket
  if (emailCtx && emailCtx.targetUserid) body.targetUserid = emailCtx.targetUserid
  return body
}

$('#btn-email-send-code').addEventListener('click', async () => {
  const btn = $('#btn-email-send-code')
  const email = $('#email-input').value.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    setEmailMsg('// 邮箱格式不正确', true)
    return
  }
  btn.disabled = true
  setEmailMsg('// 正在发送…')
  try {
    const r = await api('/api/accounts/email/code', {
      method: 'POST',
      body: JSON.stringify(emailBody({ email })),
    })
    $('#email-code-row').hidden = false
    $('#btn-email-verify').disabled = false
    setEmailMsg(`// 验证码已发送至 ${r.email}，${r.expireMinutes} 分钟内有效`)
    cooldownButton(btn, 60, '[ 发送验证码 ]')
    $('#email-code').focus()
  } catch (e) {
    setEmailMsg(`// ${e.message}`, true)
    // 服务端限流：按真实剩余时间冷却，避免连点
    if (e.status === 429 && e.data && e.data.retryAfter) {
      cooldownButton(btn, e.data.retryAfter, '[ 发送验证码 ]')
    } else {
      btn.disabled = false
    }
  }
})

$('#btn-email-verify').addEventListener('click', async () => {
  const btn = $('#btn-email-verify')
  const code = $('#email-code').value.trim()
  if (!/^\d{6}$/.test(code)) {
    setEmailMsg('// 请输入 6 位数字验证码', true)
    return
  }
  btn.disabled = true
  setEmailMsg('// 正在验证…')
  try {
    const r = await api('/api/accounts/email/verify', {
      method: 'POST',
      body: JSON.stringify(emailBody({ code })),
    })
    toast(`邮箱 ${r.email} 已验证，失效时会通知你`, 'ok')
    resolveEmailDialog(true)
    // 面板里操作时同步刷新列表，显示新的邮箱状态
    if (!$('#accounts-content').hidden) loadAccounts()
  } catch (e) {
    setEmailMsg(`// ${e.message}`, true)
    btn.disabled = false
  }
})

$('#email-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#btn-email-verify').click()
})
$('#btn-email-skip').addEventListener('click', () => resolveEmailDialog(false))
// Esc：按「跳过」处理，避免 Promise 悬挂
$('#email-dialog').addEventListener('cancel', e => { e.preventDefault(); resolveEmailDialog(false) })

/* ────────────────── 扫码登录 ────────────────── */

let qrPolling = false
let qrKeys = [] // { key, card, done }

$('#btn-qr-gen').addEventListener('click', async () => {
  const btn = $('#btn-qr-gen')
  const number = parseInt($('#qr-count').value, 10) || 1
  btn.disabled = true
  $('#qr-hint').textContent = '// 正在生成…'
  let cooling = false
  try {
    const { items } = await api('/api/qr/gen', { method: 'POST', body: JSON.stringify({ number }) })
    const list = $('#qr-list')
    list.innerHTML = ''
    qrKeys = items.map((item, i) => {
      const card = document.createElement('div')
      card.className = 'qr-card'
      card.innerHTML = `
        <h3>账号 ${i + 1}/${items.length} <span class="dim">· 请用酷狗音乐 APP 扫码</span></h3>
        <div class="qr-img-wrap"><img alt="登录二维码" src="${item.dataUrl}" /></div>
        <div class="qr-status wait">⏳ 等待扫描…</div>`
      list.appendChild(card)
      return { key: item.key, card, done: false }
    })
    $('#qr-hint').textContent = `// 已生成 ${items.length} 个二维码，等待扫码确认（约 2 分钟有效）`
    startQrPolling()
    toast('二维码已生成，请扫码', 'ok')
  } catch (e) {
    $('#qr-hint').textContent = ''
    if (e.status === 429 && e.data && e.data.retryAfter) {
      // 服务端限流：按真实剩余时间冷却，不再由 finally 重新启用按钮
      cooling = true
      $('#qr-hint').textContent = `// ${e.message}`
      cooldownButton(btn, e.data.retryAfter, '[ 生成二维码 ]')
    } else {
      toast(e.message, 'err')
    }
  } finally {
    if (!cooling) btn.disabled = false
  }
})

function startQrPolling() {
  if (qrPolling) return
  qrPolling = true
  const timer = setInterval(async () => {
    const pending = qrKeys.filter(k => !k.done)
    if (!pending.length) {
      clearInterval(timer)
      qrPolling = false
      return
    }
    await Promise.all(pending.map(async item => {
      try {
        const r = await api(`/api/qr/status?qrcode=${encodeURIComponent(item.key)}`)
        const statusEl = item.card.querySelector('.qr-status')
        if (r.status === 1) {
          statusEl.textContent = '⏳ 等待扫描…'
          statusEl.className = 'qr-status wait'
        } else if (r.status === 2) {
          statusEl.textContent = '👀 已扫描，请在手机上确认登录'
          statusEl.className = 'qr-status wait'
        } else if (r.status === 4) {
          item.done = true
          item.card.classList.add('done')
          statusEl.textContent = r.saved
            ? `✓ 登录成功 · 账号 ${r.userid} 已保存`
            : `⚠ 登录成功 · 账号 ${r.userid} 凭据未保存`
          statusEl.className = r.saved ? 'qr-status ok' : 'qr-status err'
          // toast 只保留一条：未保存时把修复提示直接说清楚，别用两条互相覆盖
          if (r.saved) {
            toast(`账号 ${r.userid} 登录成功`, 'ok')
          } else {
            toast(credentialFixHint(), 'err')
          }
          refreshStatus()
          // 刚拿到这个账号的登录凭据：此刻是请求用户预留通知邮箱的最佳时机
          if (r.bindTicket) askEmailBind({ userid: r.userid, ticket: r.bindTicket })
        } else {
          item.done = true
          statusEl.textContent = r.status === 0 ? '✗ 二维码已过期，请重新生成' : `✗ 异常状态（${r.status}），请重新生成`
          statusEl.className = 'qr-status err'
        }
      } catch (e) {
        const statusEl = item.card.querySelector('.qr-status')
        statusEl.textContent = `✗ ${e.message}`
        statusEl.className = 'qr-status err'
        item.done = true
      }
    }))
  }, 3000)
}

/* ────────────────── 手机号登录 ────────────────── */

$('#btn-send-code').addEventListener('click', async () => {
  const btn = $('#btn-send-code')
  const phone = $('#phone').value.trim()
  if (!/^1[3-9]\d{9}$/.test(phone)) { toast('手机号格式不正确', 'err'); return }
  btn.disabled = true
  try {
    await api('/api/phone/send', { method: 'POST', body: JSON.stringify({ phone }) })
    toast('验证码已发送，请查收短信', 'ok')
    cooldownButton(btn, 60, '[ 发送验证码 ]')
  } catch (e) {
    toast(e.message, 'err')
    if (e.status === 429 && e.data && e.data.retryAfter) {
      // 服务端限流：按真实剩余时间冷却，避免反复点击徒增无效请求
      cooldownButton(btn, e.data.retryAfter, '[ 发送验证码 ]')
    } else {
      btn.disabled = false
    }
  }
})

$('#btn-phone-login').addEventListener('click', async () => {
  const btn = $('#btn-phone-login')
  const phone = $('#phone').value.trim()
  const code = $('#code').value.trim()
  btn.disabled = true
  $('#phone-hint').textContent = '// 登录中…'
  try {
    const r = await api('/api/phone/login', { method: 'POST', body: JSON.stringify({ phone, code }) })
    $('#phone-hint').textContent = loginResultText(r)
    $('#phone-hint').className = r.saved ? 'dim' : 'dim err'
    $('#code').value = ''
    if (r.saved) {
      toast(`账号 ${r.userid} 登录成功`, 'ok')
    } else {
      toast(credentialFixHint(), 'err')
    }
    refreshStatus()
    // 同扫码登录：登录成功即邀请预留通知邮箱（票根 10 分钟内有效）
    if (r.bindTicket) askEmailBind({ userid: r.userid, ticket: r.bindTicket })
  } catch (e) {
    $('#phone-hint').textContent = `// ${e.message}`
    toast(e.message, 'err')
  } finally {
    btn.disabled = false
  }
})

/* ────────────────── 一键签到 + 实时日志 ────────────────── */

const ANSI_RE = /\x1B\[([0-9;]*)m/g
const ANSI_CLASS = {
  1: 'bold', 2: 'c-dim',
  30: 'c-dim', 31: 'c-red', 32: 'c-green', 33: 'c-yellow', 34: 'c-blue', 35: 'c-magenta', 36: 'c-blue', 37: 'c-dim',
  90: 'c-dim', 91: 'c-red', 92: 'c-green', 93: 'c-yellow', 94: 'c-blue', 95: 'c-magenta',
}

const ANSI_STRIP_RE = /\x1B\[[0-9;]*m/g

/**
 * 去掉 ANSI 颜色转义，得到用于分类/匹配的纯文本。
 *
 * 日志 text 含原始转义码（colorOut 输出形如 \x1B[33m…\x1B[0m），行尾必然有复位码。
 * 若直接用原文判定，「开始领取VIP...$」这类以行尾结尾的正则永远匹配不上，
 * 导致简化模式失效（过程噪音行全部显示出来）。
 */
function plainOf(text) {
  return String(text || '').replace(ANSI_STRIP_RE, '')
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 把含 ANSI 转义的日志行转换为带颜色的 HTML（colorOut 输出形如 \x1B[31m…\x1B[0m） */
function ansiToHtml(raw) {
  let html = ''
  let open = false
  let last = 0
  ANSI_RE.lastIndex = 0
  let m
  // 必须按 SGR 出现的顺序「开/关」span，不能只取最后一段颜色：
  // colorOut 每行都是 `${color}%s\x1B[0m`，行尾的复位码会把整行颜色清掉。
  const closeSpan = () => { if (open) { html += '</span>'; open = false } }
  while ((m = ANSI_RE.exec(raw)) !== null) {
    html += escapeHtml(raw.slice(last, m.index))
    last = ANSI_RE.lastIndex
    const codes = (m[1] || '0').split(';').map(c => parseInt(c, 10) || 0)
    closeSpan()
    if (codes.includes(0)) continue // \x1B[0m 复位：只关闭当前 span
    const cls = codes.map(c => ANSI_CLASS[c]).filter(Boolean)
    if (cls.length) {
      html += `<span class="${cls.join(' ')}">`
      open = true
    }
  }
  html += escapeHtml(raw.slice(last))
  closeSpan()
  return html
}

/**
 * 判断一行日志是否为「已跳过」行（账号今日已签到）。
 *
 * 账号多时这类行会成批出现（每个账号一行），简化模式下全部收起，
 * 改为在批次结束后输出一行汇总，而不是让 N 行淹没关键信息。
 *
 * @param {string} text 已剥离 ANSI 的纯文本
 * @returns {boolean}
 */
function isSkipLine(text) {
  return /账号\s*\S+\s*今日已签到，跳过/.test(plainOf(text))
}

/**
 * 判断一行日志是否属于「详细」级别（简化模式下隐藏）。
 *
 * 简化模式只保留：任务开始/结束、每个账号的结果（听歌成功/失败、今日已领取、
 * 次数用光、领取失败）、错误、跳过汇总。
 * 隐藏的是高频且可推知的类型：
 *   - 领取流程的阶段性提示（「开始领取VIP...」「开始听歌领取VIP...」）
 *   - 逐次领取进度（「第3次领取成功」）
 *   - 等待提示
 *   - 成批的「已跳过」行
 *   - VIP 到期时间（改在「账号管理」面板查看）
 *
 * @param {string} text 去除 ANSI 后的纯文本
 * @returns {boolean} true = 详细日志（简化模式下隐藏）
 */
function isVerboseLine(text) {
  const t = plainOf(text).trim()
  if (!t) return false
  // 阶段开始提示：每个账号这两行必然出现，属过程噪音，结果行才是有效信息
  if (/开始领取VIP\.{0,3}$/.test(t)) return true
  if (/开始听歌领取VIP\.{0,3}$/.test(t)) return true
  if (/开始签到$/.test(t)) return true
  // 逐次领取成功：「第3次领取成功」——保留最终统计即可，中间过程不显示
  if (/第\s*\d+\s*次领取成功/.test(t)) return true
  // 等待提示（8 次领取之间各等 30 秒）
  if (/等待\s*\d+\s*秒|请稍候/.test(t)) return true
  // 已跳过：账号多时成批刷屏，改用末尾汇总行代替
  if (isSkipLine(t)) return true
  // 「今天是」与「VIP到期时间」：到期时间统一在「账号管理」查看，日志里不再重复
  if (/今天是[：:]/.test(t)) return true
  if (/VIP到期时间[：:]/.test(t)) return true
  return false
}

/**
 * 从「[#4/28] 账号 xxx ...」这类日志中提取账号序号。
 * 用于同一账号的多行日志在视觉上对齐（按序号分组着色/缩进）。
 *
 * @param {string} text
 * @returns {string|null} 如 "4"，无序号时返回 null
 */
function accountKeyOf(text) {
  const m = plainOf(text).match(/\[#(\d+)\/\d+\]/)
  return m ? m[1] : null
}

/**
 * 把「[#N/M]」包装为定宽元素，使后续文字从同一列开始。
 * 必须在 ansiToHtml 之后调用。着色后标签会落在颜色 span 内部，
 * 因此不能用「行首未被 span 包裹」的正则，改为就地插入（合法嵌套，不破坏外层颜色）。
 *
 * @param {string} html ansiToHtml 的输出
 * @param {string} rawText 原始日志文本（用于定位标签）
 * @returns {string}
 */
function wrapAccountTag(html, rawText) {
  const m = String(rawText || '').match(/\[#(\d+)\/\d+\]/)
  if (!m) return html
  const tag = m[0]
  const at = html.indexOf(tag)
  if (at === -1) return html
  const span = `<span class="acct-tag" data-acct="${m[1]}">${tag}</span>`
  return html.slice(0, at) + span + html.slice(at + tag.length)
}

/** 当前是否显示详细日志（默认简化） */
let showVerbose = false

/** 依据 showVerbose 切换终端区域的类名 */
function applyVerboseMode() {
  const term = $('.term')
  if (term) term.classList.toggle('verbose', showVerbose)
  const btn = $('#btn-toggle-verbose')
  if (btn) {
    btn.setAttribute('aria-pressed', showVerbose ? 'true' : 'false')
    btn.textContent = showVerbose ? '[ 简化日志 ]' : '[ 详细日志 ]'
  }
  updateEmptyHint()
}

/**
 * 简化模式下若所有行都被隐藏（例如只跑了一次快速失败的账号），
 * 终端会空白。此处给出提示，避免用户误以为卡住。
 */
function updateEmptyHint() {
  const body = $('#term-body')
  if (!body) return
  // 汇总行在简化模式下是可见内容，算作「有内容」
  const visible = Array.from(body.children).filter(el => {
    if (el.classList.contains('empty-hint')) return false
    if (el.classList.contains('skip-summary')) return !showVerbose
    if (el.classList.contains('muted-line') && !showVerbose) return false
    return true
  })
  const hint = body.querySelector('.empty-hint')
  if (visible.length > 0) {
    if (hint) hint.remove()
    return
  }
  if (!hint && body.children.length > 0) {
    const div = document.createElement('div')
    div.className = 'line dim empty-hint'
    div.textContent = '// 已隐藏详细日志，点击「详细日志」查看完整输出'
    body.appendChild(div)
  }
}

/**
 * 折叠连续的「已跳过」行。
 *
 * 账号多时每个已签到账号都会输出一行「账号 xxx 今日已签到，跳过」，
 * 21 个账号就是 21 行，会把真正有信息量的内容挤走。
 *
 * 做法：原始行仍按原样插入 DOM（切到详细模式即可看到全部明细），
 * 简化模式下在「末尾连续的一段跳过行」之后附加一条汇总行显示数量。
 * 汇总行随本批数量递增就地更新；一旦来了非跳过行，本批结束，
 * 汇总行保留在它应在的位置，后续再出现的跳过行会开启新的一批。
 *
 * @param {HTMLElement} line 刚插入的日志行
 */
function foldSkipLines(line) {
  const body = $('#term-body')
  if (!body) return

  // 本行不是跳过行 → 本批结束（既有汇总行留在原处），无需处理
  if (!isSkipLine(line.textContent)) return

  // 向上回溯本批：连续的跳过行。
  // 需跨过两类非内容行：上一次留下的汇总行、以及简化模式下的空状态提示行
  // （后者在第 1 条跳过行进来时就会插入，若不跨过会把同批切断）。
  const batch = [line]
  for (let el = line.previousElementSibling; el; el = el.previousElementSibling) {
    if (el.classList.contains('skip-summary') || el.classList.contains('empty-hint')) continue
    if (isSkipLine(el.textContent)) batch.push(el)
    else break                                            // 遇到其他日志 → 本批到此
  }

  // 移除本批范围内遗留的所有汇总行（从本批首行到当前行之间），
  // 已结束批次的汇总行不在该区间内，因此不受影响。
  const firstRow = batch[batch.length - 1]
  const stale = []
  for (let el = firstRow; el; el = el.nextElementSibling) {
    if (el.classList.contains('skip-summary')) stale.push(el)
    if (el === line) break
  }
  // 当前行之后也可能残留一条（上一轮插在末尾的）
  const after = line.nextElementSibling
  if (after && after.classList.contains('skip-summary')) stale.push(after)
  for (const el of stale) el.remove()

  const count = batch.length
  const summary = document.createElement('div')
  summary.className = 'line skip-summary'
  summary.textContent = count > 1
    ? `// 本批 ${count} 个账号今日已签到，已跳过（点击「详细日志」查看明细）`
    : '// 该账号今日已签到，已跳过（点击「详细日志」查看明细）'
  line.after(summary)
}

function appendLog(entry) {
  const body = $('#term-body')
  const line = document.createElement('div')
  const ts = entry.ts ? `<span class="ts">${entry.ts.slice(11, 19)}</span> ` : ''
  line.className = `line ${entry.level === 'log' ? '' : entry.level}`.trim()
  // 用纯文本判定详细级别（此时 text 尚未转 HTML，判定更可靠）
  if (isVerboseLine(entry.text)) line.classList.add('muted-line')
  // 同一账号的日志标同一序号，供 CSS 做对齐分组
  const acct = accountKeyOf(entry.text)
  if (acct) line.dataset.acct = acct
  line.innerHTML = ts + wrapAccountTag(ansiToHtml(entry.text), entry.text)
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60
  // 仅移除「等待任务输出」这一条占位提示；空状态提示由 updateEmptyHint 统一管理
  const placeholder = body.querySelector('.dim')
  if (placeholder && placeholder.textContent.includes('等待任务输出')) placeholder.remove()
  body.appendChild(line)
  // 折叠连续的「已跳过」行：原始行保留在 DOM 中，简化模式另加一行数量汇总
  foldSkipLines(line)
  // 限制 DOM 行数
  while (body.children.length > 800) body.removeChild(body.firstChild)
  if (nearBottom) body.scrollTop = body.scrollHeight
  updateEmptyHint()
}

function clearTerm() {
  $('#term-body').innerHTML = ''
}

$('#btn-clear-log').addEventListener('click', clearTerm)

// 详细日志开关：默认关闭（简化显示），用户选择记忆在 localStorage
$('#btn-toggle-verbose').addEventListener('click', () => {
  showVerbose = !showVerbose
  applyVerboseMode()
  try { localStorage.setItem('kg-verbose-log', showVerbose ? '1' : '0') } catch { /* 隐私模式忽略 */ }
})

// 恢复上次选择；默认简化
try { showVerbose = localStorage.getItem('kg-verbose-log') === '1' } catch { showVerbose = false }
applyVerboseMode()

let sse = null

function connectSse() {
  if (sse) return
  const url = AUTH ? `/api/checkin/logs?key=${encodeURIComponent(AUTH)}` : '/api/checkin/logs'
  sse = new EventSource(url)
  sse.addEventListener('hello', ev => {
    const info = JSON.parse(ev.data)
    if (info.lastRun) $('#run-state').textContent = `// 上次运行：退出码 ${info.lastRun.exitCode ?? '-'}`
  })
  sse.onmessage = ev => appendLog(JSON.parse(ev.data))
  sse.addEventListener('start', () => { $('#run-state').textContent = '// 签到任务运行中…' })
  sse.addEventListener('end', ev => {
    const r = JSON.parse(ev.data)
    $('#run-state').textContent = r.ok ? '// ✓ 签到完成' : `// ✗ 签到结束，退出码 ${r.exitCode}`
    toast(r.ok ? '签到任务执行成功' : `签到任务失败（退出码 ${r.exitCode}）`, r.ok ? 'ok' : 'err')
    refreshStatus()
    // 本轮可能新判定出凭据失效的账号，刷新过期清单
    refreshExpired()
    // 签到结束会写盘 VIP 到期时间：若当前停在账号管理页，直接重拉列表，
    // 否则用户会看到刚签完的账号仍显示「未获取」，必须切标签页才刷新。
    if ($('#panel-accounts').classList.contains('active')) loadAccounts()
  })
  sse.onerror = () => {
    // 401 等致命错误会让连接进入 CLOSED；置空以便输入密码后能带密钥重建连接
    // （普通网络抖动时 readyState 为 CONNECTING，EventSource 会自动重连，无需处理）
    if (sse && sse.readyState === EventSource.CLOSED) sse = null
  }
}

/** 单账号签到：按 userid 触发，受「每 userid 每天 2 次」配额约束 */
$('#btn-run-one').addEventListener('click', async () => {
  const btn = $('#btn-run-one')
  const userid = $('#run-userid').value.trim()
  if (!userid) {
    toast('请先填写酷狗ID（userid）', 'err')
    $('#run-userid').focus()
    return
  }
  if (!/^\d+$/.test(userid)) {
    toast('userid 应为纯数字', 'err')
    $('#run-userid').focus()
    return
  }
  btn.disabled = true
  try {
    const r = await api('/api/checkin/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userid }),
    })
    $('#run-state').textContent = '// 签到任务已启动…'
    toast(`已启动该账号签到${typeof r?.remaining === 'number' ? `（今日剩余 ${r.remaining} 次）` : ''}`, 'ok')
    refreshStatus()
    refreshQuota()
  } catch (e) {
    btn.disabled = false
    toast(e.message, 'err')
    refreshStatus()
  }
})

/** 全部账号签到：必须通过 admin 账号+密码验证 */
$('#btn-run-all').addEventListener('click', async () => {
  const btn = $('#btn-run-all')
  const password = $('#run-admin-key').value
  if (!password) {
    toast('全部账号签到需要输入 admin 密码', 'err')
    $('#run-admin-key').focus()
    return
  }
  btn.disabled = true
  try {
    await api('/api/checkin/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Accounts-Id': 'admin',
        'X-Accounts-Key': password,
      },
      body: '{}',
    })
    $('#run-state').textContent = '// 签到任务已启动…'
    $('#run-admin-key').value = ''
    toast('全部账号签到已启动', 'ok')
    refreshStatus()
  } catch (e) {
    btn.disabled = false
    toast(e.message || 'admin 验证失败：账号或密码错误', 'err')
    refreshStatus()
  }
})

/** 输入 userid 后自动查询今日剩余次数 */
async function refreshQuota() {
  const userid = $('#run-userid').value.trim()
  const el = $('#run-one-quota')
  if (!el) return
  if (!userid || !/^\d+$/.test(userid)) { el.textContent = ''; return }
  try {
    const q = await api(`/api/checkin/quota?userid=${encodeURIComponent(userid)}`)
    el.textContent = `// 今日已用 ${q.used}/${q.limit} 次，剩余 ${q.remaining} 次`
    el.className = q.remaining > 0 ? 'dim' : 'dim warn'
  } catch {
    el.textContent = ''
  }
}

$('#run-userid').addEventListener('input', () => {
  clearTimeout(refreshQuota._t)
  refreshQuota._t = setTimeout(refreshQuota, 350)
})

/* 方案 B：全部账号签到默认隐藏，点右上角 ⚙ 展开/收起。
   刻意不记忆展开状态：管理员密码框不应在下次打开页面时自动出现。 */
$('#btn-run-admin-toggle').addEventListener('click', () => {
  const panel = $('#run-admin-panel')
  const btn = $('#btn-run-admin-toggle')
  const willShow = panel.hidden
  panel.hidden = !willShow
  btn.setAttribute('aria-pressed', willShow ? 'true' : 'false')
  btn.classList.toggle('active', willShow)
  if (willShow) {
    $('#run-admin-key').focus()
  } else {
    // 收起时清空密码，避免停留在 DOM 中
    $('#run-admin-key').value = ''
  }
})

/* 账号搜索：按昵称或酷狗ID 过滤；结果集变了，页码回到第 1 页 */
$('#accounts-search').addEventListener('input', ev => {
  accountsSearch = ev.target.value
  accountsPage = 1
  clearTimeout($('#accounts-search')._t)
  $('#accounts-search')._t = setTimeout(renderAccountList, 120)
})

/* 「只看已过期」开关：与搜索框叠加生效，点击即切换并立即重绘；结果集变了，回到第 1 页 */
$('#btn-accounts-expired').addEventListener('click', () => {
  accountsOnlyExpired = !accountsOnlyExpired
  accountsPage = 1
  renderAccountList()
})

/* 分页：上一页 / 下一页 / 每页条数（20、50、100），每页条数记忆在 localStorage */

/**
 * 翻页后把页面滚回顶部。
 * 一页 20 条时列表本身就能超出屏幕，翻页后视口往往停在上页末尾，
 * 不回到顶部会让人以为「点了下一页但内容没变」。
 */
function scrollAccountsToTop() {
  // 尊重系统的「减少动态效果」偏好：该设置打开时直接跳转，不做平滑滚动
  let behavior = 'auto'
  try {
    if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      behavior = 'smooth'
    }
  } catch { /* matchMedia 不可用时保持 auto */ }
  try {
    window.scrollTo({ top: 0, behavior })
  } catch {
    window.scrollTo(0, 0) // 不支持配置对象的旧实现
  }
}

$('#btn-accounts-prev').addEventListener('click', () => {
  if (accountsPage > 1) {
    accountsPage -= 1
    renderAccountList()
  }
})
$('#btn-accounts-next').addEventListener('click', () => {
  accountsPage += 1
  renderAccountList() // 越界由 renderAccountList 收敛到最后一页
  scrollAccountsToTop()
})
$('#accounts-page-size').addEventListener('change', ev => {
  const size = parseInt(ev.target.value, 10)
  if (!ACCOUNTS_PAGE_SIZES.includes(size)) return
  accountsPageSize = size
  // 每页条数变化后总页数随之改变，直接回到第 1 页，避免页码语义突变带来的困惑
  accountsPage = 1
  try { localStorage.setItem(ACCOUNTS_PAGE_SIZE_KEY, String(size)) } catch { /* 隐私模式下写不进去，忽略 */ }
  renderAccountList()
})

/* ────────────── 账号过期清单（独立小窗口） ────────────── */

/**
 * 过期账号数据源：GET /api/expired（公开脱敏清单，不需要账号管理密码）。
 * 与账号管理面板的 accountsCache 解耦，因此未解锁时也能看到「哪些账号过期」。
 * 后端只给 昵称 + 脱敏 userid + 检测日期，前端拿不到完整 ID。
 */
let expiredCache = []

/** 刷新过期账号缓存与「⚠ N 个账号已过期」按钮 */
async function refreshExpired() {
  try {
    const r = await api('/api/expired')
    expiredCache = Array.isArray(r.accounts) ? r.accounts : []
  } catch {
    // 拉取失败时保留上一次结果，不要因为一次网络抖动就把入口清空
    return
  }
  updateExpiredBadge()
}

/** 刷新按钮：没有过期账号就隐藏，同时收起已展开的面板 */
function updateExpiredBadge() {
  const count = expiredCache.length
  // 失效账号全部重新登录后，面板没有内容可看，直接收起
  if (count === 0 && isExpiredOpen()) setExpiredOpen(false)
  syncExpiredButton()
}

/**
 * 同步顶栏入口的文案与状态。
 * 文案里带「点击查看」和方向箭头，配合 .warn 的脉冲动画，
 * 让用户一眼看出这个徽章是可以点的。
 */
function syncExpiredButton() {
  const btn = $('#btn-expired')
  if (!btn) return
  const count = expiredCache.length
  const open = isExpiredOpen()
  btn.hidden = count === 0
  btn.textContent = `[ ⚠ ${count} 个账号已过期 · 点击查看 ${open ? '▴' : '▾'} ]`
  btn.title = '点击查看登录已失效的账号清单（完整昵称 + 脱敏酷狗ID）'
  btn.classList.toggle('warn', count > 0)
  btn.classList.toggle('open', open)
  btn.setAttribute('aria-expanded', open ? 'true' : 'false')
}

/** 渲染过期账号列表：完整昵称 + 脱敏 userid + 检测日期 */
function renderExpiredList() {
  const box = $('#expired-list')
  const list = expiredCache
  const cnt = $('#expired-count')
  if (cnt) cnt.textContent = list.length ? `— 共 ${list.length} 个` : ''
  if (!list.length) {
    box.innerHTML = '<div class="expired-empty dim">// 没有登录已失效的账号</div>'
    return
  }
  box.innerHTML = ''
  list.forEach((acct, i) => {
    const row = document.createElement('div')
    row.className = 'expired-item'
    // 昵称完整显示；从未取到昵称时明确标注
    const name = acct.nickname ? escapeHtml(acct.nickname) : '<span class="dim">（未获取昵称）</span>'
    // userid 用后端给的脱敏值（与日志同一套规则），避免大字号展示完整 ID
    const uid = escapeHtml(String(acct.useridMasked || ''))
    const at = acct.detectedAt
      ? `<span class="expired-at">${escapeHtml(String(acct.detectedAt))} 检测</span>`
      : ''
    row.innerHTML = `<span class="expired-idx">[${i + 1}]</span><span class="expired-name">${name}</span><span class="expired-uid">${uid}</span>${at}`
    box.appendChild(row)
  })
}

/** 面板当前是否展开 */
function isExpiredOpen() {
  const pop = $('#expired-pop')
  return Boolean(pop) && !pop.hidden
}

/** 展开 / 收起面板（文档流内的一块区域，展开时把下方内容整体下推） */
function setExpiredOpen(open) {
  const pop = $('#expired-pop')
  if (!pop) return
  pop.hidden = !open
  // 箭头方向与脉冲状态跟着变：展开后按钮高亮、停止脉冲
  syncExpiredButton()
  if (open) renderExpiredList()
}

function toggleExpiredPop() {
  const next = !isExpiredOpen()
  setExpiredOpen(next)
  // 展开时再拉一次最新状态（可能刚重新登录成功）
  if (next) refreshExpired().then(() => { if (isExpiredOpen()) renderExpiredList() })
}

$('#btn-expired').addEventListener('click', ev => {
  // 阻止冒泡，避免同一次点击被别处的监听器当成「点外部」
  ev.stopPropagation()
  toggleExpiredPop()
})

// Esc 收起
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && isExpiredOpen()) setExpiredOpen(false)
  // 公告弹窗的 Esc 由 <dialog> 自身的 cancel 事件处理，这里不重复接管
})

/* ────────────────── 站点公告 ────────────────── */

/**
 * 已读记录只存浏览器本地（localStorage），服务端不保存任何「谁读过」的信息：
 * 公告对匿名访客同样可见，没有账号可绑定，也没必要多存一份隐私数据。
 * 读取时统一丢弃非字符串项，防止被手工改坏的 localStorage 内容影响判断。
 * @returns {string[]}
 */
function getReadAnnIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(ANN_READ_KEY) || '[]')
    return Array.isArray(raw) ? raw.map(String) : []
  } catch {
    return []
  }
}

/** @param {string} id */
function markAnnRead(id) {
  const set = new Set(getReadAnnIds())
  set.add(String(id))
  try { localStorage.setItem(ANN_READ_KEY, JSON.stringify([...set])) } catch { /* 隐私模式下写不进去，忽略 */ }
}

/** 按 id 记录公告正文，供「查看全文」按钮按需取用（列表里可能只显示摘要） */
const annCache = new Map()

/** 刷新公告缓存与顶栏入口；拉取失败保留上一次结果，避免一次抖动就清空入口 */
async function refreshAnnouncements() {
  try {
    const r = await api('/api/announcements')
    annCache.clear()
    for (const it of (Array.isArray(r.items) ? r.items : [])) annCache.set(String(it.id), it)
  } catch {
    return
  }
  updateAnnBadge()
  if (isAnnOpen()) renderAnnList()
}

/** 更新顶栏入口文案：未读 > 0 时显示未读数并脉冲，全部已读后按钮自动隐藏 */
function updateAnnBadge() {
  const btn = $('#btn-ann')
  if (!btn) return
  const read = new Set(getReadAnnIds())
  const unread = [...annCache.values()].filter(it => !read.has(String(it.id))).length
  const total = annCache.size
  if (!total) {
    btn.hidden = true
    setAnnOpen(false)
    return
  }
  btn.hidden = false
  btn.textContent = unread > 0
    ? `[ 📢 ${unread} 条未读公告 · 点击查看 ]`
    : `[ 📢 公告 ${total} 条 · 点击查看 ]`
  btn.classList.toggle('warn', unread > 0)
}

/** @returns {boolean} 公告弹窗是否打开 */
function isAnnOpen() {
  const dlg = $('#ann-dialog')
  return Boolean(dlg) && dlg.open
}

/**
 * 打开 / 关闭公告弹窗。
 * 用原生 <dialog>.showModal()：自动带遮罩、焦点陷阱与 Esc 关闭，与访问密码/通知邮箱
 * 弹窗是同一套机制，无需自己处理层级与外部点击。
 */
function setAnnOpen(open) {
  const dlg = $('#ann-dialog')
  if (!dlg) return
  if (open) {
    if (!dlg.open) dlg.showModal()
    renderAnnList()
  } else if (dlg.open) {
    dlg.close()
  }
  const btn = $('#btn-ann')
  if (btn) {
    btn.setAttribute('aria-expanded', String(Boolean(open)))
    // .chip-btn.open 会停止脉冲动画（与过期清单同一套样式），打开时不该继续闪
    btn.classList.toggle('open', Boolean(open))
  }
}

/**
 * 渲染公告列表。
 * 正文一律用 textContent 写入：公告内容来自管理员，一旦允许 HTML 就等于给出一个
 * 稳定的存储型 XSS 入口，所以这里宁可放弃富文本能力。
 */
function renderAnnList() {
  const box = $('#ann-list')
  if (!box) return
  const list = [...annCache.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
  })
  const read = new Set(getReadAnnIds())
  const unread = list.filter(it => !read.has(String(it.id))).length
  $('#ann-count').textContent = unread > 0
    ? `// 共 ${list.length} 条 · ${unread} 条未读`
    : `// 共 ${list.length} 条 · 全部已读`

  box.textContent = ''
  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'empty dim'
    empty.textContent = '// 暂无公告'
    box.appendChild(empty)
    return
  }

  for (const it of list) {
    const item = document.createElement('div')
    item.className = `ann-item ${it.level || 'info'}`
    if (!read.has(String(it.id))) item.classList.add('unread')

    const head = document.createElement('div')
    head.className = 'ann-head'
    const title = document.createElement('span')
    title.className = 'ann-title'
    title.textContent = it.title || '（无标题）'
    head.appendChild(title)
    // 未读圆点：纯装饰，已读后移除
    if (!read.has(String(it.id))) {
      const dot = document.createElement('span')
      dot.className = 'ann-dot'
      dot.textContent = '●'
      head.appendChild(dot)
    }
    // 级别与置顶标记跟着标题，便于一眼分辨重要公告
    const meta = document.createElement('span')
    meta.className = 'ann-meta dim'
    meta.textContent = ` ${it.pinned ? '置顶 · ' : ''}${it.level} · ${formatTime(it.createdAt)}`
    head.appendChild(meta)
    item.appendChild(head)

    const body = document.createElement('div')
    body.className = 'ann-body'
    body.textContent = it.body || ''
    item.appendChild(body)

    if (!read.has(String(it.id))) {
      const row = document.createElement('div')
      row.className = 'ann-actions'
      const btn = document.createElement('button')
      btn.className = 'btn ghost'
      btn.textContent = '[ 标为已读 ]'
      btn.addEventListener('click', () => {
        markAnnRead(it.id)
        updateAnnBadge()
        renderAnnList()
      })
      row.appendChild(btn)
      item.appendChild(row)
    }

    box.appendChild(item)
  }
}

/** 把 ISO 时间转成本地可读格式；解析失败时原样显示，不显示 NaN */
function formatTime(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return String(iso || '')
  const d = new Date(t)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function toggleAnnDialog() {
  const next = !isAnnOpen()
  setAnnOpen(next)
  // 打开时重新拉一次：可能刚有人发布了新公告
  if (next) refreshAnnouncements().then(() => { if (isAnnOpen()) renderAnnList() })
}

$('#btn-ann').addEventListener('click', () => toggleAnnDialog())

// 弹窗内的「关闭」按钮
$('#btn-ann-close').addEventListener('click', () => setAnnOpen(false))

// Esc：拦截默认关闭，改为走统一的关闭路径，保证顶部入口的高亮状态同步复位
$('#ann-dialog').addEventListener('cancel', e => {
  e.preventDefault()
  setAnnOpen(false)
})

// 点击遮罩（即点击 dialog 自身、而非内部 .auth-box）也关闭
$('#ann-dialog').addEventListener('click', e => {
  if (e.target === $('#ann-dialog')) setAnnOpen(false)
})

// 展开公告不影响别处；「全部标为已读」把当前所有公告 id 写进本地已读集合
$('#btn-ann-readall').addEventListener('click', ev => {
  ev.stopPropagation()
  const all = [...annCache.keys()]
  if (!all.length) return
  try { localStorage.setItem(ANN_READ_KEY, JSON.stringify(all)) } catch { /* 同 markAnnRead */ }
  updateAnnBadge()
  renderAnnList()
})

/* ────────────────── 公告管理（需 admin）────────────────── */

/** 公告管理面板当前使用的 admin 凭据（独立于账号管理面板，避免互相覆盖） */
let ANN_ID = ''
let ANN_KEY = ''
/** 正在编辑的公告 id；为空表示「新建」 */
let annEditingId = ''

/** 打开「公告管理」标签页：没有凭据就先显示锁屏，有凭据直接加载列表 */
function openAnnounceTab() {
  if (ANN_KEY) loadAnnounceManage()
  else showAnnounceLock('')
}

function showAnnounceLock(msg, isErr) {
  $('#announce-lock').hidden = false
  $('#announce-content').hidden = true
  const el = $('#announce-lock-msg')
  el.textContent = msg || ''
  el.className = isErr ? 'err' : 'dim'
}

async function tryUnlockAnnounce() {
  const btn = $('#btn-announce-unlock')
  if (btn.disabled) return
  const id = $('#announce-id').value.trim() || 'admin'
  const key = $('#announce-pwd').value.trim()
  if (!key) {
    showAnnounceLock('// 请输入 admin 密码', true)
    return
  }
  btn.disabled = true
  try {
    // 用 /api/accounts/unlock 校验：它与公告接口共用同一套 admin 校验与锁定计数，
    // 通过后再调公告接口就不会因为凭据格式不同而莫名 401
    await api('/api/accounts/unlock', {
      method: 'POST',
      body: JSON.stringify({ userid: id, password: key }),
    })
    ANN_ID = id
    ANN_KEY = key
    $('#announce-pwd').value = ''
    await loadAnnounceManage()
  } catch (e) {
    if (e.status === 423) {
      showAnnounceLock(`// ${e.message}`, true)
      btn.disabled = false
      return
    }
    showAnnounceLock(`// ${e.message}`, true)
    btn.disabled = false
  }
}

$('#btn-announce-unlock').addEventListener('click', tryUnlockAnnounce)
$('#announce-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlockAnnounce() })

/** 拉取公告管理列表（含草稿）；423/401 分别落到锁屏提示 */
async function loadAnnounceManage() {
  try {
    const r = await api('/api/announcements/manage', credOpts(ANN_ID, ANN_KEY))
    $('#announce-lock').hidden = true
    $('#announce-content').hidden = false
    renderAnnounceManage(Array.isArray(r.items) ? r.items : [])
  } catch (e) {
    if (e.status === 423 || e.status === 401) {
      ANN_KEY = ''
      showAnnounceLock(e.status === 423 ? `// ${e.message}` : '', e.status === 423)
      return
    }
    showAnnounceLock(`// 加载失败：${e.message}`, true)
  }
}

/** 渲染管理列表：每条带「编辑 / 删除」，未读角标与访客视角无关（这里看草稿状态） */
function renderAnnounceManage(items) {
  const box = $('#announce-list')
  const sorted = [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
  })
  $('#announce-count').textContent = `// 共 ${sorted.length} 条`
  box.textContent = ''
  if (!sorted.length) {
    const empty = document.createElement('div')
    empty.className = 'empty dim'
    empty.textContent = '// 还没有公告，填写上方表单即可发布第一条'
    box.appendChild(empty)
    return
  }
  for (const it of sorted) {
    const row = document.createElement('div')
    row.className = `ann-item ${it.level || 'info'}`

    const head = document.createElement('div')
    head.className = 'ann-head'
    const title = document.createElement('span')
    title.className = 'ann-title'
    title.textContent = it.title || '（无标题）'
    head.appendChild(title)
    const meta = document.createElement('span')
    meta.className = 'ann-meta dim'
    meta.textContent = ` ${it.pinned ? '置顶 · ' : ''}${it.level}${it.draft ? ' · 草稿' : ''} · ${formatTime(it.createdAt)}`
    head.appendChild(meta)
    row.appendChild(head)

    const body = document.createElement('div')
    body.className = 'ann-body'
    body.textContent = it.body || ''
    row.appendChild(body)

    const actions = document.createElement('div')
    actions.className = 'ann-actions'
    const editBtn = document.createElement('button')
    editBtn.className = 'btn ghost'
    editBtn.textContent = '[ 编辑 ]'
    editBtn.addEventListener('click', () => startEditAnnounce(it))
    const delBtn = document.createElement('button')
    delBtn.className = 'btn ghost'
    delBtn.textContent = '[ 删除 ]'
    delBtn.addEventListener('click', () => deleteAnnounce(it))
    actions.appendChild(editBtn)
    actions.appendChild(delBtn)
    row.appendChild(actions)

    box.appendChild(row)
  }
}

/** 把一条公告载入表单进入编辑态（按钮文案随之改为「保存修改」） */
function startEditAnnounce(it) {
  annEditingId = it.id
  $('#announce-title').value = it.title || ''
  $('#announce-body').value = it.body || ''
  $('#announce-level').value = it.level || 'info'
  $('#announce-pinned').checked = it.pinned === true
  $('#announce-draft').checked = it.draft === true
  $('#announce-edit-hint').textContent = `// 正在编辑：${it.title || '（无标题）'}`
  $('#btn-announce-save').textContent = '[ 保存修改 ]'
  $('#announce-title').focus()
}

/** 清空表单回到新建态 */
function resetAnnounceForm() {
  annEditingId = ''
  $('#announce-title').value = ''
  $('#announce-body').value = ''
  $('#announce-level').value = 'info'
  $('#announce-pinned').checked = false
  $('#announce-draft').checked = false
  $('#announce-edit-hint').textContent = ''
  $('#btn-announce-save').textContent = '[ 发 布 ]'
}

$('#btn-announce-reset').addEventListener('click', resetAnnounceForm)

$('#btn-announce-save').addEventListener('click', async () => {
  const btn = $('#btn-announce-save')
  if (btn.disabled) return
  const title = $('#announce-title').value.trim()
  const body = $('#announce-body').value.trim()
  if (!title && !body) {
    toast('标题与正文不能同时为空', 'err')
    return
  }
  const payload = {
    title,
    body,
    level: $('#announce-level').value,
    pinned: $('#announce-pinned').checked,
    draft: $('#announce-draft').checked,
  }
  const editing = annEditingId
  btn.disabled = true
  try {
    if (editing) {
      await api(`/api/announcements/${encodeURIComponent(editing)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
        ...credOpts(ANN_ID, ANN_KEY),
      })
      toast('公告已更新', 'ok')
    } else {
      await api('/api/announcements', {
        method: 'POST',
        body: JSON.stringify(payload),
        ...credOpts(ANN_ID, ANN_KEY),
      })
      toast(payload.draft ? '已存为草稿（访客看不到）' : '公告已发布', 'ok')
    }
    resetAnnounceForm()
    await loadAnnounceManage()
    // 管理端改动后同步刷新访客视角的顶栏入口
    await refreshAnnouncements()
  } catch (e) {
    handleAnnWriteError(e)
  } finally {
    btn.disabled = false
  }
})

/** 删除公告：不可逆操作，必须二次确认 */
async function deleteAnnounce(it) {
  const label = it.title || '（无标题）'
  if (!confirm(`确认删除公告「${label}」？此操作不可撤销。`)) return
  try {
    await api(`/api/announcements/${encodeURIComponent(it.id)}`, {
      method: 'DELETE',
      ...credOpts(ANN_ID, ANN_KEY),
    })
    toast('公告已删除', 'ok')
    if (annEditingId === it.id) resetAnnounceForm()
    await loadAnnounceManage()
    await refreshAnnouncements()
  } catch (e) {
    handleAnnWriteError(e)
  }
}

/** 写操作失败的统一处理：锁定 / 未授权落回锁屏，其余只弹提示 */
function handleAnnWriteError(e) {
  if (e.status === 423 || e.status === 401) {
    ANN_KEY = ''
    showAnnounceLock(e.status === 423 ? `// ${e.message}` : '// 登录状态已失效，请重新输入 admin 密码', true)
    return
  }
  toast(e.message || '操作失败', 'err')
}

/* ────────────────── 启动 ────────────────── */

function refreshAll() {
  refreshStatus()
  refreshExpired()
  refreshAnnouncements()
  connectSse()
}

refreshAll()
setInterval(refreshStatus, 5000)
// 过期清单变化很慢（只在签到判定凭据失效时更新），60 秒拉一次足够
setInterval(refreshExpired, 60000)
// 公告可能被管理员随时发布，60 秒拉一次保持顶栏未读角标接近实时
setInterval(refreshAnnouncements, 60000)

// 支持 #qr / #phone / #run / #accounts / #announce 直达对应标签页
const initialTab = location.hash.replace('#', '')
const initialTabEl = $$('.tab').find(t => t.dataset.tab === initialTab)
if (initialTabEl) initialTabEl.click()
