/** 管理隔离网页视图、可见内容提取和受限研究交互。 */
import { session, WebContentsView, type BrowserWindow } from 'electron'
import type { BrowserActivity, BrowserActivityPhase, BrowserBounds, BrowserNavigationAction, BrowserState, ResearchBrowserInteractionTarget, ResearchBrowserLink, ResearchBrowserSnapshot, ResearchPageAccessState, ResearchPageContent } from '../shared/types.js'
import { BrowserLinkOpenError, BrowserNavigationError, type BrowserLinkFailureStage, type ResearchBrowserToolController } from './connectors/types.js'
import { ResearchEgressProxy } from './research-egress-proxy.js'
import { enforceResearchConnectionAllowlist } from './research-connection-policy.js'
import { normalizeResearchUrl, sanitizeResearchSourceUrl, sanitizeResearchUrl, shouldBlockResearchRequest } from './research-url.js'
import { isResearchSearchResultsUrl } from '../shared/research-browser-input.js'
import { MAX_VISIBLE_RESEARCH_LINKS } from '../shared/research-browser-limits.js'
import { waitForResearchPageText } from './research-browser-readiness.js'
import { ResearchNavigationTrace, waitForResearchNavigation } from './research-browser-navigation.js'
import { normalizeVisiblePageText } from './connectors/web-evidence.js'
import { classifyResearchPageAccess } from '../shared/research-page-access.js'

const RESEARCH_PARTITION = 'tripwise-research'
const RESEARCH_SCRIPT_WORLD = 1001
const MAX_VISIBLE_PAGE_TEXT = 30_000
const MAX_INTERACTION_TARGETS = 20
const MAX_RESEARCH_SCREENSHOT_EDGE = 1_440
const BROWSER_ACTIVITY_PHASES = new Set<BrowserActivityPhase>([
  'opening', 'locating', 'moving', 'pressing', 'clicked', 'scrolling', 'scrolled', 'reading'
])
const MAX_RESEARCH_SCREENSHOT_BYTES = 2_000_000
/** 自动浏览最多等待 20 秒；完整加载可由用户在网页栏手动完成。 */
const AGENT_NAVIGATION_TIMEOUT_MS = 20_000
/** Bing 的结果链接由前端延迟渲染，给搜索结果页留出稳定窗口。 */
const SEARCH_RESULTS_MIN_STABLE_MS = 2_500
const INTERACTION_REGISTRY_NAME = '__tripwiseResearchTargetsV1'
const LINK_REGISTRY_NAME = '__tripwiseResearchLinksV1'
const CURSOR_REGISTRY_NAME = '__tripwiseAgentCursorV1'
let researchEgressProxy: ResearchEgressProxy | undefined
let researchSessionProxyReady = false

const VISIBLE_PAGE_SCRIPT = `(() => {
  const interactionTargets = []
  const interactionRegistry = new Map()
  let searchNumber = 0
  let expandNumber = 0
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const accessibleLabel = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby')
    const referencedLabel = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ') : ''
    const label = element.getAttribute('aria-label') || referencedLabel ||
      (element.labels ? Array.from(element.labels).map((item) => item.innerText || '').join(' ') : '') ||
      element.innerText || element.textContent || element.getAttribute('placeholder') || ''
    return label.replace(/\\s+/g, ' ').trim().slice(0, 100)
  }
  const register = (id, action, label, element) => {
    if (interactionTargets.length >= ${MAX_INTERACTION_TARGETS}) return
    interactionTargets.push({ id, action, label })
    interactionRegistry.set(id, { action, label, element })
  }
  for (const element of document.querySelectorAll('input[type="search"], input[role="searchbox"], input[aria-label*="搜索"], input[placeholder*="搜索"]')) {
    if (!(element instanceof HTMLInputElement) || !isVisible(element) || element.disabled || element.readOnly) continue
    if (element.type !== 'search' && element.getAttribute('role') !== 'searchbox' && !accessibleLabel(element).includes('搜索')) continue
    if (!element.name || element.name.length > 80) continue
    const autocomplete = element.autocomplete.toLowerCase()
    if (/password|username|email|one-time-code|cc-/u.test(autocomplete)) continue
    const form = element.form
    if (!form || form.target && form.target !== '_self' || (form.getAttribute('method') || 'get').trim().toLowerCase() !== 'get') continue
    try {
      if (new URL(form.action || location.href, location.href).origin !== location.origin) continue
    } catch {
      continue
    }
    searchNumber += 1
    register('s' + searchNumber, 'search', accessibleLabel(element) || '搜索', element)
  }
  const expandableLabels = new Set(['全文', '查看全文', '展开', '展开全文', '展开全部', '查看更多', '查看更多内容', '加载更多'])
  for (const element of document.querySelectorAll('button, [role="button"]')) {
    if (!isVisible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true' || element.closest('form')) continue
    const label = accessibleLabel(element)
    if (!expandableLabels.has(label)) continue
    expandNumber += 1
    register('e' + expandNumber, 'expand', label, element)
  }
  globalThis['${INTERACTION_REGISTRY_NAME}'] = { url: location.href, targets: interactionRegistry }
  const author = document.querySelector('meta[name="author"], meta[property="article:author"]')?.getAttribute('content')
  const publishedAt = document.querySelector('meta[property="article:published_time"], meta[name="date"], meta[itemprop="datePublished"]')?.getAttribute('content')
    || document.querySelector('time[datetime]')?.getAttribute('datetime')
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .filter(isVisible)
    .slice(0, 120)
    .map((element) => (element.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 180))
    .filter(Boolean)
  const links = []
  const linkTargets = new Map()
  for (const element of document.querySelectorAll('a[href]')) {
    if (links.length >= ${MAX_VISIBLE_RESEARCH_LINKS}) break
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    const text = (element.innerText || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim()
    if (!text || rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue
    let context = ''
    let contextElement = element.parentElement
    for (let depth = 0; depth < 4 && contextElement && contextElement !== document.body; depth += 1) {
      const candidate = (contextElement.innerText || '').replace(/\\s+/g, ' ').trim()
      if (candidate.length > text.length && candidate.length <= 600 && candidate.includes(text)) context = candidate
      if (candidate.length > 600) break
      contextElement = contextElement.parentElement
    }
    const targetId = 'l' + (links.length + 1)
    links.push({ targetId, text, url: element.href, context })
    linkTargets.set(targetId, {
      element,
      url: element.href,
      label: text,
      contextWithoutLabel: context ? context.replace(text, '').replace(/\\s+/g, ' ').trim() : ''
    })
  }
  globalThis['${LINK_REGISTRY_NAME}'] = { url: location.href, targets: linkTargets }
  return {
    title: document.title || '',
    text: document.body ? document.body.innerText : '',
    headings,
    declaredAuthor: author || '',
    declaredPublishedAt: publishedAt || '',
    interactionTargets,
    links
  }
})()`

const MAX_SCROLL_PAGES = 3
const SAFE_EXPAND_LABELS = ['全文', '查看全文', '展开', '展开全文', '展开全部', '查看更多', '查看更多内容', '加载更多']
/** 跳转前留出短暂停顿，让用户看清页面内指针指向的目标。 */
const BROWSER_CURSOR_PAUSE_BEFORE_NAVIGATION_MS = 420
/** 等待页面内指针完成移动，再开始目标动作。 */
const BROWSER_CURSOR_MOVE_MS = 260
/** 按下反馈留出足够观察时间，再触发页面动作。 */
const BROWSER_CURSOR_PRESS_LEAD_MS = 220
/** 滚动阶段至少保留足够绘制时间，让用户看清右侧状态和页面指针。 */
const BROWSER_SCROLL_PHASE_MIN_MS = 280

