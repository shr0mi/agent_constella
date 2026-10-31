import { useEffect, useRef } from 'react'

type Star = {
  x: number
  y: number
  r: number
  a: number
  tw: number
  sp: number
  vx: number
  vy: number
  color: string
}

const COLORS = ['#ddd6fe', '#c4b5fd', '#a855f7', '#7c3aed']

export function InteractiveConstellation() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    let stars: Star[] = []
    let frame = 0
    let raf = 0
    const pointer = { x: -9999, y: -9999, on: false }

    const resize = () => {
      const rect = parent.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = rect.width
      height = rect.height
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.round((width * height) / 9000)
      stars = Array.from({ length: Math.max(80, Math.min(count, 220)) }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.1 + 0.55,
        a: Math.random() * 0.18 + 0.38,
        tw: Math.random() * Math.PI * 2,
        sp: Math.random() * 0.012 + 0.004,
        vx: (Math.random() - 0.5) * 0.07,
        vy: (Math.random() - 0.5) * 0.07,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      }))
    }

    const onMove = (event: PointerEvent) => {
      const rect = parent.getBoundingClientRect()
      pointer.x = event.clientX - rect.left
      pointer.y = event.clientY - rect.top
      pointer.on = true
    }
    const onLeave = () => {
      pointer.on = false
    }

    const draw = () => {
      frame += 1
      ctx.clearRect(0, 0, width, height)
      for (const star of stars) {
        star.x += star.vx
        star.y += star.vy
        if (star.x < 0) star.x = width
        if (star.x > width) star.x = 0
        if (star.y < 0) star.y = height
        if (star.y > height) star.y = 0
        const glow = star.a * (0.7 + 0.3 * Math.sin(frame * star.sp + star.tw))
        ctx.beginPath()
        ctx.fillStyle = star.color
        ctx.globalAlpha = glow
        ctx.shadowColor = star.color
        ctx.shadowBlur = 4
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }
      if (pointer.on) {
        for (const star of stars) {
          const dx = star.x - pointer.x
          const dy = star.y - pointer.y
          const dist = Math.hypot(dx, dy)
          if (dist > 150) continue
          ctx.beginPath()
          ctx.strokeStyle = dist < 72 ? '#a855f7' : '#c4b5fd'
          ctx.globalAlpha = (1 - dist / 150) * 0.35
          ctx.lineWidth = 0.6
          ctx.moveTo(pointer.x, pointer.y)
          ctx.lineTo(star.x, star.y)
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(draw)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(parent)
    resize()
    parent.addEventListener('pointermove', onMove)
    parent.addEventListener('pointerleave', onLeave)
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      parent.removeEventListener('pointermove', onMove)
      parent.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return <canvas ref={ref} className="blueprint-field" aria-hidden="true" />
}
