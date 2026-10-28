const { mkdirSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')

// Inspect the real renderer at both supported desktop sizes using fixture data.
// The environment variable keeps screenshot work out of ordinary flow checks.
module.exports = async function captureUi(window, prefix, name, options = {}) {
  if (!prefix) return
  mkdirSync(dirname(prefix), { recursive: true })
  const original = window.getBounds()
  const scrollTargets = '.projects-page, .project-board-page, .catalog-page, .node-chat, .node-scroll, .graph-details'
  const scrollPositions = await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll(${JSON.stringify(scrollTargets)}), el => el.scrollTop)`,
  )
  const evidence = []
  try {
    for (const [viewport, width, height] of [
      ['desktop', 1440, 800],
      ['narrow', 1000, 740],
    ]) {
      window.setContentSize(width, height)
      await window.webContents.executeJavaScript(
        `document.querySelectorAll(${JSON.stringify(scrollTargets)}).forEach(el => { el.scrollTop = 0 })`,
      )
      if (options.focus) {
        await window.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify(options.focus)})?.focus({ preventScroll: true })`,
        )
      }
      await window.webContents.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      )
      const metrics = await window.webContents.executeJavaScript(`(() => {
        const dialog = document.querySelector('dialog[open]')
        const scope = dialog ?? document
        const targets = Array.from(scope.querySelectorAll('.page-heading, .heading-actions, .graph-heading, .graph-actions, .workflow-controls, .board-toolbar, .project-card, .node-tabs, .node-worktree-path, .manager-panel, .manager-send-row'))
        const overflowing = targets.filter(el => {
          const box = el.getBoundingClientRect()
          return box.width && box.height && (box.left < -1 || box.right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1)
        }).map(el => ({selector: el.className, width: el.clientWidth, scrollWidth: el.scrollWidth}))
        const rgb = value => (value.match(/[\\d.]+/g) ?? []).slice(0, 3).map(Number)
        const luminance = value => rgb(value).map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 }).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0)
        const contrast = []
        for (const el of scope.querySelectorAll('h1, h2, h3, p, label, button, a, small, dt, dd, .column-caption, .project-completion, .project-card-path, .graph-back, .workflow-node-state')) {
          const style = getComputedStyle(el), box = el.getBoundingClientRect()
          if (!box.width || !box.height || box.bottom < 0 || box.top > innerHeight || style.visibility === 'hidden' || el.closest('[disabled], [aria-hidden="true"]') || !el.textContent.trim()) continue
          let parent = el, background
          while (parent) {
            const color = getComputedStyle(parent).backgroundColor
            if (!color.endsWith(', 0)') && color !== 'transparent') { background = color; break }
            parent = parent.parentElement
          }
          if (!background) continue
          const a = luminance(style.color), b = luminance(background)
          const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
          const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && parseFloat(style.fontWeight) >= 700)
          if (ratio < (large ? 3 : 4.5)) contrast.push({selector: el.className || el.tagName, text: el.textContent.trim().slice(0, 70), ratio: Number(ratio.toFixed(2)), color: style.color, background})
        }
        return {width: innerWidth, height: innerHeight, documentOverflow: document.documentElement.scrollWidth > innerWidth, overflowing, contrast}
      })()`)
      const path = `${prefix}.${name}.${viewport}.png`
      writeFileSync(path, (await window.webContents.capturePage()).toPNG())
      evidence.push({ viewport, path, ...metrics })
    }
    writeFileSync(`${prefix}.${name}.json`, `${JSON.stringify(evidence, null, 2)}\n`)
  } finally {
    window.setBounds(original)
    await window.webContents.executeJavaScript(
      `document.querySelectorAll(${JSON.stringify(scrollTargets)}).forEach((el, index) => { el.scrollTop = ${JSON.stringify(scrollPositions)}[index] ?? 0 })`,
    )
  }
}
