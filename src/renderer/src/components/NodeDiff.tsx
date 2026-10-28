import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import type { FileDiff } from '../../../shared/execution'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

export default function NodeDiff({ diff }: { diff: FileDiff }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!container.current || diff.binary || diff.unavailable) return
    const editor = monaco.editor.createDiffEditor(container.current, {
      theme: 'vs',
      readOnly: true,
      originalEditable: false,
      domReadOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
    })
    const original = monaco.editor.createModel(diff.original, 'plaintext')
    const modified = monaco.editor.createModel(diff.modified, 'plaintext')
    editor.setModel({ original, modified })
    return () => {
      // Detach the models before disposal; newer Monaco versions enforce this.
      editor.setModel(null)
      editor.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [diff])
  if (diff.unavailable || diff.binary)
    return (
      <div className="node-empty">
        <p>
          {diff.unavailable ??
            'Binary file changed. Text preview is unavailable; the original bytes are preserved in the Git snapshots.'}
        </p>
      </div>
    )
  return (
    <div
      ref={container}
      className="node-monaco-diff"
      aria-label={`Recorded diff for ${diff.path}`}
    />
  )
}
