import { View, Text, Pressable, Image, Platform } from 'react-native'
import { useQueries } from '@tanstack/react-query'
import {
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  type ReactElement,
  type MutableRefObject,
} from 'react'
import { router, useSegments } from 'expo-router'
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles'
import { type GestureType } from 'react-native-gesture-handler'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { DraggableList, type DraggableRenderItemInfo } from './draggable-list'
import { getHostRuntimeStore, isHostRuntimeConnected } from '@/runtime/host-runtime'
import { projectIconQueryKey } from '@/hooks/use-project-icon-query'
import { buildHostWorkspaceRoute } from '@/utils/host-routes'
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from '@/hooks/use-sidebar-agents-list'
import { useSidebarOrderStore } from '@/stores/sidebar-order-store'
import { formatTimeAgo } from '@/utils/time'
import type { SidebarStateBucket } from '@/utils/sidebar-agent-state'

type SidebarTreeRow =
  | {
      kind: 'project'
      rowKey: string
      project: SidebarProjectEntry
      displayName: string
    }
  | {
      kind: 'workspace'
      rowKey: string
      projectKey: string
      workspace: SidebarWorkspaceEntry
    }

function toProjectIconDataUri(icon: { mimeType: string; data: string } | null): string | null {
  if (!icon) {
    return null
  }
  return `data:${icon.mimeType};base64,${icon.data}`
}

interface SidebarAgentListProps {
  isOpen?: boolean
  projects: SidebarProjectEntry[]
  serverId: string | null
  isRefreshing?: boolean
  onRefresh?: () => void
  onWorkspacePress?: () => void
  listFooterComponent?: ReactElement | null
  /** Gesture ref for coordinating with parent gestures (e.g., sidebar close) */
  parentGestureRef?: MutableRefObject<GestureType | undefined>
}

interface ProjectRowProps {
  project: SidebarProjectEntry
  displayName: string
  iconDataUri: string | null
  collapsed: boolean
  onToggle: () => void
  onLongPress: () => void
}

interface WorkspaceRowProps {
  workspace: SidebarWorkspaceEntry
  onPress: () => void
  onLongPress: () => void
}

function deriveProjectDisplayName(input: { projectKey: string; projectName: string }): string {
  const githubPrefix = 'remote:github.com/'
  if (input.projectKey.startsWith(githubPrefix)) {
    return input.projectKey.slice(githubPrefix.length)
  }

  if (input.projectKey.startsWith('remote:')) {
    const withoutPrefix = input.projectKey.slice('remote:'.length)
    const slashIdx = withoutPrefix.indexOf('/')
    if (slashIdx >= 0) {
      const remotePath = withoutPrefix.slice(slashIdx + 1).trim()
      if (remotePath.length > 0) {
        return remotePath
      }
    }
    return withoutPrefix
  }

  const trimmedProjectName = input.projectName.trim()
  if (trimmedProjectName.length > 0) {
    return trimmedProjectName
  }

  const normalized = input.projectKey.replace(/\\/g, '/').replace(/\/+$/, '')
  const segments = normalized.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? input.projectKey
}

function resolveWorkspaceBranchLabel(workspace: SidebarWorkspaceEntry): string {
  const branch = workspace.branchName?.trim()
  if (branch && branch.length > 0) {
    return branch
  }
  return 'Unknown branch'
}

function resolveWorkspaceCreatedAtLabel(workspace: SidebarWorkspaceEntry): string | null {
  if (!workspace.createdAt) {
    return null
  }
  return formatTimeAgo(workspace.createdAt)
}

function resolveStatusDotColor(input: { theme: ReturnType<typeof useUnistyles>['theme']; bucket: SidebarStateBucket }) {
  const { theme, bucket } = input
  return bucket === 'needs_input'
    ? theme.colors.palette.amber[500]
    : bucket === 'failed'
      ? theme.colors.palette.red[500]
      : bucket === 'running'
        ? theme.colors.palette.blue[500]
        : bucket === 'attention'
          ? theme.colors.palette.green[500]
          : theme.colors.border
}

function WorkspaceStatusDot({ bucket }: { bucket: SidebarWorkspaceEntry['statusBucket'] }) {
  const { theme } = useUnistyles()
  const color = resolveStatusDotColor({ theme, bucket })
  return <View style={[styles.workspaceStatusDot, { backgroundColor: color }]} />
}

