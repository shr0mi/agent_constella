import type { AgentProfile, CatalogSnapshot } from './catalog'
import type { ModelOption } from './contracts'
import type {
  GraphDocument,
  GraphIssue,
  GraphValidation,
  WorkflowNode,
} from './graph'

export function validateTopology(document: GraphDocument): GraphValidation {
  const issues: GraphIssue[] = []
  const nodes = new Map(document.nodes.map((node) => [node.id, node]))
  if (nodes.size !== document.nodes.length)
    issues.push({
      code: 'DUPLICATE_NODE',
      message: 'Node IDs must be unique.',
      blocksSave: true,
    })
  const edges = new Set<string>()
  const pairs = new Set<string>()
  const incoming = new Map([...nodes.keys()].map((id) => [id, [] as string[]]))
  const outgoing = new Map([...nodes.keys()].map((id) => [id, [] as string[]]))
  for (const edge of document.edges) {
    if (edges.has(edge.id) || pairs.has(`${edge.source}:${edge.target}`))
      issues.push({
        code: 'DUPLICATE_EDGE',
        message: 'Each connection must be unique.',
        edgeId: edge.id,
        blocksSave: true,
      })
    edges.add(edge.id)
    pairs.add(`${edge.source}:${edge.target}`)
    const source = nodes.get(edge.source),
      target = nodes.get(edge.target)
    if (!source || !target) {
      issues.push({
        code: 'EDGE_REFERENCE',
        message: 'A connection points to a missing node.',
        edgeId: edge.id,
        blocksSave: true,
      })
      continue
    }
    if (source.type === 'end' || target.type === 'start')
      issues.push({
        code: 'EDGE_DIRECTION',
        message:
          'Start cannot have incoming connections and End cannot have outgoing connections.',
        edgeId: edge.id,
        blocksSave: true,
      })
    outgoing.get(edge.source)!.push(edge.target)
    incoming.get(edge.target)!.push(edge.source)
  }
  const degree = new Map(
    [...incoming].map(([id, parents]) => [id, parents.length]),
  )
  const queue = [...degree].filter(([, value]) => value === 0).map(([id]) => id)
  const order: string[] = []
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]
    order.push(id)
    for (const child of outgoing.get(id)!) {
      degree.set(child, degree.get(child)! - 1)
      if (degree.get(child) === 0) queue.push(child)
    }
  }
  if (order.length !== nodes.size)
    issues.push({
      code: 'CYCLE',
      message:
        'The graph contains a cycle. Connections must flow forward without loops.',
      blocksSave: true,
    })
  const starts = document.nodes.filter((node) => node.type === 'start'),
    ends = document.nodes.filter((node) => node.type === 'end')
  if (starts.length !== 1)
    issues.push({
      code: 'START_COUNT',
      message: 'The graph needs exactly one Start node.',
      blocksSave: starts.length > 1,
    })
  if (ends.length !== 1)
    issues.push({
      code: 'END_COUNT',
      message: 'The graph needs exactly one End node.',
      blocksSave: ends.length > 1,
    })
  function reachable(id: string, adjacency: Map<string, string[]>) {
    const found = new Set<string>(),
      pending = [id]
    while (pending.length) {
      const current = pending.pop()!
      if (found.has(current)) continue
      found.add(current)
      pending.push(...(adjacency.get(current) ?? []))
    }
    return found
  }
  if (starts.length === 1 && ends.length === 1) {
    const fromStart = reachable(starts[0].id, outgoing),
      toEnd = reachable(ends[0].id, incoming)
    for (const node of document.nodes)
      if (!fromStart.has(node.id) || !toEnd.has(node.id))
        issues.push({
          code: 'DISCONNECTED_NODE',
          message: `${node.data.title || 'Untitled node'} must be on a path from Start to End.`,
          nodeId: node.id,
          blocksSave: false,
        })
  }
  return {
    valid: issues.length === 0,
    canSave: !issues.some((issue) => issue.blocksSave),
    issues,
    topologicalOrder: order,
  }
}

export function resolveNodeModel(
  node: Extract<WorkflowNode, { type: 'agent' }>,
  profile?: AgentProfile,
) {
  const model =
    (node.data.model !== undefined ? node.data.model : profile?.model) ??
    undefined
  const effort =
    (node.data.effort !== undefined
      ? node.data.effort
      : node.data.model === undefined || node.data.model === profile?.model
        ? profile?.effort
        : undefined) ?? undefined
  return { model, effort }
}

export function validateGraph(
  document: GraphDocument,
  context: {
    catalog: CatalogSnapshot
    models: ModelOption[]
    archived?: boolean
  },
): GraphValidation {
  const result = validateTopology(document)
  const issues = [...result.issues]
  if (context.archived)
    issues.push({
      code: 'TASK_ARCHIVED',
      message: 'Restore this task before preparing its graph.',
      blocksSave: false,
    })
  for (const node of document.nodes) {
    const issue = (code: string, message: string, blocksSave = true) =>
      issues.push({ code, message, nodeId: node.id, blocksSave })
    if (!node.data.title.trim())
      issue('NODE_TITLE', 'Give this node a title.', false)
    if (node.type !== 'agent') continue
    if (!node.data.prompt.trim())
      issue(
        'AGENT_PROMPT',
        `${node.data.title || 'Agent task'} needs an initial prompt.`,
        false,
      )
    const profile = context.catalog.profiles.find(
      (profile) => profile.id === node.data.profileId,
    )
    // Null explicitly selects the built-in Default Codex behavior. A supplied
    // catalog ID must still resolve to an active profile in this project.
    if (
      node.data.profileId &&
      (!profile ||
        profile.removedAt ||
        (profile.projectId !== null &&
          profile.projectId !== context.catalog.projectId))
    )
      issue(
        'PROFILE_ASSIGNMENT',
        'The assigned profile is removed, missing, or belongs to another project.',
      )
    const skillIds = [
      ...new Set([...(profile?.skillIds ?? []), ...node.data.skillIds]),
    ]
    if (skillIds.length > 20)
      issue(
        'SKILL_LIMIT',
        'An agent can select at most 20 skills, including its profile skills.',
      )
    for (const id of skillIds) {
      const skill = context.catalog.skills.find((skill) => skill.id === id)
      if (
        !skill ||
        skill.removedAt ||
        (skill.projectId !== null &&
          skill.projectId !== context.catalog.projectId)
      )
        issue(
          'SKILL_ASSIGNMENT',
          'A selected skill is removed, missing, or belongs to another project.',
        )
    }
    if (new Set(node.data.skillIds).size !== node.data.skillIds.length)
      issue('SKILL_DUPLICATE', 'Select each additional skill once.')
    const { model, effort } = resolveNodeModel(node, profile)
    if (!model && effort)
      issue(
        'MODEL_EFFORT',
        'An explicit reasoning effort needs an explicit model.',
      )
    if (model) {
      if (!context.models.length)
        issue(
          'MODEL_CATALOG_UNAVAILABLE',
          'Refresh runtime model options before preparing this graph.',
          false,
        )
      else {
        const option = context.models.find((option) => option.id === model)
        if (!option || (effort && !option.efforts.includes(effort)))
          issue(
            'MODEL_ASSIGNMENT',
            'The assigned model/effort combination is not supported by the current runtime.',
          )
      }
    }
  }
  return {
    ...result,
    issues,
    valid: issues.length === 0,
    canSave: !issues.some((issue) => issue.blocksSave),
  }
}
