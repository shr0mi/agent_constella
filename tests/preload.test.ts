import { runInNewContext } from 'node:vm'
import { PreloadConfigFactory } from 'electron-vite'
import { build } from 'vite'
import { expect, it, vi } from 'vitest'
import config from '../electron.vite.config'
import type { ConstellaBridge } from '../src/shared/contracts'

it('loads the built preload with only the modules available in Electron’s sandbox', async () => {
  const preloadConfig = await new PreloadConfigFactory(
    config.preload!,
    { configFile: false, logLevel: 'silent' },
    { root: process.cwd() },
  ).build()
  const output = await build({
    ...preloadConfig,
    configFile: false,
    logLevel: 'silent',
    build: { ...preloadConfig.build, write: false },
  })
  const bundle = Array.isArray(output) ? output[0] : output
  if (!('output' in bundle)) throw new Error('Expected a preload bundle')
  const entry = bundle.output.find(
    (chunk) => chunk.type === 'chunk' && chunk.isEntry,
  )
  if (!entry || entry.type !== 'chunk') throw new Error('Missing preload entry')

  const exposeInMainWorld = vi.fn()
  const invoke = vi.fn().mockResolvedValue({ ok: true })
  const on = vi.fn()
  const removeListener = vi.fn()
  runInNewContext(entry.code, {
    require(name: string) {
      if (name !== 'electron') throw new Error(`Sandbox cannot load ${name}`)
      return {
        contextBridge: { exposeInMainWorld },
        ipcRenderer: { invoke, on, removeListener },
      }
    },
  })

  expect(exposeInMainWorld).toHaveBeenCalledOnce()
  const [name, bridge] = exposeInMainWorld.mock.calls[0] as [
    string,
    ConstellaBridge,
  ]
  expect(name).toBe('constella')
  expect(Object.keys(bridge).sort()).toEqual([
    'diagnose',
    'getState',
    'newSession',
    'onState',
    'run',
    'stop',
  ])
  await bridge.getState()
  expect(invoke).toHaveBeenLastCalledWith('constella:state')
  const callback = vi.fn()
  const unsubscribe = bridge.onState(callback)
  const [channel, listener] = on.mock.calls[0]
  const state = { session: { id: 'example' } }
  listener({ sender: 'must stay in preload' }, state)
  expect(callback).toHaveBeenCalledExactlyOnceWith(state)
  unsubscribe()
  expect(removeListener).toHaveBeenCalledWith(channel, listener)
})
