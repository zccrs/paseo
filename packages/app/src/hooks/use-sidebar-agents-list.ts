import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useSessionStore } from '@/stores/session-store'
import { getHostRuntimeStore } from '@/runtime/host-runtime'
import { resolveProjectPlacement } from '@/utils/project-placement'
import { deriveSidebarStateBucket, type SidebarStateBucket } from '@/utils/sidebar-agent-state'
import { useSidebarOrderStore } from '@/stores/sidebar-order-store'
import { checkoutStatusQueryKey } from '@/hooks/use-checkout-status-query'

const EMPTY_ORDER: string[] = []
const EMPTY_PROJECTS: SidebarProjectEntry[] = []

interface PaseoWorktreeEntry {
  worktreePath: string
  createdAt: string
  branchName?: string | null
  head?: string | null
}

export interface SidebarWorkspaceEntry {
  workspaceKey: string
  serverId: string
  cwd: string
  branchName: string | null
  createdAt: Date | null
  isMainCheckout: boolean
  isPaseoOwnedWorktree: boolean
  statusBucket: SidebarStateBucket
}

export interface SidebarProjectEntry {
  projectKey: string
  projectName: string
  iconWorkingDir: string
  statusBucket: SidebarStateBucket
  activeCount: number
  totalCount: number
  latestCreatedAt: Date | null
  workspaces: SidebarWorkspaceEntry[]
}

export interface SidebarAgentsListResult {
  projects: SidebarProjectEntry[]
  isLoading: boolean
  isInitialLoad: boolean
  isRevalidating: boolean
  refreshAll: () => void
}

interface MutableWorkspaceEntry {
  workspaceKey: string
  serverId: string
  cwd: string
  branchName: string | null
  createdAt: Date | null
  isMainCheckout: boolean
  isPaseoOwnedWorktree: boolean
  statusBucket: SidebarStateBucket
}

interface MutableProjectEntry {
  projectKey: string
  projectName: string
  iconWorkingDir: string
  statusBucket: SidebarStateBucket
  activeCount: number
  totalCount: number
  latestCreatedAt: Date | null
  repoRoots: Set<string>
  workspacesByKey: Map<string, MutableWorkspaceEntry>
}

interface WorktreeRequest {
  requestKey: string
  serverId: string
  projectKey: string
  repoRoot: string
}

const SIDEBAR_BUCKET_PRIORITY: Record<SidebarStateBucket, number> = {
  done: 0,
  attention: 1,
  running: 2,
  failed: 3,
  needs_input: 4,
}

function normalizePath(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value.trim()
}

function toWorkspaceKey(serverId: string, cwd: string): string {
  return `${serverId}:${cwd}`
}

function coerceBranchName(value: string | null | undefined): string | null {
  const trimmed = normalizePath(value)
  return trimmed.length > 0 ? trimmed : null
}

function maxDate(left: Date | null, right: Date): Date {
  if (!left || right.getTime() > left.getTime()) {
    return right
  }
  return left
}

function minDate(left: Date | null, right: Date): Date {
  if (!left || right.getTime() < left.getTime()) {
    return right
  }
  return left
}

function aggregateBucket(
  current: SidebarStateBucket,
  candidate: SidebarStateBucket
): SidebarStateBucket {
  return SIDEBAR_BUCKET_PRIORITY[candidate] > SIDEBAR_BUCKET_PRIORITY[current] ? candidate : current
}