function ProjectRow({
  project,
  displayName,
  iconDataUri,
  collapsed,
  onToggle,
  onLongPress,
}: ProjectRowProps) {
  const didLongPressRef = useRef(false)

  const handlePress = useCallback(() => {
    if (didLongPressRef.current) {
      didLongPressRef.current = false
      return
    }
    onToggle()
  }, [onToggle])

  const handleLongPress = useCallback(() => {
    didLongPressRef.current = true
    onLongPress()
  }, [onLongPress])

  return (
    <Pressable
      style={({ pressed, hovered = false }) => [
        styles.projectRow,
        hovered && styles.projectRowHovered,
        pressed && styles.projectRowPressed,
      ]}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={200}
      testID={`sidebar-project-row-${project.projectKey}`}
    >
      <View style={styles.projectRowLeft}>
        {collapsed ? (
          <ChevronRight size={14} color="#9ca3af" />
        ) : (
          <ChevronDown size={14} color="#9ca3af" />
        )}

        {iconDataUri ? (
          <Image source={{ uri: iconDataUri }} style={styles.projectIcon} />
        ) : (
          <View style={styles.projectIconFallback}>
            <Text style={styles.projectIconFallbackText}>
              {displayName.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}

        <Text style={styles.projectTitle} numberOfLines={1}>
          {displayName}
        </Text>
      </View>
    </Pressable>
  )
}

function WorkspaceRow({ workspace, onPress, onLongPress }: WorkspaceRowProps) {
  const didLongPressRef = useRef(false)
  const createdAtLabel = resolveWorkspaceCreatedAtLabel(workspace)

  const handlePress = useCallback(() => {
    if (didLongPressRef.current) {
      didLongPressRef.current = false
      return
    }
    onPress()
  }, [onPress])

  const handleLongPress = useCallback(() => {
    didLongPressRef.current = true
    onLongPress()
  }, [onLongPress])

  return (
    <Pressable
      style={({ pressed, hovered = false }) => [
        styles.workspaceRow,
        hovered && styles.workspaceRowHovered,
        pressed && styles.workspaceRowPressed,
      ]}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={200}
      testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
    >
      <View style={styles.workspaceRowLeft}>
        <WorkspaceStatusDot bucket={workspace.statusBucket} />
        <Text style={styles.workspaceBranchText} numberOfLines={1}>
          {resolveWorkspaceBranchLabel(workspace)}
        </Text>
      </View>
      {createdAtLabel ? (
        <Text style={styles.workspaceCreatedAtText} numberOfLines={1}>
          {createdAtLabel}
        </Text>
      ) : null}
    </Pressable>
  )
}

function mergeWithRemainder(input: {
  currentOrder: string[]
  reorderedVisibleKeys: string[]
}): string[] {
  const reorderedSet = new Set(input.reorderedVisibleKeys)
  const remainder = input.currentOrder.filter((key) => !reorderedSet.has(key))
  return [...input.reorderedVisibleKeys, ...remainder]
}

function hasVisibleOrderChanged(input: {
  currentOrder: string[]
  reorderedVisibleKeys: string[]
}): boolean {
  const currentVisible = input.currentOrder.filter((key) =>
    input.reorderedVisibleKeys.includes(key)
  )
  if (currentVisible.length !== input.reorderedVisibleKeys.length) {
    return true
  }
  return input.reorderedVisibleKeys.some((key, index) => currentVisible[index] !== key)
}

export function SidebarAgentList({
  isOpen = true,
  projects,
  serverId,
  isRefreshing = false,
  onRefresh,
  onWorkspacePress,
  listFooterComponent,
  parentGestureRef,
}: SidebarAgentListProps) {
  const isMobile = UnistylesRuntime.breakpoint === 'xs' || UnistylesRuntime.breakpoint === 'sm'
  const showDesktopWebScrollbar = Platform.OS === 'web' && !isMobile
  const segments = useSegments()
  const shouldReplaceWorkspaceNavigation = segments[0] === 'h'
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(new Set())
  const [canonicalResyncNonce, setCanonicalResyncNonce] = useState(0)

  const getProjectOrder = useSidebarOrderStore((state) => state.getProjectOrder)
  const setProjectOrder = useSidebarOrderStore((state) => state.setProjectOrder)
  const getWorkspaceOrder = useSidebarOrderStore((state) => state.getWorkspaceOrder)
  const setWorkspaceOrder = useSidebarOrderStore((state) => state.setWorkspaceOrder)

  useEffect(() => {
    setCollapsedProjectKeys((prev) => {
      const validProjectKeys = new Set(projects.map((project) => project.projectKey))
      const next = new Set<string>()
      for (const key of prev) {
        if (validProjectKeys.has(key)) {
          next.add(key)
        }
      }
      return next
    })
  }, [projects])

  const projectIconRequests = useMemo(() => {
    if (!isOpen || !serverId) {
      return []
    }
    const unique = new Map<string, { serverId: string; cwd: string }>()
    for (const project of projects) {
      const cwd = project.iconWorkingDir.trim()
      if (!cwd) {
        continue
      }
      unique.set(`${serverId}:${cwd}`, { serverId, cwd })
    }
    return Array.from(unique.values())
  }, [isOpen, projects, serverId])

  const projectIconQueries = useQueries({
    queries: projectIconRequests.map((request) => ({
      queryKey: projectIconQueryKey(request.serverId, request.cwd),
      queryFn: async () => {
        const client = getHostRuntimeStore().getClient(request.serverId)
        if (!client) {
          return null
        }
        const result = await client.requestProjectIcon(request.cwd)
        return result.icon
      },
      select: toProjectIconDataUri,
      enabled: Boolean(
        isOpen &&
        getHostRuntimeStore().getClient(request.serverId) &&
        isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(request.serverId)) &&
        request.cwd
      ),
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  })

  const projectIconByProjectKey = useMemo(() => {
    const iconByServerAndCwd = new Map<string, string | null>()
    for (let index = 0; index < projectIconRequests.length; index += 1) {
      const request = projectIconRequests[index]
      if (!request) {
        continue
      }
      iconByServerAndCwd.set(
        `${request.serverId}:${request.cwd}`,
        projectIconQueries[index]?.data ?? null
      )
    }

    const byProject = new Map<string, string | null>()
    for (const project of projects) {
      const cwd = project.iconWorkingDir.trim()
      if (!cwd || !serverId) {
        byProject.set(project.projectKey, null)
        continue
      }
      byProject.set(project.projectKey, iconByServerAndCwd.get(`${serverId}:${cwd}`) ?? null)
    }

    return byProject
  }, [projectIconQueries, projectIconRequests, projects, serverId])

  const rows = useMemo(() => {
    const next: SidebarTreeRow[] = []
    for (const project of projects) {
      next.push({
        kind: 'project',
        rowKey: `project:${project.projectKey}`,
        project,
        displayName: deriveProjectDisplayName({
          projectKey: project.projectKey,
          projectName: project.projectName,
        }),
      })

      if (collapsedProjectKeys.has(project.projectKey)) {
        continue
      }

      for (const workspace of project.workspaces) {
        next.push({
          kind: 'workspace',
          rowKey: `workspace:${project.projectKey}:${workspace.workspaceKey}`,
          projectKey: project.projectKey,
          workspace,
        })
      }
    }
    return next
  }, [canonicalResyncNonce, collapsedProjectKeys, projects])

  const toggleProjectCollapsed = useCallback((projectKey: string) => {
    setCollapsedProjectKeys((prev) => {
      const next = new Set(prev)
      if (next.has(projectKey)) {
        next.delete(projectKey)
      } else {
        next.add(projectKey)
      }
      return next
    })
  }, [])

  const renderRow = useCallback(
    ({ item, drag }: DraggableRenderItemInfo<SidebarTreeRow>) => {
      if (item.kind === 'project') {
        return (
          <ProjectRow
            project={item.project}
            displayName={item.displayName}
            iconDataUri={projectIconByProjectKey.get(item.project.projectKey) ?? null}
            collapsed={collapsedProjectKeys.has(item.project.projectKey)}
            onToggle={() => toggleProjectCollapsed(item.project.projectKey)}
            onLongPress={drag}
          />
        )
      }

      const workspaceRoute = buildHostWorkspaceRoute(serverId ?? '', item.workspace.cwd)
      const navigate = shouldReplaceWorkspaceNavigation ? router.replace : router.push

      return (
        <WorkspaceRow
          workspace={item.workspace}
          onPress={() => {
            if (!serverId) {
              return
            }
            onWorkspacePress?.()
            navigate(workspaceRoute as any)
          }}
          onLongPress={drag}
        />
      )
    },
    [
      collapsedProjectKeys,
      isMobile,
      onWorkspacePress,
      projectIconByProjectKey,
      serverId,
      shouldReplaceWorkspaceNavigation,
      toggleProjectCollapsed,
    ]
  )

  const keyExtractor = useCallback((entry: SidebarTreeRow) => entry.rowKey, [])

  const handleDragEnd = useCallback(
    (reorderedRows: SidebarTreeRow[]) => {
      if (!serverId) {
        return
      }

      let didPersistOrderChange = false
      const reorderedProjectKeys = reorderedRows
        .filter(
          (row): row is Extract<SidebarTreeRow, { kind: 'project' }> => row.kind === 'project'
        )
        .map((row) => row.project.projectKey)

      const currentProjectOrder = getProjectOrder(serverId)
      if (
        hasVisibleOrderChanged({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        })
      ) {
        didPersistOrderChange = true
        setProjectOrder(
          serverId,
          mergeWithRemainder({
            currentOrder: currentProjectOrder,
            reorderedVisibleKeys: reorderedProjectKeys,
          })
        )
      }

      const workspaceRowsByProject = new Map<string, string[]>()
      for (const row of reorderedRows) {
        if (row.kind !== 'workspace') {
          continue
        }
        const list = workspaceRowsByProject.get(row.projectKey) ?? []
        list.push(row.workspace.workspaceKey)
        workspaceRowsByProject.set(row.projectKey, list)
      }

      for (const [projectKey, reorderedWorkspaceKeys] of workspaceRowsByProject.entries()) {
        const currentWorkspaceOrder = getWorkspaceOrder(serverId, projectKey)
        if (
          !hasVisibleOrderChanged({
            currentOrder: currentWorkspaceOrder,
            reorderedVisibleKeys: reorderedWorkspaceKeys,
          })
        ) {
          continue
        }

        didPersistOrderChange = true
        setWorkspaceOrder(
          serverId,
          projectKey,
          mergeWithRemainder({
            currentOrder: currentWorkspaceOrder,
            reorderedVisibleKeys: reorderedWorkspaceKeys,
          })
        )
      }

      // If persisted ordering did not change, force a local resync so draggable UI state
      // snaps back to canonical Project -> Workspaces grouping.
      if (!didPersistOrderChange) {
        setCanonicalResyncNonce((prev) => prev + 1)
      }
    },
    [getProjectOrder, getWorkspaceOrder, serverId, setProjectOrder, setWorkspaceOrder]
  )

  return (
    <View style={styles.container}>
      <DraggableList
        data={rows}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        testID="sidebar-project-workspace-list-scroll"
        keyExtractor={keyExtractor}
        renderItem={renderRow}
        onDragEnd={handleDragEnd}
        showsVerticalScrollIndicator={false}
        enableDesktopWebScrollbar={showDesktopWebScrollbar}
        ListFooterComponent={listFooterComponent}
        ListEmptyComponent={<Text style={styles.emptyText}>No projects yet</Text>}
        refreshing={isRefreshing}
        onRefresh={onRefresh}
        simultaneousGestureRef={parentGestureRef}
      />
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    textAlign: 'center',
    marginTop: theme.spacing[8],
    marginHorizontal: theme.spacing[2],
  },
  projectRow: {
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[2],
  },
  projectRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  projectRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  projectRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  projectIcon: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    borderRadius: theme.borderRadius.sm,
  },
  projectIconFallback: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectIconFallbackText: {
    color: theme.colors.foregroundMuted,
    fontSize: 9,
  },
  projectTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flex: 1,
    minWidth: 0,
  },
  workspaceRow: {
    minHeight: 36,
    marginBottom: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[2],
  },
  workspaceRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  workspaceRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  workspaceRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  workspaceStatusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
  },
  workspaceBranchText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flex: 1,
    minWidth: 0,
  },
  workspaceCreatedAtText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 0,
  },
}))