/** 页面内仅显示非交互指针；目标位置始终来自经过校验的 DOM 快照。 */
const BROWSER_CURSOR_HELPER = `
  // 根据目标边界等待稳定，兼容网页自身的滚动容器和 CSS 平滑滚动。
  const waitForElementScrollStable = async (element, baselinePosition, requireMovement, timeoutMs = 2400) => {
    return new Promise((resolve) => {
      let previousRect = baselinePosition
      let stableFrames = 0
      let hasMoved = false
      const startedAt = performance.now()
      const check = () => {
        if (!element.isConnected) return resolve({ stable: false, moved: hasMoved })
        const rect = element.getBoundingClientRect()
        const currentRect = [rect.top, rect.left, rect.width, rect.height]
        const stable = previousRect && currentRect.every((value, index) => Math.abs(value - previousRect[index]) < 1)
        hasMoved ||= currentRect.some((value, index) => Math.abs(value - baselinePosition[index]) >= 1)
        stableFrames = stable ? stableFrames + 1 : 0
        previousRect = currentRect
        const elapsed = performance.now() - startedAt
        if (stableFrames >= 3 && elapsed >= 80 && (!requireMovement || hasMoved)) resolve({ stable: true, moved: hasMoved })
        else if (elapsed >= timeoutMs) resolve({ stable: false, moved: hasMoved })
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    })
  }
  // 浏览器未自动滚动时，沿最近的可滚动容器补齐定位，再处理页面本身。
  const scrollContainerToTarget = (container, element, isRoot = false) => {
    const target = element.getBoundingClientRect()
    const containerRect = isRoot ? null : container.getBoundingClientRect()
    const top = isRoot ? 0 : containerRect.top + container.clientTop
    const left = isRoot ? 0 : containerRect.left + container.clientLeft
    const height = isRoot ? innerHeight : container.clientHeight
    const width = isRoot ? innerWidth : container.clientWidth
    const margin = 12
    let movementRequested = false
    if (target.top < top + margin || target.bottom > top + height - margin) {
      const delta = target.top + target.height / 2 - (top + height / 2)
      const nextTop = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + delta))
      if (Math.abs(nextTop - container.scrollTop) >= 1) {
        container.scrollTop = nextTop
        movementRequested = true
      }
    }
    if (target.left < left + margin || target.right > left + width - margin) {
      const delta = target.left + target.width / 2 - (left + width / 2)
      const nextLeft = Math.max(0, Math.min(container.scrollWidth - container.clientWidth, container.scrollLeft + delta))
      if (Math.abs(nextLeft - container.scrollLeft) >= 1) {
        container.scrollLeft = nextLeft
        movementRequested = true
      }
    }
    return movementRequested
  }
  const scrollTargetIntoView = (element) => {
    // 目标定位必须在有限帧内稳定；平滑滚动由页面 CSS 控制时会造成跨平台竞态。
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    let movementRequested = false
    let ancestor = element.parentElement
    while (ancestor && ancestor !== document.documentElement) {
      const style = window.getComputedStyle(ancestor)
      const scrollsVertically = ancestor.scrollHeight > ancestor.clientHeight + 1 && !['visible', 'clip'].includes(style.overflowY)
      const scrollsHorizontally = ancestor.scrollWidth > ancestor.clientWidth + 1 && !['visible', 'clip'].includes(style.overflowX)
      if (scrollsVertically || scrollsHorizontally) {
        const moved = scrollContainerToTarget(ancestor, element)
        movementRequested = moved || movementRequested
      }
      ancestor = ancestor.parentElement
    }
    const root = document.scrollingElement
    if (root) {
      const moved = scrollContainerToTarget(root, element, true)
      movementRequested = moved || movementRequested
    }
    return movementRequested
  }
  const showCursorAt = async (left, top, width, height, label) => {
    let state = globalThis['${CURSOR_REGISTRY_NAME}']
    if (!state || !state.host || !state.host.isConnected) {
      const host = document.createElement('div')
      host.setAttribute('aria-hidden', 'true')
      host.setAttribute('data-tripwise-agent-cursor', 'true')
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      // 宿主仅占 1×1；paint containment 会裁掉超出宿主的箭头、目标框和提示标签。
      host.style.cssText = 'position:fixed;left:18px;top:18px;width:1px;height:1px;z-index:2147483647;pointer-events:none;opacity:0;contain:layout style'
      host.style.transition = reduceMotion ? 'opacity 120ms ease' : 'left 260ms cubic-bezier(.2,.8,.2,1),top 260ms cubic-bezier(.2,.8,.2,1),opacity 120ms ease'
      const shadow = host.attachShadow({ mode: 'closed' })
      const style = document.createElement('style')
      style.textContent = ':host{all:initial}.ring{position:absolute;left:0;top:0;transform:translate(-50%,-50%);border:2px solid #4b8654;border-radius:8px;background:rgba(85,151,95,.09);box-shadow:0 0 0 3px rgba(85,151,95,.16);transition:width .15s ease,height .15s ease}.ring::after{content:"";position:absolute;inset:-3px;border:2px solid #4b8654;border-radius:inherit;opacity:0;transform:scale(.88);pointer-events:none}.ring.pressing{background:rgba(85,151,95,.24)}.ring.pressing::after{animation:tripwise-pointer-press 380ms ease-out}@keyframes tripwise-pointer-press{0%{opacity:.75;transform:scale(.88)}100%{opacity:0;transform:scale(1.42)}}@media(prefers-reduced-motion:reduce){.ring,.ring::after{transition:none;animation:none!important}.ring.pressing::after{opacity:.3;transform:scale(1)}}.arrow{position:absolute;left:-5px;top:-4px;width:25px;height:30px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))}.badge{position:absolute;left:14px;top:17px;max-width:180px;padding:4px 7px;border:1px solid rgba(255,255,255,.85);border-radius:5px;background:#355e3c;color:#fff;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.2)}'
      const ring = document.createElement('span')
      ring.className = 'ring'
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      arrow.setAttribute('class', 'arrow')
      arrow.setAttribute('viewBox', '0 0 24 30')
      arrow.innerHTML = '<path d="M3 2v23l6-6 4 9 4-2-4-9h9L3 2z" fill="#fff" stroke="#26372a" stroke-width="1.6" stroke-linejoin="round"/>'
      const badge = document.createElement('span')
      badge.className = 'badge'
      shadow.append(style, ring, arrow, badge)
      document.documentElement.append(host)
      state = { host, ring, badge, phase: 'moving' }
      globalThis['${CURSOR_REGISTRY_NAME}'] = state
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    state.badge.textContent = label
    state.phase = 'moving'
    state.host.dataset.phase = 'moving'
    state.ring.style.width = Math.max(30, Math.min(640, width + 12)) + 'px'
    state.ring.style.height = Math.max(30, Math.min(180, height + 12)) + 'px'
    const cursorLeft = Math.max(4, Math.min(window.innerWidth - 4, left))
    const cursorTop = Math.max(4, Math.min(window.innerHeight - 4, top))
    state.host.style.left = cursorLeft + 'px'
    state.host.style.top = cursorTop + 'px'
    state.host.style.opacity = '1'
    const badgeWidth = state.badge.offsetWidth
    const badgeHeight = state.badge.offsetHeight
    state.badge.style.left = cursorLeft + 14 + badgeWidth <= window.innerWidth - 12
      ? '14px' : '-' + (badgeWidth + 14) + 'px'
    state.badge.style.top = cursorTop + 17 + badgeHeight <= window.innerHeight - 8
      ? '17px' : '-' + (badgeHeight + 8) + 'px'
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduceMotion) await new Promise((resolve) => setTimeout(resolve, ${BROWSER_CURSOR_MOVE_MS}))
    state.phase = 'targeted'
    state.host.dataset.phase = 'targeted'
    return true
  }
  const positionCursorOnElement = async (element, label) => {
    if (!element || !element.isConnected) return { ok: false, stage: 'target_not_rendered' }
    const initialRect = element.getBoundingClientRect()
    const initialPosition = [initialRect.top, initialRect.left, initialRect.width, initialRect.height]
    const movementRequested = scrollTargetIntoView(element)
    const scrollResult = await waitForElementScrollStable(element, initialPosition, movementRequested)
    if (!element.isConnected) return { ok: false, stage: 'target_detached_during_scroll' }
    if (!scrollResult.stable) {
      return { ok: false, stage: scrollResult.moved ? 'target_scroll_unstable' : 'target_scroll_did_not_move' }
    }
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { ok: false, stage: 'target_not_rendered' }
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
      const moved = Math.abs(rect.top - initialPosition[0]) > 1 || Math.abs(rect.left - initialPosition[1]) > 1
      return { ok: false, stage: moved ? 'target_scroll_incomplete' : 'target_scroll_did_not_move' }
    }
    const shown = await showCursorAt(rect.left + rect.width / 2, rect.top + rect.height / 2, rect.width, rect.height, label)
    return shown ? { ok: true } : { ok: false, stage: 'cursor_action_failed' }
  }
  const showCursorOnElement = async (element, label) => {
    return (await positionCursorOnElement(element, label)).ok
  }
  const pressCursor = async () => {
    const state = globalThis['${CURSOR_REGISTRY_NAME}']
    if (!state?.host?.isConnected) return false
    state.phase = 'pressing'
    state.host.dataset.phase = 'pressing'
    state.ring.classList.remove('pressing')
    void state.ring.offsetWidth
    state.ring.classList.add('pressing')
    setTimeout(() => {
      if (!state.host.isConnected) return
      state.ring.classList.remove('pressing')
      if (state.phase === 'pressing') {
        state.phase = 'targeted'
        state.host.dataset.phase = 'targeted'
      }
    }, 380)
    await new Promise((resolve) => setTimeout(resolve, ${BROWSER_CURSOR_PRESS_LEAD_MS}))
    return true
  }
`