function compareWorkspaceBaseline(
  left: SidebarWorkspaceEntry,
  right: SidebarWorkspaceEntry
): number {
  if (left.isMainCheckout !== right.isMainCheckout) {
    return left.isMainCheckout ? -1 : 1
  }

  if (left.createdAt && right.createdAt) {
    const dateDelta = right.createdAt.getTime() - left.createdAt.getTime()
    if (dateDelta !== 0) {
      return dateDelta
    }
  } else if (left.createdAt || right.createdAt) {
    return left.createdAt ? -1 : 1
  }

  const leftBranch = left.branchName ?? ''
  const rightBranch = right.branchName ?? ''
  const branchDelta = leftBranch.localeCompare(rightBranch, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
  if (branchDelta !== 0) {
    return branchDelta
  }

  return left.cwd.localeCompare(right.cwd, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function compareProjectBaseline(left: SidebarProjectEntry, right: SidebarProjectEntry): number {
  if (left.latestCreatedAt && right.latestCreatedAt) {
    const dateDelta = right.latestCreatedAt.getTime() - left.latestCreatedAt.getTime()
    if (dateDelta !== 0) {
      return dateDelta
    }
  } else if (left.latestCreatedAt || right.latestCreatedAt) {
    return left.latestCreatedAt ? -1 : 1
  }

  return left.projectName.localeCompare(right.projectName, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

export function applyStoredOrdering<T>(input: {
  items: T[]
  storedOrder: string[]
  getKey: (item: T) => string
}): T[] {
  if (input.items.length <= 1 || input.storedOrder.length === 0) {
    return input.items
  }

  const itemByKey = new Map<string, T>()
  for (const item of input.items) {
    itemByKey.set(input.getKey(item), item)
  }

  const prunedOrder: string[] = []
  const seen = new Set<string>()
  for (const key of input.storedOrder) {
    if (!itemByKey.has(key) || seen.has(key)) {
      continue
    }
    seen.add(key)
    prunedOrder.push(key)
  }

  if (prunedOrder.length === 0) {
    return input.items
  }

  const orderedSet = new Set(prunedOrder)
  const ordered: T[] = []
  let orderedIndex = 0

  for (const item of input.items) {
    const key = input.getKey(item)
    if (!orderedSet.has(key)) {
      ordered.push(item)
      continue
    }

    const targetKey = prunedOrder[orderedIndex] ?? key
    orderedIndex += 1
    ordered.push(itemByKey.get(targetKey) ?? item)
  }

  return ordered
}

function ensureWorkspace(
  project: MutableProjectEntry,
  input: {
    serverId: string
    cwd: string
    branchName: string | null
    createdAt: Date | null
    isMainCheckout: boolean
    isPaseoOwnedWorktree: boolean
  }
): MutableWorkspaceEntry {
  const workspaceKey = toWorkspaceKey(input.serverId, input.cwd)
  const existing = project.workspacesByKey.get(workspaceKey)

  if (existing) {
    if (!existing.branchName && input.branchName) {
      existing.branchName = input.branchName
    }
    if (input.createdAt) {
      existing.createdAt = existing.createdAt
        ? minDate(existing.createdAt, input.createdAt)
        : input.createdAt
    }
    if (input.isMainCheckout) {
      existing.isMainCheckout = true
    }
    if (input.isPaseoOwnedWorktree) {
      existing.isPaseoOwnedWorktree = true
    }
    return existing
  }

  const workspace: MutableWorkspaceEntry = {
    workspaceKey,
    serverId: input.serverId,
    cwd: input.cwd,
    branchName: input.branchName,
    createdAt: input.createdAt,
    isMainCheckout: input.isMainCheckout,
    isPaseoOwnedWorktree: input.isPaseoOwnedWorktree,
    statusBucket: 'done',
  }
  project.workspacesByKey.set(workspaceKey, workspace)
  return workspace
}

function cloneProject(project: MutableProjectEntry): MutableProjectEntry {
  return {
    ...project,
    repoRoots: new Set(project.repoRoots),
    workspacesByKey: new Map(
      Array.from(project.workspacesByKey.entries()).map(([key, workspace]) => [
        key,
        { ...workspace },
      ])
    ),
  }
}

function getWorkspaceOrderScopeKey(serverId: string, projectKey: string): string {
  return `${serverId.trim()}::${projectKey.trim()}`
}

export function useSidebarAgentsList(options?: {
  serverId?: string | null
  enabled?: boolean
}): SidebarAgentsListResult {
  const runtime = getHostRuntimeStore()

  const serverId = useMemo(() => {
    const value = options?.serverId
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  }, [options?.serverId])
  const enabled = options?.enabled ?? true

  const persistedProjectOrder = useSidebarOrderStore((state) =>
    serverId ? (state.projectOrderByServerId[serverId] ?? EMPTY_ORDER) : EMPTY_ORDER
  )
  const persistedWorkspaceOrderByScope = useSidebarOrderStore((state) =>
    serverId ? state.workspaceOrderByServerAndProject : {}
  )

  const isActive = Boolean(serverId)
  const liveAgents = useSessionStore((state) =>
    isActive && serverId ? (state.sessions[serverId]?.agents ?? null) : null
  )

  const runtimeStatusSignature = useSyncExternalStore(
    (onStoreChange) =>
      isActive && serverId ? runtime.subscribe(serverId, onStoreChange) : () => {},
    () => {
      if (!isActive || !serverId) {
        return 'idle:idle'
      }
      const snapshot = runtime.getSnapshot(serverId)
      const connectionStatus = snapshot?.connectionStatus ?? 'idle'
      const directoryStatus = snapshot?.agentDirectoryStatus ?? 'idle'
      return `${connectionStatus}:${directoryStatus}`
    },
    () => {
      if (!isActive || !serverId) {
        return 'idle:idle'
      }
      const snapshot = runtime.getSnapshot(serverId)
      const connectionStatus = snapshot?.connectionStatus ?? 'idle'
      const directoryStatus = snapshot?.agentDirectoryStatus ?? 'idle'
      return `${connectionStatus}:${directoryStatus}`
    }
  )
  const [connectionStatus = 'idle', directoryStatus = 'idle'] = runtimeStatusSignature.split(':', 2)

  const base = useMemo(() => {
    if (!isActive || !serverId || !liveAgents) {
      return {
        projectsByKey: new Map<string, MutableProjectEntry>(),
        worktreeRequests: [] as WorktreeRequest[],
        hasAnyData: false,
      }
    }

    const projectsByKey = new Map<string, MutableProjectEntry>()

    for (const sourceAgent of liveAgents.values()) {
      if (sourceAgent.archivedAt || sourceAgent.labels.ui !== 'true') {
        continue
      }

      const placement = resolveProjectPlacement({
        projectPlacement: sourceAgent.projectPlacement ?? null,
        cwd: sourceAgent.cwd,
      })
      const projectKey = normalizePath(placement.projectKey)
      if (!projectKey) {
        continue
      }

      const checkoutCwd = normalizePath(placement.checkout.cwd || sourceAgent.cwd)
      if (!checkoutCwd) {
        continue
      }

      const projectName = normalizePath(placement.projectName) || projectKey
      const project =
        projectsByKey.get(projectKey) ??
        ({
          projectKey,
          projectName,
          iconWorkingDir: checkoutCwd,
          statusBucket: 'done',
          activeCount: 0,
          totalCount: 0,
          latestCreatedAt: null,
          repoRoots: new Set<string>(),
          workspacesByKey: new Map<string, MutableWorkspaceEntry>(),
        } satisfies MutableProjectEntry)

      project.totalCount += 1
      project.latestCreatedAt = maxDate(project.latestCreatedAt, sourceAgent.createdAt)
      const bucket = deriveSidebarStateBucket({
        status: sourceAgent.status,
        pendingPermissionCount: sourceAgent.pendingPermissions.length,
        requiresAttention: sourceAgent.requiresAttention,
        attentionReason: sourceAgent.attentionReason,
      })
      project.statusBucket = aggregateBucket(project.statusBucket, bucket)
      if (bucket !== 'done') {
        project.activeCount += 1
      }

      const normalizedBranch = coerceBranchName(placement.checkout.currentBranch)
      const isMainCheckout = placement.checkout.isGit && !placement.checkout.isPaseoOwnedWorktree
      const workspace = ensureWorkspace(project, {
        serverId,
        cwd: checkoutCwd,
        branchName: normalizedBranch,
        createdAt: isMainCheckout ? sourceAgent.createdAt : null,
        isMainCheckout,
        isPaseoOwnedWorktree: placement.checkout.isPaseoOwnedWorktree,
      })
      workspace.statusBucket = aggregateBucket(workspace.statusBucket, bucket)

      const explicitMainRepoRoot = normalizePath(placement.checkout.mainRepoRoot)
      if (placement.checkout.isPaseoOwnedWorktree && explicitMainRepoRoot) {
        project.repoRoots.add(explicitMainRepoRoot)
        if (!project.iconWorkingDir) {
          project.iconWorkingDir = explicitMainRepoRoot
        }
      }
      if (isMainCheckout) {
        project.repoRoots.add(workspace.cwd)
        project.iconWorkingDir = workspace.cwd
      }

      if (!project.iconWorkingDir) {
        project.iconWorkingDir = workspace.cwd
      }

      projectsByKey.set(projectKey, project)
    }

    const worktreeRequests: WorktreeRequest[] = []
    for (const project of projectsByKey.values()) {
      for (const repoRoot of project.repoRoots) {
        if (!repoRoot) {
          continue
        }
        const requestKey = `${serverId}:${project.projectKey}:${repoRoot}`
        worktreeRequests.push({
          requestKey,
          serverId,
          projectKey: project.projectKey,
          repoRoot,
        })
      }
    }

    worktreeRequests.sort((left, right) =>
      left.requestKey.localeCompare(right.requestKey, undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    )

    return {
      projectsByKey,
      worktreeRequests,
      hasAnyData: projectsByKey.size > 0,
    }
  }, [isActive, liveAgents, serverId])

  const worktreeQueries = useQueries({
    queries: base.worktreeRequests.map((request) => ({
      queryKey: ['sidebarPaseoWorktreeList', request.serverId, request.repoRoot],
      queryFn: async (): Promise<PaseoWorktreeEntry[]> => {
        const client = runtime.getClient(request.serverId)
        if (!client) {
          return []
        }
        const payload = await client.getPaseoWorktreeList({
          repoRoot: request.repoRoot,
        })
        if (payload.error) {
          return []
        }
        return payload.worktrees ?? []
      },
      enabled:
        enabled &&
        isActive &&
        Boolean(serverId) &&
        connectionStatus === 'online' &&
        Boolean(runtime.getClient(request.serverId)) &&
        request.repoRoot.length > 0,
      staleTime: 15_000,
      gcTime: 1000 * 60 * 10,
      retry: false,
      refetchOnMount: 'always' as const,
    })),
  })

  const repoRootStatusQueries = useQueries({
    queries: base.worktreeRequests.map((request) => ({
      queryKey: checkoutStatusQueryKey(request.serverId, request.repoRoot),
      queryFn: async () => {
        const client = runtime.getClient(request.serverId)
        if (!client) {
          return null
        }
        try {
          return await client.getCheckoutStatus(request.repoRoot)
        } catch {
          return null
        }
      },
      enabled:
        enabled &&
        isActive &&
        Boolean(serverId) &&
        connectionStatus === 'online' &&
        Boolean(runtime.getClient(request.serverId)) &&
        request.repoRoot.length > 0,
      staleTime: 15_000,
      gcTime: 1000 * 60 * 10,
      retry: false,
      refetchOnMount: 'always' as const,
    })),
  })

  const projects = useMemo(() => {
    if (base.projectsByKey.size === 0) {
      return EMPTY_PROJECTS
    }

    const projectsByKey = new Map<string, MutableProjectEntry>()
    for (const [key, project] of base.projectsByKey.entries()) {
      projectsByKey.set(key, cloneProject(project))
    }

    for (let i = 0; i < base.worktreeRequests.length; i += 1) {
      const request = base.worktreeRequests[i]
      if (!request) {
        continue
      }

      const project = projectsByKey.get(request.projectKey)
      if (!project) {
        continue
      }

      const checkout = repoRootStatusQueries[i]?.data ?? null
      const mainBranchName = coerceBranchName(checkout?.currentBranch)

      ensureWorkspace(project, {
        serverId: request.serverId,
        cwd: request.repoRoot,
        branchName: mainBranchName,
        createdAt: null,
        isMainCheckout: true,
        isPaseoOwnedWorktree: false,
      })

      const worktrees = worktreeQueries[i]?.data ?? []
      for (const worktree of worktrees) {
        const worktreePath = normalizePath(worktree.worktreePath)
        if (!worktreePath) {
          continue
        }

        const createdAt = (() => {
          const createdAtRaw = worktree.createdAt
          if (typeof createdAtRaw !== 'string' || createdAtRaw.trim().length === 0) {
            return null
          }
          const parsed = new Date(createdAtRaw)
          return Number.isNaN(parsed.getTime()) ? null : parsed
        })()

        ensureWorkspace(project, {
          serverId: request.serverId,
          cwd: worktreePath,
          branchName: coerceBranchName(worktree.branchName) ?? coerceBranchName(worktree.head),
          createdAt,
          isMainCheckout: false,
          isPaseoOwnedWorktree: true,
        })
      }
    }

    const baselineProjects: SidebarProjectEntry[] = Array.from(projectsByKey.values()).map(
      (project) => {
        const baselineWorkspaces = Array.from(project.workspacesByKey.values()).map(
          (workspace) => ({
            workspaceKey: workspace.workspaceKey,
            serverId: workspace.serverId,
            cwd: workspace.cwd,
            branchName: workspace.branchName,
            createdAt: workspace.createdAt,
            isMainCheckout: workspace.isMainCheckout,
            isPaseoOwnedWorktree: workspace.isPaseoOwnedWorktree,
            statusBucket: workspace.statusBucket,
          })
        )

        baselineWorkspaces.sort(compareWorkspaceBaseline)

        const workspaceOrderScopeKey = getWorkspaceOrderScopeKey(serverId ?? '', project.projectKey)

        const orderedWorkspaces = applyStoredOrdering({
          items: baselineWorkspaces,
          storedOrder: persistedWorkspaceOrderByScope[workspaceOrderScopeKey] ?? EMPTY_ORDER,
          getKey: (workspace) => workspace.workspaceKey,
        })

        return {
          projectKey: project.projectKey,
          projectName: project.projectName,
          iconWorkingDir: project.iconWorkingDir,
          statusBucket: project.statusBucket,
          activeCount: project.activeCount,
          totalCount: project.totalCount,
          latestCreatedAt: project.latestCreatedAt,
          workspaces: orderedWorkspaces,
        }
      }
    )

    baselineProjects.sort(compareProjectBaseline)

    return applyStoredOrdering({
      items: baselineProjects,
      storedOrder: persistedProjectOrder,
      getKey: (project) => project.projectKey,
    })
  }, [
    base.projectsByKey,
    base.worktreeRequests,
    connectionStatus,
    isActive,
    persistedProjectOrder,
    persistedWorkspaceOrderByScope,
    repoRootStatusQueries,
    serverId,
    worktreeQueries,
  ])

  const refreshAll = useCallback(() => {
    if (!isActive || !serverId || connectionStatus !== 'online') {
      return
    }
    void runtime.refreshAgentDirectory({ serverId, page: { limit: 50 } }).catch(() => undefined)
  }, [connectionStatus, isActive, runtime, serverId])

  const isDirectoryLoading =
    isActive &&
    Boolean(serverId) &&
    (directoryStatus === 'initial_loading' || directoryStatus === 'revalidating')
  const isInitialLoad = isDirectoryLoading && !base.hasAnyData
  const isRevalidating = isDirectoryLoading && base.hasAnyData

  return {
    projects,
    isLoading: isDirectoryLoading,
    isInitialLoad,
    isRevalidating,
    refreshAll,
  }
}
