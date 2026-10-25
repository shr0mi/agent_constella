import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result } from '../../shared/contracts'
import type { ExecutionBridge } from '../../shared/execution'
import type { GraphIdentity } from '../../shared/graph'
import type { WorkflowBridge } from '../../shared/workflow'
import { unwrap, useAppStore } from './store'

export async function executionAction<T>(
  action: (api: ExecutionBridge) => Promise<Result<T>>,
): Promise<T> {
  const api = window.constella?.execution
  if (!api)
    throw new Error(
      'The execution bridge is unavailable. Quit Electron and restart npm run dev.',
    )
  return unwrap(action(api))
}
export async function workflowAction<T>(
  action: (api: WorkflowBridge) => Promise<Result<T>>,
): Promise<T> {
  const api = window.constella?.workflow
  if (!api)
    throw new Error(
      'The workflow bridge is unavailable. Quit Electron and restart npm run dev.',
    )
  return unwrap(action(api))
}
export function useExecutionSnapshot<T>(
  identity: GraphIdentity,
  read: (api: ExecutionBridge) => Promise<Result<T>>,
  key: string,
) {
  const [snapshot, setSnapshot] = useState<T>()
  const [loading, setLoading] = useState(true)
  const sequence = useRef(0),
    readRef = useRef(read)
  readRef.current = read
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    try {
      const next = await executionAction((api) => readRef.current(api))
      if (sequence.current === request) setSnapshot(next)
    } catch (error) {
      if (!useAppStore.getState().error)
        useAppStore.getState().setError({
          code: 'NODE_EXECUTION',
          message: String(error),
          hint: 'Reload the saved graph and restart Electron if the bridge is outdated.',
        })
    } finally {
      if (sequence.current === request) setLoading(false)
    }
  }, [key])
  useEffect(() => {
    setSnapshot(undefined)
    setLoading(true)
    void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const changedHandler = (changed: GraphIdentity) => {
      // Project activity also blocks starts in other tasks in the same project.
      if (changed.projectId !== identity.projectId || timer) return
      timer = setTimeout(() => {
        timer = undefined
        void refresh()
      }, 100)
    }
    const unsubscribe = window.constella?.execution?.onChange(changedHandler)
    const unsubscribeWorkflow =
      window.constella?.workflow?.onChange(changedHandler)
    return () => {
      sequence.current++
      unsubscribe?.()
      unsubscribeWorkflow?.()
      if (timer) clearTimeout(timer)
    }
  }, [identity.projectId, key, refresh])
  return { snapshot, loading, refresh }
}