/** 仅在当前浏览器视口显示滚动动作，不接受任意模型坐标。 */
function browserScrollScript(direction: 'up' | 'down', pages: number): string {
  const distance = (direction === 'down' ? 1 : -1) * pages
  const directionLabel = direction === 'down' ? '向下' : '向上'
  const label = `${directionLabel}滚动 ${pages} 屏`
  const completedLabel = `已${directionLabel}滚动 ${pages} 屏`
  return `(async () => {${BROWSER_CURSOR_HELPER}
    await showCursorAt(innerWidth * 0.72, innerHeight * 0.68, 42, 42, ${safeScriptLiteral(label)})
    const cursor = globalThis['${CURSOR_REGISTRY_NAME}']
    const phaseStartedAt = performance.now()
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (cursor?.host?.isConnected) {
      cursor.phase = 'scrolling'
      cursor.host.dataset.phase = 'scrolling'
      cursor.ring.classList.add('scrolling')
    }
    window.scrollBy({ top: innerHeight * ${distance}, behavior: reduceMotion ? 'instant' : 'smooth' })
    await new Promise((resolve) => {
      let previousY = window.scrollY
      let stableFrames = 0
      const startedAt = performance.now()
      const waitForScrollEnd = () => {
        const currentY = window.scrollY
        stableFrames = Math.abs(currentY - previousY) < 1 ? stableFrames + 1 : 0
        previousY = currentY
        if (stableFrames >= 3 || performance.now() - startedAt >= 1600) resolve()
        else requestAnimationFrame(waitForScrollEnd)
      }
      requestAnimationFrame(waitForScrollEnd)
    })
    const remainingPhaseMs = ${BROWSER_SCROLL_PHASE_MIN_MS} - (performance.now() - phaseStartedAt)
    if (remainingPhaseMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingPhaseMs))
    if (cursor?.host?.isConnected) {
      cursor.phase = 'scrolled'
      cursor.host.dataset.phase = 'scrolled'
      cursor.ring.classList.remove('scrolling')
      cursor.ring.classList.add('scrolled')
      cursor.badge.textContent = ${safeScriptLiteral(completedLabel)}
    }
    return true
  })()`
}

/** 关闭或截图前移除标记，防止它进入手动浏览或视觉读取结果。 */
const HIDE_BROWSER_CURSOR_SCRIPT = `(() => {
  const state = globalThis['${CURSOR_REGISTRY_NAME}']
  if (state?.host?.isConnected) state.host.remove()
  delete globalThis['${CURSOR_REGISTRY_NAME}']
})()`

type BrowserCursorLinkResult = { ok: true } | { ok: false; stage: BrowserLinkFailureStage }

/** 按最近一次可见快照编号指向链接；目标 URL 仍由主进程映射和导航。 */
function browserCursorForLinkScript(targetId: string): string {
  return `(async () => {${BROWSER_CURSOR_HELPER}
    const fail = (stage) => ({ ok: false, stage })
    const registry = globalThis['${LINK_REGISTRY_NAME}']
    if (!registry) return fail('snapshot_registry_missing')
    if (registry.url !== location.href) return fail('snapshot_registry_page_changed')
    const target = registry.targets.get(${safeScriptLiteral(targetId)})
    if (!target) return fail('snapshot_target_missing')
    if (typeof target.url !== 'string') return fail('snapshot_target_url_missing')
    globalThis['${CURSOR_REGISTRY_NAME}'] = { phase: 'locating' }
    const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim()
    const matchesSnapshot = (element) => {
      if (!element || !element.isConnected || element.href !== target.url) return false
      const style = window.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      return normalizeText(element.innerText || element.getAttribute('aria-label')) === normalizeText(target.label)
    }
    const matchesVisibleUrl = (element) => {
      if (!element || !element.isConnected || element.href !== target.url) return false
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    const contextWithoutLabel = (element) => {
      const label = normalizeText(element?.innerText || element?.getAttribute('aria-label'))
      if (!label) return ''
      let context = ''
      let contextElement = element.parentElement
      for (let depth = 0; depth < 4 && contextElement && contextElement !== document.body; depth += 1) {
        const candidate = normalizeText(contextElement.innerText)
        if (candidate.length > label.length && candidate.length <= 600 && candidate.includes(label)) context = candidate
        if (candidate.length > 600) break
        contextElement = contextElement.parentElement
      }
      return context ? normalizeText(context.replace(label, '')) : ''
    }
    let element = target.element
    if (!matchesSnapshot(element)) {
      // 页面重绘可能改写文案；用快照中的邻近文字区分重复地址，歧义时停止。
      const replacements = Array.from(document.querySelectorAll('a[href]')).filter(matchesSnapshot)
      const sameUrlLinks = Array.from(document.querySelectorAll('a[href]')).filter(matchesVisibleUrl)
      const contextMatches = sameUrlLinks.filter((candidate) =>
        target.contextWithoutLabel && contextWithoutLabel(candidate) === target.contextWithoutLabel
      )
      if (replacements.length === 1) element = replacements[0]
      else if (contextMatches.length === 1) element = contextMatches[0]
      else if (sameUrlLinks.length === 1) element = sameUrlLinks[0]
      else if (contextMatches.length > 1 || sameUrlLinks.length > 1) return fail('target_ambiguous_after_rerender')
      else return fail('target_not_found_after_rerender')
      target.element = element
    }
    const label = (target.label || '').replace(/\\s+/g, ' ').slice(0, 50)
    const positioned = await positionCursorOnElement(element, label ? '打开：' + label : '打开链接')
    if (!positioned.ok) return fail(positioned.stage)
    await new Promise((resolve) => setTimeout(resolve, ${BROWSER_CURSOR_PAUSE_BEFORE_NAVIGATION_MS}))
    if (!await pressCursor()) return fail('cursor_action_failed')
    const cursor = globalThis['${CURSOR_REGISTRY_NAME}']
    if (cursor) {
      cursor.phase = 'opening'
      cursor.host.dataset.phase = 'opening'
    }
    return { ok: true }
  })()`
}

