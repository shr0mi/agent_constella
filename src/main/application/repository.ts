import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { ApplicationError } from './errors'

const execute = promisify(execFile)

async function git(args: string[]) {
  try {
    return await execute('git', args, {
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...process.env,
        LC_ALL: 'C',
        GIT_DIR: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_WORK_TREE: undefined,
      },
    })
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      (error as NodeJS.ErrnoException).syscall?.startsWith('spawn')
    )
      throw new ApplicationError(
        'GIT_UNAVAILABLE',
        'Git could not be started.',
        'Install Git and make it available to the desktop app, then try again.',
      )
    throw error
  }
}

async function directoryPath(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new ApplicationError(
      'REPOSITORY_PATH',
      'Choose an absolute project folder.',
      'Use Create project or Open folder to choose a local directory.',
    )
  try {
    const directory = await realpath(path)
    if (!(await stat(directory)).isDirectory())
      throw new Error('Not a directory')
    return directory
  } catch {
    throw new ApplicationError(
      'FOLDER_UNAVAILABLE',
      `Cannot access project folder ${path}.`,
      'Choose an existing, accessible folder, or use Create project to make a new one.',
    )
  }
}

async function findRepository(directory: string): Promise<string | null> {
  let bare: string
  try {
    bare = (
      await git(['-C', directory, 'rev-parse', '--is-bare-repository'])
    ).stdout.trim()
  } catch (error) {
    if (error instanceof ApplicationError) throw error
    const stderr = String((error as { stderr?: string }).stderr ?? '')
    if (/not a git repository/i.test(stderr)) {
      const metadata = await lstat(join(directory, '.git')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        },
      )
      if (!metadata) return null
    }
    throw new ApplicationError(
      'REPOSITORY_ACCESS',
      `Git could not inspect ${directory}.`,
      'Check folder permissions and any existing .git metadata. Existing Git data has been preserved.',
    )
  }
  if (bare === 'true')
    throw new ApplicationError(
      'BARE_REPOSITORY',
      'This is a bare Git repository.',
      'Choose a working folder with project files. Bare repositories are not supported.',
    )
  try {
    const { stdout } = await git([
      '-C',
      directory,
      'rev-parse',
      '--show-toplevel',
    ])
    return await realpath(stdout.trim())
  } catch {
    throw new ApplicationError(
      'REPOSITORY_ACCESS',
      `Git could not resolve the project root for ${directory}.`,
      'Check folder access and Git configuration, then try again.',
    )
  }
}

async function initializeRepository(directory: string): Promise<string> {
  try {
    await git(['-C', directory, 'init', '--quiet', '--initial-branch=main'])
    return directory
  } catch (error) {
    if (error instanceof ApplicationError) throw error
    throw new ApplicationError(
      'GIT_INIT_FAILED',
      `Git could not be initialized in ${directory}.`,
      'The folder and its files have been kept. Check write access and your Git installation, then use Open folder to retry.',
    )
  }
}

export async function openProjectFolder(path: string): Promise<string> {
  const directory = await directoryPath(path)
  return (
    (await findRepository(directory)) ?? (await initializeRepository(directory))
  )
}

export async function createProjectFolder(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new ApplicationError(
      'REPOSITORY_PATH',
      'Choose an absolute location for the new project.',
      'Use Create project to choose the folder name and location.',
    )
  // Check Git before creating anything; mkdir is exclusive so files, folders,
  // and symlinks at the destination are never overwritten.
  await git(['--version'])
  try {
    await mkdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new ApplicationError(
        'PROJECT_FOLDER_EXISTS',
        `A file or folder already exists at ${path}.`,
        'Use Open folder to use that directory, or choose another name for the new project.',
      )
    throw new ApplicationError(
      'PROJECT_FOLDER_CREATE',
      `The project folder could not be created at ${path}.`,
      'Choose an existing parent directory where you have write access, then try again.',
    )
  }
  return initializeRepository(await directoryPath(path))
}

export async function resolveRepository(path: string): Promise<string> {
  const directory = await directoryPath(path)
  const repository = await findRepository(directory)
  if (repository) return repository
  throw new ApplicationError(
    'NOT_A_REPOSITORY',
    `Cannot open ${path} as a Git repository.`,
    'Use Open folder to initialize Git in this directory, or Create project to start a new folder.',
  )
}
