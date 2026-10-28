import type { Project } from '../../shared/workspace'
import type { CodeSnapshot, TaskWorktree } from '../../shared/execution'
import type { IntegrationPlan } from '../../shared/workflow'
import { taskGit, type TaskWorktreeService } from './task-worktrees'
import { ApplicationError } from './errors'

export class BranchIntegrationService {
  constructor(private readonly worktrees: TaskWorktreeService) {}
  private async ref(path: string, branch: string) {
    return taskGit(path, ['rev-parse', '--verify', `refs/heads/${branch}`])
      .then((value) => value.trim())
      .catch(() => null)
  }
  private async selected(path: string) {
    return taskGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      .then((value) => value.trim())
      .catch(() => null)
  }
  async preview(
    project: Project,
    worktree: TaskWorktree,
    accepted: CodeSnapshot,
    workflowRevision: number,
  ): Promise<IntegrationPlan> {
    const path = project.repoPath
    const plan: IntegrationPlan = {
      status: 'blocked',
      workflowRevision,
      targetBranch: worktree.sourceBranch,
      targetHead: null,
      resultCommit: accepted.commit,
      conflicts: [],
      message: '',
      checkedAt: new Date().toISOString(),
    }
    await this.worktrees.verify(worktree, path, false)
    await this.worktrees.assertClean(worktree.path)
    if (!plan.targetBranch || plan.targetBranch === worktree.branch) {
      plan.message =
        'The original integration branch is unavailable. Restore the task’s base branch before integrating.'
      return plan
    }
    plan.targetHead = await this.ref(path, plan.targetBranch)
    const taskHead = await this.ref(path, worktree.branch)
    if (!plan.targetHead || !taskHead) {
      plan.message =
        'A saved project or task branch is missing. Restore it before integrating.'
      return plan
    }
    const tree = async (commit: string) =>
      (await taskGit(path, ['rev-parse', `${commit}^{tree}`])).trim()
    if ((await tree(taskHead)) !== (await tree(accepted.commit))) {
      plan.message =
        'The task branch changed after the accepted result. Run and accept a revision before integrating those changes.'
      return plan
    }
    try {
      await this.worktrees.assertClean(path)
    } catch (error) {
      plan.message = error instanceof Error ? error.message : String(error)
      return plan
    }
    if (!(await this.selected(path))) {
      plan.message =
        'The project is in a detached checkout. Select a branch before integrating.'
      return plan
    }
    // A migrated legacy branch can have a different commit with the exact
    // accepted tree. Merge that saved branch head without rewriting its history.
    plan.resultCommit = taskHead
    if (
      await taskGit(path, [
        'merge-base',
        '--is-ancestor',
        taskHead,
        plan.targetHead,
      ])
        .then(() => true)
        .catch(() => false)
    ) {
      plan.status = 'integrated'
      plan.commit = plan.targetHead
      plan.message = `The accepted task result is already in ${plan.targetBranch}.`
      return plan
    }
    let output: string,
      conflict = false
    try {
      output = await taskGit(path, [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        '-z',
        plan.targetHead,
        taskHead,
      ])
    } catch (error) {
      if ((error as { code?: number }).code !== 1)
        throw new ApplicationError(
          'INTEGRATION_PREVIEW',
          error instanceof Error ? error.message : String(error),
          'Check Git support for merge-tree --write-tree (Git 2.38+) and the repository history. Project files were not modified.',
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
        'Project files are unchanged. Inspect Git and retry the preview.',
      )
    plan.mergedTree = mergedTree
    plan.status = conflict ? 'conflicts' : 'ready'
    plan.conflicts = conflict ? fields.filter(Boolean) : []
    plan.message = conflict
      ? 'Git found conflicts. Project files are unchanged; resolve the divergence and preview again.'
      : `Ready to integrate the accepted task result into ${plan.targetBranch}.`
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
    if (
      plan.targetBranch !== expected.targetBranch ||
      plan.targetHead !== expected.targetHead
    )
      throw new ApplicationError(
        'INTEGRATION_CHANGED',
        'The project branch or commit changed after the preview.',
        'Preview the current project state before integrating. No project files were changed.',
      )
    if (plan.status !== 'ready') return plan
    const path = project.repoPath,
      selected = await this.selected(path)
    const commit = (
      await taskGit(path, [
        'commit-tree',
        plan.mergedTree!,
        '-p',
        plan.targetHead!,
        '-p',
        plan.resultCommit!,
        '-m',
        `Integrate ${worktree.branch}`,
      ])
    ).trim()
    guard()
    await this.worktrees.assertClean(path)
    if (
      (await this.selected(path)) !== selected ||
      (await this.ref(path, plan.targetBranch!)) !== plan.targetHead ||
      (await this.ref(path, worktree.branch)) !== plan.resultCommit
    )
      throw new ApplicationError(
        'INTEGRATION_CHANGED',
        'The project checkout or a branch changed during integration preparation.',
        'Preview again. Your commits and local files are preserved.',
      )
    await taskGit(path, ['switch', plan.targetBranch!])
    guard()
    if ((await taskGit(path, ['rev-parse', 'HEAD'])).trim() !== plan.targetHead)
      throw new ApplicationError(
        'INTEGRATION_CHANGED',
        'The integration branch moved while switching to it.',
        'Preview again before integrating.',
      )
    await taskGit(path, ['merge', '--ff-only', '--no-edit', commit])
    plan.status = 'integrated'
    plan.commit = commit
    plan.message = `Integrated into ${plan.targetBranch}. The project directory is now on ${plan.targetBranch}; the task branch is retained.`
    plan.checkedAt = new Date().toISOString()
    return plan
  }
}