/** 构造固定动作脚本；网页和模型都不能传入 CSS、JavaScript 或任意表单字段。 */
function browserInteractionScript(targetId: string, query?: string): string {
  const targetLiteral = safeScriptLiteral(targetId)
  const queryLiteral = query === undefined ? 'null' : safeScriptLiteral(query)
  const expandableLabelsLiteral = JSON.stringify(SAFE_EXPAND_LABELS)
  return `(async () => {${BROWSER_CURSOR_HELPER}
    const registry = globalThis['${INTERACTION_REGISTRY_NAME}']
    if (!registry || registry.url !== location.href) return { ok: false, reason: 'stale' }
    const target = registry.targets.get(${targetLiteral})
    if (!target || !target.element || !target.element.isConnected) return { ok: false, reason: 'stale' }
    const element = target.element
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return { ok: false, reason: 'not_visible' }
    const labelledBy = element.getAttribute('aria-labelledby')
    const referencedLabel = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ') : ''
    const labels = element.labels ? Array.from(element.labels).map((item) => item.innerText || '').join(' ') : ''
    const label = (element.getAttribute('aria-label') || referencedLabel || labels || element.innerText || element.textContent || element.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 100)
    if (label !== target.label) return { ok: false, reason: 'stale' }
    if (target.action === 'search') {
      const form = element instanceof HTMLInputElement ? element.form : null
      const method = form ? (form.getAttribute('method') || 'get').trim().toLowerCase() : ''
      let sameOrigin = false
      try { sameOrigin = !!form && new URL(form.action || location.href, location.href).origin === location.origin } catch {}
      if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly ||
        (element.type !== 'search' && element.getAttribute('role') !== 'searchbox' && !label.includes('搜索')) ||
        !form || method !== 'get' || !sameOrigin || (form.target && form.target !== '_self')) {
        return { ok: false, reason: 'unsafe_search' }
      }
      const autocomplete = element.autocomplete.toLowerCase()
      if (/password|username|email|one-time-code|cc-/u.test(autocomplete)) return { ok: false, reason: 'unsafe_search' }
      const query = ${queryLiteral}
      if (typeof query !== 'string' || !query.trim() || Array.from(query).length > 160) return { ok: false, reason: 'invalid_query' }
      if (!element.name || element.name.length > 80) return { ok: false, reason: 'unsafe_search' }
      globalThis['${CURSOR_REGISTRY_NAME}'] = { phase: 'locating' }
      if (!await showCursorOnElement(element, '搜索当前网页')) return { ok: false, reason: 'not_visible' }
      await new Promise((resolve) => setTimeout(resolve, ${BROWSER_CURSOR_PAUSE_BEFORE_NAVIGATION_MS}))
      if (!await pressCursor()) return { ok: false, reason: 'not_visible' }
      const destination = new URL(form.action || location.href, location.href)
      destination.search = ''
      destination.hash = ''
      destination.searchParams.set(element.name, query)
      const cursor = globalThis['${CURSOR_REGISTRY_NAME}']
      if (cursor) {
        cursor.phase = 'opening'
        cursor.host.dataset.phase = 'opening'
      }
      location.assign(destination.href)
      return { ok: true, action: 'search' }
    }
    const expandableLabels = new Set(${expandableLabelsLiteral})
    if (target.action !== 'expand' || !(element instanceof HTMLButtonElement || element.getAttribute('role') === 'button') ||
      element.disabled || element.getAttribute('aria-disabled') === 'true' || element.closest('form') || !expandableLabels.has(label)) {
      return { ok: false, reason: 'unsafe_expand' }
    }
    globalThis['${CURSOR_REGISTRY_NAME}'] = { phase: 'locating' }
    if (!await showCursorOnElement(element, '展开页面内容')) return { ok: false, reason: 'not_visible' }
    if (!await pressCursor()) return { ok: false, reason: 'not_visible' }
    element.click()
    const cursor = globalThis['${CURSOR_REGISTRY_NAME}']
    if (cursor) {
      cursor.phase = 'clicked'
      cursor.host.dataset.phase = 'clicked'
    }
    return { ok: true, action: 'expand' }
  })()`
}

/** 将用户搜索词编码为安全 JavaScript 字符串常量，不进入脚本语法。 */
function safeScriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** 只把交互状态码映射为固定错误文本，不回显页面提供的内容。 */
function interactionFailureMessage(reason?: string): string {
  if (reason === 'stale') return '网页交互目标已失效，请先读取当前页面快照。'
  if (reason === 'not_visible') return '网页交互目标已不再可见，请先读取当前页面快照。'
  if (reason === 'unsafe_search') return '仅支持当前网页的同站 GET 搜索框。'
  if (reason === 'invalid_query') return '搜索词应为 1–160 个字符。'
  return '当前网页目标不属于允许的只读交互。'
}

/** 先启动本机出站校验器，再让 Chromium 将研究网页流量固定经过它。 */
export async function configureResearchSessionProxy(): Promise<void> {
  const researchSession = session.fromPartition(RESEARCH_PARTITION)
  researchEgressProxy ??= await ResearchEgressProxy.listen({
    resolveHost: async (hostname, queryType, options) => {
      const result = await researchSession.resolveHost(hostname, { queryType, ...options })
      return result.endpoints.map((endpoint) => endpoint.address)
    },
    resolveProxy: (url) => session.defaultSession.resolveProxy(url)
  })
  try {
    await researchSession.setProxy(researchEgressProxy.sessionProxyConfig)
    researchSessionProxyReady = true
  } catch (error) {
    researchSessionProxyReady = false
    throw error
  }
}

/** 判断隔离网页会话是否已安装回环出站代理。 */
export function isResearchSessionProxyReady(): boolean {
  return researchSessionProxyReady
}

