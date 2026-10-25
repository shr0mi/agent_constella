import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { CatalogBridge, CatalogSnapshot } from '../../shared/catalog'
import type { Result } from '../../shared/contracts'
import { unwrap, useAppStore } from './store'

export const useCatalogStore = create<{ pending: number }>(() => ({
  pending: 0,
}))
export async function catalogAction<T>(
  action: (api: CatalogBridge) => Promise<Result<T>>,
): Promise<T> {
  useCatalogStore.setState((state) => ({ pending: state.pending + 1 }))
  useAppStore.getState().setError(undefined)
  try {
    const api = window.constella?.catalog
    if (!api)
      throw new Error(
        'The catalog bridge is unavailable. Quit and restart the desktop app with npm run dev.',
      )
    return await unwrap(action(api))
  } catch (error) {
    if (!useAppStore.getState().error)
      useAppStore
        .getState()
        .setError({
          code: 'CATALOG',
          message: error instanceof Error ? error.message : String(error),
          hint: 'Reload the catalog and check the selected scope.',
        })
    throw error
  } finally {
    useCatalogStore.setState((state) => ({ pending: state.pending - 1 }))
  }
}

export function useCatalog(projectId: string | null) {
  const [snapshot, setSnapshot] = useState<CatalogSnapshot>()
  const [loading, setLoading] = useState(true)
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    try {
      const next = await catalogAction((api) => api.getSnapshot({ projectId }))
      if (sequence.current === request)
        setSnapshot((current) =>
          current?.projectId === next.projectId &&
          current.revision > next.revision
            ? current
            : next,
        )
    } catch {
      /* Shared error notice includes catalog load failures. */
    } finally {
      if (sequence.current === request) setLoading(false)
    }
  }, [projectId])
  useEffect(() => {
    void refresh()
    const unsubscribe = window.constella?.catalog?.onChange(() => {
      void refresh()
    })
    return () => {
      sequence.current++
      unsubscribe?.()
    }
  }, [refresh])
  return {
    snapshot: snapshot?.projectId === projectId ? snapshot : undefined,
    loading,
    refresh,
  }
}
