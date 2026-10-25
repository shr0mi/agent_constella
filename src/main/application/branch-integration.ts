import type { Project } from '../../shared/workspace'
import type { CodeSnapshot, TaskWorktree } from '../../shared/execution'
import type { IntegrationPlan } from '../../shared/workflow'
import { taskGit, type TaskWorktreeService } from './task-worktrees'
import { ApplicationError } from './errors'

export class BranchIntegrationService {
  constructor(private readonly worktrees: TaskWorktreeService) {}
  async preview(
    project: Project,
    worktree: TaskWorktree,
    accepted: CodeSnapshot,
    workflowRevision: number,
  ): Promise<IntegrationPlan> {
    const plan: IntegrationPlan = {
      status: 'blocked',
      workflowRevision,
      targetBranch: null,
      targetHead: null,
      resultCommit: accepted.commit,
      conflicts: [],
      message: '',
      checkedAt: new Date().toISOString(),
    }
    await this.worktrees.verify(worktree, project.repoPath)
    plan.targetBranch = await taskGit(project.repoPath, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ])
      .then((value) => value.trim())
      .catch(() => null)
    plan.targetHead = await taskGit(project.repoPath, [
      'rev-parse',
      '--verify',
      'HEAD',
    ])
      .then((value) => value.trim())
      .catch(() => null)
    if (!plan.targetBranch || plan.targetBranch === worktree.branch) {
      plan.message =
        'Check out the project branch in the primary project folder before integrating.'
      return plan
    }
    const current = await this.worktrees.capture(
      worktree.path,
      'AgentConstella integration inspection',
    )
    const tree = async (commit: string) =>
      (await taskGit(worktree.path, ['rev-parse', `${commit}^{tree}`])).trim()
    if ((await tree(current.commit)) !== (await tree(accepted.commit))) {
      plan.message =
        'The task worktree changed after the accepted result. Run and accept a revision before integrating those changes.'
      return plan
    }
    if (
      (await taskGit(project.repoPath, ['status', '--porcelain=v1', '-z']))
        .length
    ) {
      plan.message =
        'The project checkout has uncommitted or untracked files. Commit or move those local changes, then preview integration again. No files were changed.'
      return plan
    }
    const inProgress = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
    for (const ref of inProgress)
      if (
        await taskGit(project.repoPath, ['rev-parse', '--verify', ref])
          .then(() => true)
          .catch(() => false)
      ) {
        plan.message =
          'Finish the existing Git operation in the project checkout before integrating.'
        return plan
      }
    if (!plan.targetHead) {
      plan.status = 'ready'
      plan.mergedTree = await tree(accepted.commit)
      plan.message = `Ready to create the initial commit history on ${plan.targetBranch}.`
      return plan
    }
    if (
      await taskGit(project.repoPath, [
        'merge-base',
        '--is-ancestor',
        accepted.commit,
        plan.targetHead,
      ])
        .then(() => true)
        .catch(() => false)
    ) {
      plan.status = 'integrated'
      plan.commit = plan.targetHead
      plan.message = `The accepted task snapshot is already in ${plan.targetBranch}.`
      return plan
    }
    let output: string,
      conflict = false
    try {
      output = await taskGit(project.repoPath, [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        '-z',
        plan.targetHead,
        accepted.commit,
      ])
    } catch (error) {
      if ((error as { code?: number }).code !== 1)
        throw new ApplicationError(
          'INTEGRATION_PREVIEW',
          error instanceof Error ? error.message : String(error),
          'Check Git support for merge-tree --write-tree (Git 2.38+) and the repository history. The project checkout was not modified.',
        )
      conflict = true
      output = String((error as { stdout?: string }).stdout ?? '')
    }
    const fields = output.split('\0'),
      mergedTree = fields.shift()?.trim()
    if (!mergedTree || !/^[a-f0-9]{40,64}$/.test(mergedTree))
      throw new ApplicationError(
        'INTEGRATION_PREVIEW',
        'Git did not return a valid merge tree.',
        'The project checkout is unchanged. Inspect Git and retry the preview.',
      )
    plan.mergedTree = mergedTree
    if (conflict) {
      plan.status = 'conflicts'
      plan.conflicts = fields.filter(Boolean)
      plan.message =
        'Git found conflicts. The project checkout is unchanged; resolve the divergence and preview again.'
    } else {
      plan.status = 'ready'
      plan.message = `Ready to integrate the accepted task result into ${plan.targetBranch}.`
    }
    return plan
  }
  async apply(
    project: Project,
    worktree: TaskWorktree,
    accepted: CodeSnapshot,
    expected: { targetBranch: string; targetHead: string | null },
    revision: number,
    guard: () => void = () => {},
  ): Promise<IntegrationPlan> {
    const plan = await this.preview(project, worktree, accepted, revision)
    if (plan.status !== 'ready') return plan
    if (
      plan.targetBranch !== expected.targetBranch ||
      plan.targetHead !== expected.targetHead
    )
      throw new ApplicationError(
        'INTEGRATION_CHANGED',
        'The project branch or commit changed after the preview.',
        'Preview the current project state before integrating. No project files were changed.',
      )
    const taskHead = (
      await taskGit(worktree.path, ['rev-parse', 'HEAD'])
    ).trim()
    guard()
    // Promote the accepted immutable snapshot to the app-owned task branch. Its
    // working files already match the snapshot; read-tree only aligns its index.
    await taskGit(worktree.path, [
      'update-ref',
      `refs/heads/${worktree.branch}`,
      accepted.commit,
      taskHead,
    ])
    await taskGit(worktree.path, ['read-tree', accepted.commit])
    const commit = plan.targetHead
      ? (
          await taskGit(project.repoPath, [
            'commit-tree',
            plan.mergedTree!,
            '-p',
            plan.targetHead,
            '-p',
            accepted.commit,
            '-m',
            `Integrate AgentConstella task ${worktree.taskId}`,
          ])
        ).trim()
      : accepted.commit
    if (
      (
        await taskGit(project.repoPath, ['symbolic-ref', '--short', 'HEAD'])
      ).trim() !== expected.targetBranch ||
      (await taskGit(project.repoPath, ['rev-parse', '--verify', 'HEAD'])
        .then((value) => value.trim())
        .catch(() => null)) !== expected.targetHead ||
      (await taskGit(project.repoPath, ['status', '--porcelain=v1', '-z']))
        .length
    )
      throw new ApplicationError(
        'INTEGRATION_CHANGED',
        'The project checkout changed during integration preparation.',
        'Preview again. Task code was committed to its own branch; project files were not reset or overwritten.',
      )
    guard()
    await taskGit(project.repoPath, ['merge', '--ff-only', '--no-edit', commit])
    plan.status = 'integrated'
    plan.commit = commit
    plan.message = `Integrated into ${plan.targetBranch}. The task worktree and branch are retained.`
    plan.checkedAt = new Date().toISOString()
    return plan
  }
}