/** 应用退出时关闭临时回环代理和仍在传输的网页连接。 */
export function closeResearchSessionProxy(): void {
  researchEgressProxy?.close()
  researchEgressProxy = undefined
  researchSessionProxyReady = false
}

/** 网页视图只允许加载 HTTP(S) 公网域名；实际连接由本机出站校验器锁定 IP。 */
export class ResearchBrowser implements ResearchBrowserToolController {
  private readonly view: WebContentsView
  private state: BrowserState = { url: '', title: '', loading: false, error: '', canGoBack: false, canGoForward: false }
  private operationQueue: Promise<void> = Promise.resolve()
  private activitySequence = 0
  private activityClearTimer: ReturnType<typeof setTimeout> | undefined
  private agentReadOnlyMode = false
  private blockMutationRequests = false
  private mutationRequestBlocked = false
  private navigationTimedOutUrl = ''
  private snapshotLinkPageUrl = ''
  private snapshotLinkTargets = new Map<string, string>()

  /** 创建无权限研究会话，并为每次请求安装出口与响应头校验。 */
  constructor(private readonly window: BrowserWindow, private readonly onStateChange: (state: BrowserState) => void) {
    const researchSession = session.fromPartition(RESEARCH_PARTITION)
    researchSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    researchSession.setPermissionCheckHandler(() => false)
    researchSession.webRequest.onBeforeRequest((details, callback) => {
      const isMutationRequest = details.method !== 'GET' && details.method !== 'HEAD'
      if (isMutationRequest && (this.agentReadOnlyMode || this.blockMutationRequests)) {
        if (this.blockMutationRequests) this.mutationRequestBlocked = true
        callback({ cancel: true })
        return
      }
      callback(!researchSessionProxyReady || shouldBlockResearchRequest(details.url) ? { cancel: true } : {})
    })
    researchSession.webRequest.onHeadersReceived((details, callback) => {
      if (!researchSessionProxyReady || shouldBlockResearchRequest(details.url)) {
        callback({ cancel: true })
        return
      }
      callback({ responseHeaders: enforceResearchConnectionAllowlist(details.responseHeaders) })
    })

    this.view = new WebContentsView({
      webPreferences: {
        session: researchSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false
      }
    })
    // 研究网页不需要实时音视频；关闭绕过 HTTP(S) 代理的 WebRTC UDP 出站。
    this.view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    this.window.contentView.addChildView(this.view)
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.view.webContents.on('will-navigate', (event, url) => this.preventUnsafeNavigation(event, url))
    this.view.webContents.on('will-redirect', (event, url) => this.preventUnsafeNavigation(event, url))
    researchSession.on('will-download', (event) => event.preventDefault())
    this.view.webContents.on('did-start-loading', () => {
      this.clearSnapshotLinks()
      this.updateState({ ...this.state, loading: true, error: '', accessState: undefined })
    })
    this.view.webContents.on('did-stop-loading', () => {
      this.updateState({
        url: safePageUrl(this.view.webContents.getURL()),
        title: this.view.webContents.getTitle(),
        loading: false,
        error: ''
      })
      void this.detectPageAccessState(this.view.webContents.getURL())
    })
    this.view.webContents.on('did-navigate-in-page', (_event, url) => {
      this.clearSnapshotLinks()
      this.updateState({ ...this.state, url: safePageUrl(url), title: this.view.webContents.getTitle() || url, accessState: undefined })
    })
    this.view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      this.updateState({ ...this.state, loading: false, error: `网页加载失败（${code}）：${description}` })
    })
    this.view.webContents.on('page-title-updated', (_event, title) => {
      this.updateState({ ...this.state, title })
    })
  }

  /** 校验并加载公网网页；页面仍运行在独立、无权限的 Electron 会话中。 */
  async navigate(input: unknown, signal?: AbortSignal): Promise<{ url: string; title: string; navigationTimedOut?: boolean }> {
    return this.enqueue(async () => {
      return this.trackAgentActivity('正在打开网页', (page) => page.navigationTimedOut
        ? '页面加载超时，已读取当前内容' : '已打开网页', async () => {
        const url = normalizeResearchUrl(input)
        return this.navigateNow(url, signal)
      }, signal, 'opening')
    }, signal)
  }

  /** 只打开最近一次快照中的普通链接，令牌类查询参数不经过模型上下文。 */
  async openSnapshotLink(targetId: string, signal?: AbortSignal): Promise<{ url: string; title: string; navigationTimedOut?: boolean }> {
    return this.enqueue(async () => {
      return this.trackAgentActivity('正在打开网页链接', (page) => page.navigationTimedOut
        ? '网页加载超时，已读取当前内容' : '已打开网页链接', async (setPhase) => {
        this.ensureAvailable()
        ensureNotAborted(signal)
        if (this.snapshotLinkPageUrl !== this.view.webContents.getURL()) {
          throw new BrowserLinkOpenError('snapshot_page_changed')
        }
        if (!/^l[1-9][0-9]{0,2}$/u.test(targetId)) throw new BrowserLinkOpenError('target_not_in_snapshot')
        if (this.state.accessState) throw new Error('当前网页需要用户手动处理访问门槛。')
        const url = this.snapshotLinkTargets.get(targetId)
        if (!url) throw new BrowserLinkOpenError('target_not_in_snapshot')
        let cursorResult: BrowserCursorLinkResult
        try {
          cursorResult = await this.executeCursorScript<BrowserCursorLinkResult>(
            browserCursorForLinkScript(targetId), signal, setPhase
          )
        } catch (error) {
          if (signal?.aborted) throw error
          throw new BrowserLinkOpenError('cursor_script_execution', error)
        }
        if (!cursorResult || cursorResult.ok !== true) {
          throw new BrowserLinkOpenError(cursorResult?.stage ?? 'cursor_action_failed')
        }
        setPhase('opening')
        return this.navigateNow(url, signal)
      }, signal, 'locating')
    }, signal)
  }

  /** 执行用户发起的后退、前进或刷新，不把历史导航开放给网页工具。 */
  navigateHistory(action: BrowserNavigationAction): void {
    this.ensureAvailable()
    const history = this.view.webContents.navigationHistory
    if (action === 'back' && history.canGoBack()) history.goBack()
    else if (action === 'forward' && history.canGoForward()) history.goForward()
    else if (action === 'reload' && this.view.webContents.getURL()) this.view.webContents.reload()
    else if (action !== 'back' && action !== 'forward' && action !== 'reload') throw new Error('网页导航动作无效。')
  }

  /** 将网页区域裁剪到主窗口内容范围，隐藏时将面积收为零。 */
  setBounds(input: BrowserBounds): void {
    if (this.view.webContents.isDestroyed() || !input || typeof input !== 'object') return
    this.view.setBounds(this.validateBounds(input))
  }

  /** 仅导入页面可见文字和页面声明元数据，并限制字段长度。 */
  async readVisiblePage(): Promise<ResearchPageContent> {
    const snapshot = await this.readSnapshot()
    return { url: snapshot.url, title: snapshot.title, text: snapshot.text,
      ...(snapshot.accessState ? { accessState: snapshot.accessState } : {}),
      ...(snapshot.declaredAuthor ? { declaredAuthor: snapshot.declaredAuthor } : {}),
      ...(snapshot.declaredPublishedAt ? { declaredPublishedAt: snapshot.declaredPublishedAt } : {}) }
  }

  /** 提供 Agent 所需的可见正文和经过 URL 校验的页面链接。 */
  async readSnapshot(signal?: AbortSignal): Promise<ResearchBrowserSnapshot> {
    return this.enqueue(async () => this.trackAgentActivity(
      '正在读取页面', '已读取页面', () => this.readSnapshotNow(signal), signal, 'reading'
    ), signal)
  }

  /** 仅截取右侧当前可见视口，压缩后以内存字节交给已启用的图片读取器。 */
  async captureViewport(signal?: AbortSignal): Promise<Uint8Array> {
    return this.enqueue(async () => {
      return this.trackAgentActivity('正在读取网页图像', '已读取网页图像', async () => {
        this.ensureAvailable()
        ensureNotAborted(signal)
        await this.hideBrowserCursor()
        const bounds = this.view.getBounds()
        if (bounds.width < 120 || bounds.height < 120) throw new Error('网页面板当前不可见，无法读取截图。')
        const captured = await this.view.webContents.capturePage(undefined, { stayHidden: true })
        ensureNotAborted(signal)
        if (captured.isEmpty()) throw new Error('当前网页没有可读取的画面。')
        const size = captured.getSize()
        if (size.width < 1 || size.height < 1) throw new Error('当前网页没有可读取的画面。')
        const scale = Math.min(1, MAX_RESEARCH_SCREENSHOT_EDGE / Math.max(size.width, size.height))
        const resized = scale < 1
          ? captured.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: 'good'
          })
          : captured
        const jpeg = resized.toJPEG(82)
        if (jpeg.byteLength === 0 || jpeg.byteLength > MAX_RESEARCH_SCREENSHOT_BYTES) {
          throw new Error('网页截图压缩后仍超过 2 MB 上限。')
        }
        return new Uint8Array(jpeg)
      }, signal, 'reading')
    }, signal)
  }

  /** 在可见页面内按页滚动，页数由调用者限制且不会触发表单操作。 */
  async scroll(direction: 'up' | 'down', pages: number, signal?: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      const verticalDirection = direction === 'down' ? '向下' : '向上'
      return this.trackAgentActivity(`正在${verticalDirection}滚动 ${pages} 屏`, `已${verticalDirection}滚动 ${pages} 屏`, async (setPhase) => {
        this.ensureAvailable()
        ensureNotAborted(signal)
        if (!Number.isInteger(pages) || pages < 1 || pages > MAX_SCROLL_PAGES) throw new Error('网页滚动页数超出范围。')
        this.clearSnapshotLinks()
        await this.executeCursorScript<boolean>(browserScrollScript(direction, pages), signal, setPhase)
        ensureNotAborted(signal)
        setPhase('scrolled')
      }, signal, 'moving')
    }, signal)
  }

  /** 只按最近快照目标执行站内 GET 搜索或展开按钮，并拦截交互期间的修改请求。 */
  async interact(targetId: string, query?: string, signal?: AbortSignal): Promise<{ action: 'search' | 'expand' }> {
    return this.enqueue(async () => {
      const isSearch = targetId.startsWith('s')
      return this.trackAgentActivity(
        isSearch ? '正在搜索当前网页' : '正在展开页面内容',
        isSearch ? '已打开搜索结果' : '已展开页面内容',
        async (setPhase) => {
          this.ensureAvailable()
          ensureNotAborted(signal)
          if (!/^[se][1-9][0-9]{0,2}$/u.test(targetId)) throw new Error('网页交互目标已失效。')
          if (isSearch && (!query?.trim() || Array.from(query).length > 160)) throw new Error('搜索词应为 1–160 个字符。')
          if (!isSearch && query !== undefined) throw new Error('展开目标不能包含搜索词。')
          this.clearSnapshotLinks()
          this.mutationRequestBlocked = false
          this.blockMutationRequests = true
          const stopOnAbort = (): void => {
            if (!this.view.webContents.isDestroyed()) this.view.webContents.stop()
          }
          signal?.addEventListener('abort', stopOnAbort, { once: true })
          try {
            const result = await this.executeCursorScript<{
              ok?: boolean
              action?: 'search' | 'expand'
              reason?: string
            }>(browserInteractionScript(targetId, query), signal, setPhase)
            ensureNotAborted(signal)
            if (result.ok !== true || result.action !== (isSearch ? 'search' : 'expand')) {
              throw new Error(interactionFailureMessage(result.reason))
            }
            setPhase(result.action === 'search' ? 'opening' : 'clicked')
            if (!isSearch) await new Promise((resolve) => setTimeout(resolve, 250))
            if (this.mutationRequestBlocked) throw new Error('网页需要非只读请求，已拦截。')
            return { action: result.action }
          } finally {
            this.blockMutationRequests = false
            signal?.removeEventListener('abort', stopOnAbort)
          }
        }, signal, 'locating'
      )
    }, signal)
  }

  /** 判断研究网页和公网出站保护是否都可用。 */
  isAvailable(): boolean {
    return researchSessionProxyReady && !this.view.webContents.isDestroyed()
  }

  /** Agent 控制期间只允许研究网页读取请求，阻止页面脚本提交写入请求。 */
  setAgentReadOnlyMode(enabled: boolean): void {
    this.agentReadOnlyMode = enabled
    if (!enabled) void this.hideBrowserCursor()
  }

  /** Agent 识别到访问门槛后，阻止同一来源继续自动导航；用户界面仍可手动导航。 */
  accessGateForUrl(input: string): ResearchPageAccessState | undefined {
    if (!this.state.accessState || !this.state.url) return undefined
    try {
      return new URL(normalizeResearchUrl(input)).origin === new URL(this.state.url).origin
        ? this.state.accessState
        : undefined
    } catch {
      return undefined
    }
  }

  /** 关闭隔离网页会话，确保应用窗口销毁时不遗留视图进程。 */
  close(): void {
    if (this.activityClearTimer) clearTimeout(this.activityClearTimer)
    void this.hideBrowserCursor()
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
  }

  /** 收紧页面跳转和重定向，避免从公网网页跳到本机或局域网地址。 */
  private preventUnsafeNavigation(event: Electron.Event, input: string): void {
    try {
      normalizeResearchUrl(input)
    } catch {
      event.preventDefault()
    }
  }

  /** 防止视图已销毁后 IPC 继续读取或导航网页。 */
  private ensureAvailable(): void {
    if (this.view.webContents.isDestroyed()) throw new Error('网页面板当前不可用。')
    if (!researchSessionProxyReady) throw new Error('网页出站保护未就绪，暂时无法打开网页。')
  }

  /** 仅在 Agent 运行时发布浏览动作；查询词和页面目标文本不离开隔离浏览器。 */
  private async trackAgentActivity<T>(
    runningMessage: string,
    completedMessage: string | ((result: T) => string),
    operation: (setPhase: (phase: BrowserActivityPhase) => void) => Promise<T>,
    signal?: AbortSignal,
    initialPhase: BrowserActivityPhase = 'reading'
  ): Promise<T> {
    const activityId = this.agentReadOnlyMode ? ++this.activitySequence : undefined
    const setPhase = (phase: BrowserActivityPhase): void => {
      if (activityId !== undefined && activityId === this.activitySequence && this.state.activity?.status === 'running') {
        this.updateState({ activity: { ...this.state.activity, phase } })
      }
    }
    if (activityId !== undefined) {
      if (this.activityClearTimer) clearTimeout(this.activityClearTimer)
      this.updateState({ activity: { status: 'running', message: runningMessage, phase: initialPhase } })
    }
    try {
      const result = await operation(setPhase)
      const completion = typeof completedMessage === 'function' ? completedMessage(result) : completedMessage
      if (activityId !== undefined) this.finishAgentActivity(activityId, 'completed', completion)
      return result
    } catch (error) {
      if (activityId !== undefined) {
        this.finishAgentActivity(activityId, signal?.aborted ? 'cancelled' : 'failed',
          signal?.aborted ? '浏览操作已停止' : '浏览操作未完成')
      }
      throw error
    }
  }

  /** 保留最近一次动作结果四秒；下一动作开始时立即更新。 */
  private finishAgentActivity(
    activityId: number,
    status: Exclude<BrowserActivity['status'], 'running'>,
    message: string
  ): void {
    if (activityId !== this.activitySequence) return
    this.updateState({ activity: { status, message, phase: this.state.activity?.phase } })
    if (this.activityClearTimer) clearTimeout(this.activityClearTimer)
    this.activityClearTimer = setTimeout(() => {
      if (activityId === this.activitySequence) this.updateState({ activity: null })
      this.activityClearTimer = undefined
    }, 4_000)
  }

  /** 只执行内部固定脚本；模型不能提供脚本、CSS 选择器或屏幕坐标。 */
  private async executeCursorScript<T>(
    script: string,
    signal?: AbortSignal,
    onPhase?: (phase: BrowserActivityPhase) => void
  ): Promise<T> {
    this.ensureAvailable()
    ensureNotAborted(signal)
    const operation = this.view.webContents.executeJavaScriptInIsolatedWorld(RESEARCH_SCRIPT_WORLD, [{ code: script }])
    const visible = await this.observeBrowserCursorPhase(operation, onPhase)
    ensureNotAborted(signal)
    return visible as T
  }

  /** 读取隔离执行脚本的固定阶段码，不读取或转发网页文本。 */
  private async observeBrowserCursorPhase<T>(
    operation: Promise<T>,
    onPhase?: (phase: BrowserActivityPhase) => void
  ): Promise<T> {
    if (!onPhase) return operation
    let observing = true
    let polling = false
    let lastPhase: BrowserActivityPhase | undefined
    const readPhase = async (): Promise<void> => {
      if (!observing || polling || this.view.webContents.isDestroyed()) return
      polling = true
      try {
        const phase = await this.view.webContents.executeJavaScriptInIsolatedWorld(RESEARCH_SCRIPT_WORLD, [{
          code: `(() => { const phase = globalThis['${CURSOR_REGISTRY_NAME}']?.phase; return typeof phase === 'string' ? phase : null })()`
        }])
        if (typeof phase === 'string' && BROWSER_ACTIVITY_PHASES.has(phase as BrowserActivityPhase) && phase !== lastPhase) {
          lastPhase = phase as BrowserActivityPhase
          onPhase(lastPhase)
        }
      } catch {
        // 页面切换或退出时阶段可能消失；不影响本次浏览动作结果。
      } finally {
        polling = false
      }
    }
    const timer = setInterval(() => { void readPhase() }, 70)
    try {
      const result = await operation
      await readPhase()
      return result
    } finally {
      observing = false
      clearInterval(timer)
    }
  }

  /** 清除页面标记；页面关闭或导航时不影响原有浏览流程。 */
  private async hideBrowserCursor(): Promise<void> {
    if (this.view.webContents.isDestroyed()) return
    const currentUrl = this.view.webContents.getURL()
    if (!currentUrl || currentUrl === 'about:blank') return
    try {
      await this.view.webContents.executeJavaScriptInIsolatedWorld(RESEARCH_SCRIPT_WORLD, [
        { code: HIDE_BROWSER_CURSOR_SCRIPT }
      ])
    } catch {
      // 页面正在关闭或切换时，下一份文档不会继承旧标记。
    }
  }

  /** 清除仅在同一页面快照中有效的链接编号。 */
  private clearSnapshotLinks(): void {
    this.snapshotLinkPageUrl = ''
    this.snapshotLinkTargets.clear()
  }

  /** 串行队列内执行导航，确保所有入口共享相同取消和脱敏行为。 */
  private async navigateNow(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; navigationTimedOut?: boolean }> {
    this.ensureAvailable()
    ensureNotAborted(signal)
    await this.hideBrowserCursor()
    this.clearSnapshotLinks()
    this.navigationTimedOutUrl = ''
    this.updateState({ url: safePageUrl(url), title: safePageUrl(url), loading: true, error: '', accessState: undefined })
    const navigationTrace = new ResearchNavigationTrace()
    const webContents = this.view.webContents
    const recordNavigationStart = (_event: Electron.Event, _url: string, _isInPlace: boolean, isMainFrame: boolean): void => {
      navigationTrace.started(isMainFrame)
    }
    const recordNavigationRedirect = (_event: Electron.Event, _url: string, _isInPlace: boolean, isMainFrame: boolean): void => {
      navigationTrace.redirected(isMainFrame)
    }
    const recordNavigationCommit = (): void => navigationTrace.committed()
    webContents.on('did-start-navigation', recordNavigationStart)
    webContents.on('will-redirect', recordNavigationRedirect)
    webContents.on('did-navigate', recordNavigationCommit)
    const stopOnAbort = (): void => {
      if (!this.view.webContents.isDestroyed()) this.view.webContents.stop()
    }
    signal?.addEventListener('abort', stopOnAbort, { once: true })
    try {
      const navigationOutcome = this.agentReadOnlyMode
        ? await waitForResearchNavigation(
          () => this.view.webContents.loadURL(url),
          () => { if (!this.view.webContents.isDestroyed()) this.view.webContents.stop() },
          AGENT_NAVIGATION_TIMEOUT_MS
        )
        : (await this.view.webContents.loadURL(url), 'loaded' as const)
      ensureNotAborted(signal)
      const currentUrl = this.view.webContents.getURL()
      if (navigationOutcome === 'timed_out') this.navigationTimedOutUrl = currentUrl
      let title = this.view.webContents.getTitle() || url
      if (navigationOutcome === 'loaded') {
        try {
          const documentTitle: unknown = await this.view.webContents.executeJavaScript('document.title')
          if (typeof documentTitle === 'string' && documentTitle.trim()) title = documentTitle.trim()
        } catch {
          // 页面关闭或跨平台标题事件较慢时，保留 Electron 当前标题作为回退。
        }
      }
      return {
        url: safePageUrl(currentUrl),
        title,
        ...(navigationOutcome === 'timed_out' ? { navigationTimedOut: true } : {})
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      throw new BrowserNavigationError(navigationTrace.stage, error)
    } finally {
      webContents.off('did-start-navigation', recordNavigationStart)
      webContents.off('will-redirect', recordNavigationRedirect)
      webContents.off('did-navigate', recordNavigationCommit)
      signal?.removeEventListener('abort', stopOnAbort)
    }
  }

  /** 串行执行网页操作，避免 Agent 工具并发导致页面导航竞态。 */
  private enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const action = this.operationQueue.then(async () => {
      ensureNotAborted(signal)
      return operation()
    })
    this.operationQueue = action.then(() => undefined, () => undefined)
    return action
  }

  /** 读取正文、页面声明信息和有限的安全链接，不执行页面提供的代码。 */
  private async readSnapshotNow(signal?: AbortSignal): Promise<ResearchBrowserSnapshot> {
    this.ensureAvailable()
    ensureNotAborted(signal)
    this.clearSnapshotLinks()
    const isSearchResultsPage = isResearchSearchResultsUrl(safePageUrl(this.view.webContents.getURL()))
    await waitForResearchPageText(async () => {
      this.ensureAvailable()
      ensureNotAborted(signal)
      const page = await this.view.webContents.executeJavaScriptInIsolatedWorld(RESEARCH_SCRIPT_WORLD, [
        { code: '({ text: document.body ? document.body.innerText : "", linkCount: document.querySelectorAll("a[href]").length })' }
      ]) as { text?: unknown; linkCount?: unknown } | null
      ensureNotAborted(signal)
      return {
        loading: this.view.webContents.isLoading(),
        text: typeof page?.text === 'string' ? page.text : '',
        linkCount: typeof page?.linkCount === 'number' ? page.linkCount : 0
      }
    }, { minimumStableMs: isSearchResultsPage ? SEARCH_RESULTS_MIN_STABLE_MS : 500 })
    const currentUrl = this.view.webContents.getURL()
    const raw = await this.view.webContents.executeJavaScriptInIsolatedWorld(RESEARCH_SCRIPT_WORLD, [
      { code: VISIBLE_PAGE_SCRIPT }
    ]) as Partial<ResearchBrowserSnapshot> & { headings?: unknown }
    ensureNotAborted(signal)
    const headingTexts = Array.isArray(raw.headings)
      ? raw.headings.filter((heading): heading is string => typeof heading === 'string').slice(0, 120)
      : []
    const text = typeof raw.text === 'string'
      ? normalizeVisiblePageText(raw.text, headingTexts).slice(0, MAX_VISIBLE_PAGE_TEXT)
      : ''
    if (!text) throw new Error('当前网页没有可读取的可见文字。')
    const accessState = classifyResearchPageAccess(text)
    if (this.state.accessState !== accessState) this.updateState({ accessState })
    const declaredAuthor = pageMetadataValue(raw.declaredAuthor, 120)
    const declaredPublishedAt = pageMetadataValue(raw.declaredPublishedAt, 100)
    const links: ResearchBrowserLink[] = []
    const seenLinkIds = new Set<string>()
    for (const item of Array.isArray(raw.links) ? raw.links : []) {
      if (links.length >= MAX_VISIBLE_RESEARCH_LINKS || !item || typeof item !== 'object' ||
        typeof item.targetId !== 'string' || !/^l[1-9][0-9]{0,2}$/u.test(item.targetId) ||
        typeof item.text !== 'string' || typeof item.url !== 'string' || seenLinkIds.has(item.targetId)) continue
      try {
        // 快照链接只保留小红书公开笔记所需的访问参数；其他站点凭证不随模型点击请求发送。
        const targetUrl = sanitizeResearchSourceUrl(item.url)
        const text = pageMetadataValue(item.text, 160)
        if (!text) continue
        const targetId = item.targetId
        seenLinkIds.add(targetId)
        this.snapshotLinkTargets.set(targetId, targetUrl)
        const context = pageMetadataValue(item.context, 600)
        links.push({ targetId, text, url: safePageUrl(targetUrl), ...(context ? { context } : {}) })
      } catch {
        // 非 HTTP(S) 或非公网目标不会进入链接编号表。
      }
    }
    this.snapshotLinkPageUrl = this.view.webContents.getURL()
    const interactionTargets = (Array.isArray(raw.interactionTargets) ? raw.interactionTargets : []).flatMap((item) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' ||
        (item.action !== 'search' && item.action !== 'expand') || typeof item.label !== 'string') return []
      const id = item.id
      if (!/^[se][1-9][0-9]{0,2}$/u.test(id)) return []
      const label = pageMetadataValue(item.label, 100)
      return label ? [{ id, action: item.action, label } satisfies ResearchBrowserInteractionTarget] : []
    }).slice(0, MAX_INTERACTION_TARGETS)
    return {
      url: sanitizeResearchSourceUrl(currentUrl),
      title: pageMetadataValue(raw.title, 300) ?? currentUrl,
      text,
      links,
      interactionTargets,
      ...(this.navigationTimedOutUrl === currentUrl ? { navigationTimedOut: true } : {}),
      ...(accessState ? { accessState } : {}),
      ...(declaredAuthor ? { declaredAuthor } : {}),
      ...(declaredPublishedAt ? { declaredPublishedAt } : {})
    }
  }

  /** 页面载入后仅在本机检查短文本，及时显示登录/验证门槛，不保存或发送正文。 */
  private async detectPageAccessState(url: string): Promise<void> {
    try {
      const text = await this.view.webContents.executeJavaScriptInIsolatedWorld(RESEARCH_SCRIPT_WORLD, [
        { code: 'document.body ? document.body.innerText.slice(0, 800) : ""' }
      ]) as string
      if (this.view.webContents.isDestroyed() || this.view.webContents.isLoading() || this.view.webContents.getURL() !== url) return
      const accessState = classifyResearchPageAccess(typeof text === 'string' ? text : '')
      if (this.state.url !== url || this.state.loading || this.state.accessState === accessState) return
      this.updateState({ ...this.state, accessState })
    } catch {
      // 页面关闭或重载时无需通知；显式快照读取仍会返回具体错误。
    }
  }

  /** 将网页矩形限制在主窗口范围内，避免覆盖窗口之外的内容。 */
  private validateBounds(input: BrowserBounds): Electron.Rectangle {
    const values = [input.x, input.y, input.width, input.height]
    if (values.some((value) => !Number.isFinite(value))) return { x: 0, y: 0, width: 0, height: 0 }
    if (!input.visible || input.width < 2 || input.height < 2) return { x: 0, y: 0, width: 0, height: 0 }
    const { width, height } = this.window.getContentBounds()
    const x = Math.max(0, Math.min(Math.round(input.x), width))
    const y = Math.max(0, Math.min(Math.round(input.y), height))
    return {
      x,
      y,
      width: Math.max(0, Math.min(Math.round(input.width), width - x)),
      height: Math.max(0, Math.min(Math.round(input.height), height - y))
    }
  }

  /** 在一次状态变化后通知 renderer，避免调用者读取 Electron 内部对象。 */
  private updateState(next: Partial<BrowserState>): void {
    const history = this.view.webContents.navigationHistory
    this.state = {
      ...this.state,
      ...next,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward()
    }
    this.onStateChange(this.state)
  }
}

/** 去掉页面 URL 中的访问令牌和片段，避免来源或模型上下文泄露凭证。 */
function safePageUrl(input: string): string {
  return sanitizeResearchUrl(input)
}

/** 在浏览器操作开始前检查取消信号，并保留调用者的取消原因。 */
function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

/** 生成可被现有 Agent 取消流程识别的错误。 */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('网页操作已取消。')
}

/** 限制页面自报元数据长度与控制字符，避免污染来源卡和模型上下文。 */
function pageMetadataValue(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
  return normalized || undefined
}
