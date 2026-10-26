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
    'catalog',
    'diagnose',
    'execution',
    'getState',
    'graphs',
    'manager',
    'newSession',
    'onState',
    'run',
    'stop',
    'workflow',
    'workspace',
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
  await bridge.workspace.getSnapshot()
  expect(invoke).toHaveBeenLastCalledWith('constella:workspace:snapshot')
  await bridge.workspace.chooseNewProject()
  expect(invoke).toHaveBeenLastCalledWith(
    'constella:workspace:choose-new-project',
  )
  const workspaceCallback = vi.fn()
  const removeWorkspaceListener = bridge.workspace.onChange(workspaceCallback)
  const [workspaceChannel, workspaceListener] = on.mock.calls[1]
  const snapshot = { revision: 1, projects: [], tasks: [] }
  workspaceListener({ sender: 'must stay in preload' }, snapshot)
  expect(workspaceCallback).toHaveBeenCalledExactlyOnceWith(snapshot)
  removeWorkspaceListener()
  expect(removeListener).toHaveBeenCalledWith(
    workspaceChannel,
    workspaceListener,
  )
  await bridge.catalog.getSnapshot({ projectId: null })
  expect(invoke).toHaveBeenLastCalledWith('constella:catalog:snapshot', {
    projectId: null,
  })
  const catalogCallback = vi.fn()
  const removeCatalogListener = bridge.catalog.onChange(catalogCallback)
  const [catalogChannel, catalogListener] = on.mock.calls[2]
  catalogListener({ sender: 'must stay in preload' })
  expect(catalogCallback).toHaveBeenCalledExactlyOnceWith()
  removeCatalogListener()
  expect(removeListener).toHaveBeenCalledWith(catalogChannel, catalogListener)
  const graphIdentity = { projectId: 'project', taskId: 'task' }
  await bridge.graphs.get(graphIdentity)
  expect(invoke).toHaveBeenLastCalledWith('constella:graph:get', graphIdentity)
  const graphCallback = vi.fn()
  const removeGraphListener = bridge.graphs.onChange(graphCallback)
  const [graphChannel, graphListener] = on.mock.calls[3]
  graphListener({ sender: 'must stay in preload' }, graphIdentity)
  expect(graphCallback).toHaveBeenCalledExactlyOnceWith(graphIdentity)
  removeGraphListener()
  expect(removeListener).toHaveBeenCalledWith(graphChannel, graphListener)
  await bridge.execution.getTask(graphIdentity)
  expect(invoke).toHaveBeenLastCalledWith('constella:node:task', graphIdentity)
  await bridge.execution.getReview(graphIdentity)
  expect(invoke).toHaveBeenLastCalledWith(
    'constella:task:review',
    graphIdentity,
  )
  await bridge.execution.openWorktree(graphIdentity)
  expect(invoke).toHaveBeenLastCalledWith(
    'constella:task:open-worktree',
    graphIdentity,
  )
  const nodeIdentity = { ...graphIdentity, nodeId: 'node' }
  await bridge.execution.get(nodeIdentity)
  expect(invoke).toHaveBeenLastCalledWith('constella:node:get', nodeIdentity)
  const executionCallback = vi.fn()
  const removeExecutionListener = bridge.execution.onChange(executionCallback)
  const [executionChannel, executionListener] = on.mock.calls[4]
  executionListener({ sender: 'must stay in preload' }, graphIdentity)
  expect(executionCallback).toHaveBeenCalledExactlyOnceWith(graphIdentity)
  removeExecutionListener()
  expect(removeListener).toHaveBeenCalledWith(
    executionChannel,
    executionListener,
  )
  await bridge.workflow.get(graphIdentity)
  expect(invoke).toHaveBeenLastCalledWith(
    'constella:workflow:get',
    graphIdentity,
  )
  const workflowCallback = vi.fn()
  const removeWorkflowListener = bridge.workflow.onChange(workflowCallback)
  const [workflowChannel, workflowListener] = on.mock.calls[5]
  workflowListener({ sender: 'must stay in preload' }, graphIdentity)
  expect(workflowCallback).toHaveBeenCalledExactlyOnceWith(graphIdentity)
  removeWorkflowListener()
  expect(removeListener).toHaveBeenCalledWith(workflowChannel, workflowListener)
  const scope = { projectId: 'project', taskId: null }
  const deletion = { projectId: 'project', expectedRevision: 1 }
  await bridge.workspace.deleteProject(deletion)
  expect(invoke).toHaveBeenLastCalledWith(
    'constella:workspace:delete-project',
    deletion,
  )
  await bridge.manager.list(scope)
  expect(invoke).toHaveBeenLastCalledWith('constella:manager:list', scope)
  const fresh = { ...scope, expectedChatId: 'old-chat' }
  await bridge.manager.newChat(fresh)
  expect(invoke).toHaveBeenLastCalledWith('constella:manager:new-chat', fresh)
  const selection = { ...fresh, chatId: 'saved-chat' }
  await bridge.manager.selectChat(selection)
  expect(invoke).toHaveBeenLastCalledWith(
    'constella:manager:select-chat',
    selection,
  )
})
