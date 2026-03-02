import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import {
  Bot,
  ChevronDown,
  Folder,
  GitBranch,
  MoreVertical,
  PanelRight,
  Plus,
  Terminal,
  X,
} from "lucide-react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { ScreenHeader } from "@/components/headers/screen-header";
import { Combobox } from "@/components/ui/combobox";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExplorerSidebar } from "@/components/explorer-sidebar";
import { TerminalPane } from "@/components/terminal-pane";
import { ExplorerSidebarAnimationProvider } from "@/contexts/explorer-sidebar-animation-context";
import { useExplorerOpenGesture } from "@/hooks/use-explorer-open-gesture";
import { usePanelStore, type ExplorerCheckoutContext } from "@/stores/panel-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  buildWorkspaceTabPersistenceKey,
  useWorkspaceTabsStore,
  type WorkspaceTabTarget,
} from "@/stores/workspace-tabs-store";
import {
  buildHostAgentDetailRoute,
  buildHostWorkspaceRoute,
  buildHostWorkspaceAgentRoute,
  buildHostWorkspaceTerminalRoute,
} from "@/utils/host-routes";
import { buildNewAgentRoute } from "@/utils/new-agent-routing";
import { useHostRuntimeSession } from "@/runtime/host-runtime";
import {
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
} from "@/hooks/use-checkout-status-query";
import { AgentReadyScreen } from "@/screens/agent/agent-ready-screen";
import type { ListTerminalsResponse } from "@server/shared/messages";
import { upsertTerminalListEntry } from "@/utils/terminal-list";
import { confirmDialog } from "@/utils/confirm-dialog";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { useArchiveAgent } from "@/hooks/use-archive-agent";

const TERMINALS_QUERY_STALE_TIME = 5_000;
const DROPDOWN_WIDTH = 220;
const NEW_TAB_AGENT_OPTION_ID = "__new_tab_agent__";
const NEW_TAB_TERMINAL_OPTION_ID = "__new_tab_terminal__";

type TabAvailability = "available" | "invalid" | "unknown";

type RouteTabTarget = WorkspaceTabTarget | null;

type WorkspaceScreenProps = {
  serverId: string;
  workspaceId: string;
  routeTab: RouteTabTarget;
};

type WorkspaceTabDescriptor =
  | {
      key: string;
      kind: "agent";
      agentId: string;
      provider: Agent["provider"];
      label: string;
      subtitle: string;
    }
  | {
      key: string;
      kind: "terminal";
      terminalId: string;
      label: string;
      subtitle: string;
    };

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function deriveWorkspaceName(workspaceId: string): string {
  const normalized = workspaceId.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last ?? workspaceId;
}

function deriveWorkspaceHeaderTitle(input: {
  workspaceName: string;
  checkout: CheckoutStatusPayload | null;
}): string {
  if (!input.checkout?.isGit) {
    return input.workspaceName;
  }

  const branch = trimNonEmpty(input.checkout.currentBranch ?? null);
  if (!branch || branch === "HEAD") {
    return input.workspaceName;
  }

  return branch;
}

function formatProviderLabel(provider: Agent["provider"]): string {
  if (provider === "claude") {
    return "Claude";
  }
  if (provider === "codex") {
    return "Codex";
  }
  if (!provider) {
    return "Agent";
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function normalizeWorkspaceTab(
  value: WorkspaceTabTarget | null | undefined
): WorkspaceTabTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value.kind === "agent") {
    const agentId = trimNonEmpty(decodeSegment(value.agentId));
    if (!agentId) {
      return null;
    }
    return { kind: "agent", agentId };
  }
  if (value.kind === "terminal") {
    const terminalId = trimNonEmpty(decodeSegment(value.terminalId));
    if (!terminalId) {
      return null;
    }
    return { kind: "terminal", terminalId };
  }
  return null;
}

function tabEquals(left: WorkspaceTabTarget | null, right: WorkspaceTabTarget | null): boolean {
  if (!left || !right) {
    return left === right;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "agent" && right.kind === "agent") {
    return left.agentId === right.agentId;
  }
  if (left.kind === "terminal" && right.kind === "terminal") {
    return left.terminalId === right.terminalId;
  }
  return false;
}

function buildTabRoute(input: {
  serverId: string;
  workspaceId: string;
  tab: WorkspaceTabTarget;
}): string {
  if (input.tab.kind === "agent") {
    return buildHostWorkspaceAgentRoute(
      input.serverId,
      input.workspaceId,
      input.tab.agentId
    );
  }
  return buildHostWorkspaceTerminalRoute(
    input.serverId,
    input.workspaceId,
    input.tab.terminalId
  );
}

function resolveTabAvailability(input: {
  tab: WorkspaceTabTarget;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  agentsById: Map<string, Agent>;
  terminalIds: Set<string>;
}): TabAvailability {
  if (input.tab.kind === "agent") {
    if (!input.agentsHydrated) {
      return "unknown";
    }
    return input.agentsById.has(input.tab.agentId) ? "available" : "invalid";
  }
  if (!input.terminalsHydrated) {
    return "unknown";
  }
  return input.terminalIds.has(input.tab.terminalId) ? "available" : "invalid";
}

function sortAgentsByCreatedAtDescending(agents: Agent[]): Agent[] {
  return [...agents].sort((left, right) => {
    const createdAtDelta =
      right.createdAt.getTime() - left.createdAt.getTime();
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }
    return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
  });
}

function toWorkspaceTabTarget(
  tab: WorkspaceTabDescriptor
): WorkspaceTabTarget {
  if (tab.kind === "agent") {
    return { kind: "agent", agentId: tab.agentId };
  }
  return { kind: "terminal", terminalId: tab.terminalId };
}

export function WorkspaceScreen({
  serverId,
  workspaceId,
  routeTab,
}: WorkspaceScreenProps) {
  return (
    <ExplorerSidebarAnimationProvider>
      <WorkspaceScreenContent serverId={serverId} workspaceId={workspaceId} routeTab={routeTab} />
    </ExplorerSidebarAnimationProvider>
  );
}

function WorkspaceScreenContent({
  serverId,
  workspaceId,
  routeTab,
}: WorkspaceScreenProps) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  const normalizedServerId = trimNonEmpty(decodeSegment(serverId)) ?? "";
  const normalizedWorkspaceId = trimNonEmpty(decodeSegment(workspaceId)) ?? "";

  const queryClient = useQueryClient();
  const { client, isConnected } = useHostRuntimeSession(normalizedServerId);

  const sessionAgents = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.agents
  );
  const workspaceAgents = useMemo(() => {
    if (!sessionAgents || !normalizedWorkspaceId) {
      return [] as Agent[];
    }

    const collected: Agent[] = [];
    for (const agent of sessionAgents.values()) {
      if (agent.archivedAt) {
        continue;
      }
      if ((trimNonEmpty(agent.cwd) ?? "") !== normalizedWorkspaceId) {
        continue;
      }
      collected.push(agent);
    }

    return sortAgentsByCreatedAtDescending(collected);
  }, [normalizedWorkspaceId, sessionAgents]);

  const terminalsQueryKey = useMemo(
    () => ["terminals", normalizedServerId, normalizedWorkspaceId] as const,
    [normalizedServerId, normalizedWorkspaceId]
  );
  type ListTerminalsPayload = ListTerminalsResponse["payload"];
  const terminalsQuery = useQuery({
    queryKey: terminalsQueryKey,
    enabled:
      Boolean(client && isConnected) &&
      normalizedWorkspaceId.length > 0 &&
      normalizedWorkspaceId.startsWith("/"),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.listTerminals(normalizedWorkspaceId);
    },
    staleTime: TERMINALS_QUERY_STALE_TIME,
  });
  const terminals = terminalsQuery.data?.terminals ?? [];
  const createTerminalMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.createTerminal(normalizedWorkspaceId);
    },
    onSuccess: (payload) => {
      const createdTerminal = payload.terminal;
      if (createdTerminal) {
        queryClient.setQueryData<ListTerminalsPayload>(
          terminalsQueryKey,
          (current) => {
            const nextTerminals = upsertTerminalListEntry({
              terminals: current?.terminals ?? [],
              terminal: createdTerminal,
            });
            return {
              cwd: current?.cwd ?? normalizedWorkspaceId,
              terminals: nextTerminals,
              requestId: current?.requestId ?? `terminal-create-${createdTerminal.id}`,
            };
          }
        );
      }

      void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
      if (createdTerminal) {
        navigateToTab({ kind: "terminal", terminalId: createdTerminal.id });
      }
    },
  });
  const killTerminalMutation = useMutation({
    mutationFn: async (terminalId: string) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const payload = await client.killTerminal(terminalId);
      if (!payload.success) {
        throw new Error("Unable to close terminal");
      }
      return payload;
    },
  });
  const { archiveAgent, isArchivingAgent } = useArchiveAgent();

  useEffect(() => {
    if (!client || !isConnected || !normalizedWorkspaceId.startsWith("/")) {
      return;
    }

    const unsubscribeChanged = client.on("terminals_changed", (message) => {
      if (message.type !== "terminals_changed") {
        return;
      }
      if (message.payload.cwd !== normalizedWorkspaceId) {
        return;
      }

      queryClient.setQueryData<ListTerminalsPayload>(terminalsQueryKey, (current) => ({
        cwd: message.payload.cwd,
        terminals: message.payload.terminals,
        requestId: current?.requestId ?? `terminals-changed-${Date.now()}`,
      }));
    });

    const unsubscribeStreamExit = client.on("terminal_stream_exit", (message) => {
      if (message.type !== "terminal_stream_exit") {
        return;
      }
    });

    client.subscribeTerminals({ cwd: normalizedWorkspaceId });

    return () => {
      unsubscribeChanged();
      unsubscribeStreamExit();
      client.unsubscribeTerminals({ cwd: normalizedWorkspaceId });
    };
  }, [client, isConnected, normalizedWorkspaceId, queryClient, terminalsQueryKey]);

  const checkoutQuery = useQuery({
    queryKey: checkoutStatusQueryKey(normalizedServerId, normalizedWorkspaceId),
    enabled:
      Boolean(client && isConnected) &&
      normalizedWorkspaceId.length > 0 &&
      normalizedWorkspaceId.startsWith("/"),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return (await client.getCheckoutStatus(
        normalizedWorkspaceId
      )) as CheckoutStatusPayload;
    },
    staleTime: 15_000,
  });

  const workspaceName = useMemo(
    () => deriveWorkspaceName(normalizedWorkspaceId),
    [normalizedWorkspaceId]
  );
  const headerTitle = useMemo(
    () =>
      deriveWorkspaceHeaderTitle({
        workspaceName,
        checkout: checkoutQuery.data ?? null,
      }),
    [checkoutQuery.data, workspaceName]
  );

  const isGitCheckout = checkoutQuery.data?.isGit ?? false;
  const areWorkspaceAgentsHydrated = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.hasHydratedAgents ?? false
  );
  const areWorkspaceTerminalsHydrated = terminalsQuery.isSuccess;

  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore(
    (state) => state.desktop.fileExplorerOpen
  );
  const toggleFileExplorer = usePanelStore((state) => state.toggleFileExplorer);
  const openFileExplorer = usePanelStore((state) => state.openFileExplorer);
  const activateExplorerTabForCheckout = usePanelStore(
    (state) => state.activateExplorerTabForCheckout
  );
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const setActiveExplorerCheckout = usePanelStore(
    (state) => state.setActiveExplorerCheckout
  );

  const isExplorerOpen = isMobile
    ? mobileView === "file-explorer"
    : desktopFileExplorerOpen;

  const activeExplorerCheckout = useMemo<ExplorerCheckoutContext | null>(() => {
    if (!normalizedServerId || !normalizedWorkspaceId.startsWith("/")) {
      return null;
    }
    return {
      serverId: normalizedServerId,
      cwd: normalizedWorkspaceId,
      isGit: isGitCheckout,
    };
  }, [isGitCheckout, normalizedServerId, normalizedWorkspaceId]);

  useEffect(() => {
    setActiveExplorerCheckout(activeExplorerCheckout);
  }, [activeExplorerCheckout, setActiveExplorerCheckout]);

  const openExplorerForWorkspace = useCallback(() => {
    if (!activeExplorerCheckout) {
      return;
    }
    activateExplorerTabForCheckout(activeExplorerCheckout);
    openFileExplorer();
  }, [
    activateExplorerTabForCheckout,
    activeExplorerCheckout,
    openFileExplorer,
  ]);

  const handleToggleExplorer = useCallback(() => {
    if (isExplorerOpen) {
      toggleFileExplorer();
      return;
    }
    openExplorerForWorkspace();
  }, [isExplorerOpen, openExplorerForWorkspace, toggleFileExplorer]);

  const explorerOpenGesture = useExplorerOpenGesture({
    enabled: isMobile && mobileView === "agent",
    onOpen: openExplorerForWorkspace,
  });

  useEffect(() => {
    if (Platform.OS === "web" || !isExplorerOpen) {
      return;
    }

    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isExplorerOpen) {
        closeToAgent();
        return true;
      }
      return false;
    });

    return () => handler.remove();
  }, [closeToAgent, isExplorerOpen]);

  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of workspaceAgents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [workspaceAgents]);

  const tabs = useMemo<WorkspaceTabDescriptor[]>(() => {
    const next: WorkspaceTabDescriptor[] = [];

    for (const agent of workspaceAgents) {
      next.push({
        key: `agent:${agent.id}`,
        kind: "agent",
        agentId: agent.id,
        provider: agent.provider,
        label: agent.title?.trim() || "New agent",
        subtitle: `${formatProviderLabel(agent.provider)} agent`,
      });
    }

    for (const terminal of terminals) {
      next.push({
        key: `terminal:${terminal.id}`,
        kind: "terminal",
        terminalId: terminal.id,
        label: terminal.name,
        subtitle: "Terminal",
      });
    }

    return next;
  }, [terminals, workspaceAgents]);

  const terminalIds = useMemo(() => {
    const set = new Set<string>();
    for (const terminal of terminals) {
      set.add(terminal.id);
    }
    return set;
  }, [terminals]);

  const requestedTab = useMemo(
    () => normalizeWorkspaceTab(routeTab),
    [routeTab]
  );

  const persistenceKey = useMemo(
    () =>
      buildWorkspaceTabPersistenceKey({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
      }),
    [normalizedServerId, normalizedWorkspaceId]
  );
  const lastFocusedTabByWorkspace = useWorkspaceTabsStore(
    (state) => state.lastFocusedTabByWorkspace
  );
  const setLastFocusedTab = useWorkspaceTabsStore(
    (state) => state.setLastFocusedTab
  );

  const storedTab = useMemo(() => {
    if (!persistenceKey) {
      return null;
    }
    return normalizeWorkspaceTab(lastFocusedTabByWorkspace[persistenceKey]);
  }, [lastFocusedTabByWorkspace, persistenceKey]);

  const fallbackTab = useMemo<WorkspaceTabTarget | null>(() => {
    const first = tabs[0];
    if (!first) {
      return null;
    }
    if (first.kind === "agent") {
      return { kind: "agent", agentId: first.agentId };
    }
    return { kind: "terminal", terminalId: first.terminalId };
  }, [tabs]);

  const requestedTabAvailability = useMemo<TabAvailability | null>(() => {
    if (!requestedTab) {
      return null;
    }
    return resolveTabAvailability({
      tab: requestedTab,
      agentsHydrated: areWorkspaceAgentsHydrated,
      terminalsHydrated: areWorkspaceTerminalsHydrated,
      agentsById,
      terminalIds,
    });
  }, [
    agentsById,
    areWorkspaceAgentsHydrated,
    areWorkspaceTerminalsHydrated,
    requestedTab,
    terminalIds,
  ]);

  const storedTabAvailability = useMemo<TabAvailability | null>(() => {
    if (!storedTab) {
      return null;
    }
    return resolveTabAvailability({
      tab: storedTab,
      agentsHydrated: areWorkspaceAgentsHydrated,
      terminalsHydrated: areWorkspaceTerminalsHydrated,
      agentsById,
      terminalIds,
    });
  }, [
    agentsById,
    areWorkspaceAgentsHydrated,
    areWorkspaceTerminalsHydrated,
    storedTab,
    terminalIds,
  ]);

  const resolvedTab = useMemo<WorkspaceTabTarget | null>(() => {
    if (requestedTab && requestedTabAvailability !== "invalid") {
      return requestedTab;
    }

    if (storedTab && storedTabAvailability !== "invalid") {
      return storedTab;
    }

    return fallbackTab;
  }, [fallbackTab, requestedTab, requestedTabAvailability, storedTab, storedTabAvailability]);

  const resolvedTabAvailability = useMemo<TabAvailability | null>(() => {
    if (!resolvedTab) {
      return null;
    }

    return resolveTabAvailability({
      tab: resolvedTab,
      agentsHydrated: areWorkspaceAgentsHydrated,
      terminalsHydrated: areWorkspaceTerminalsHydrated,
      agentsById,
      terminalIds,
    });
  }, [
    agentsById,
    areWorkspaceAgentsHydrated,
    areWorkspaceTerminalsHydrated,
    resolvedTab,
    terminalIds,
  ]);

  const navigateToTab = useCallback(
    (tab: WorkspaceTabTarget) => {
      if (tabEquals(tab, resolvedTab)) {
        return;
      }
      const targetRoute = buildTabRoute({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tab,
      });
      setLastFocusedTab({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tab,
      });
      router.replace(targetRoute as any);
    },
    [
      normalizedServerId,
      normalizedWorkspaceId,
      resolvedTab,
      router,
      setLastFocusedTab,
    ]
  );

  useEffect(() => {
    if (!resolvedTab) {
      return;
    }
    if (resolvedTabAvailability !== "available") {
      return;
    }

    setLastFocusedTab({
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      tab: resolvedTab,
    });
  }, [
    normalizedServerId,
    normalizedWorkspaceId,
    resolvedTab,
    resolvedTabAvailability,
    setLastFocusedTab,
  ]);

  useEffect(() => {
    if (!resolvedTab) {
      return;
    }

    if (tabEquals(requestedTab, resolvedTab)) {
      return;
    }

    const targetRoute = buildTabRoute({
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      tab: resolvedTab,
    });

    router.replace(targetRoute as any);
  }, [
    normalizedServerId,
    normalizedWorkspaceId,
    requestedTab,
    resolvedTab,
    router,
  ]);

  const [isTabSwitcherOpen, setIsTabSwitcherOpen] = useState(false);
  const [hoveredTabKey, setHoveredTabKey] = useState<string | null>(null);
  const [hoveredCloseTabKey, setHoveredCloseTabKey] = useState<string | null>(
    null
  );
  const tabSwitcherAnchorRef = useRef<View>(null);

  const tabByKey = useMemo(() => {
    const map = new Map<string, WorkspaceTabTarget>();
    for (const tab of tabs) {
      if (tab.kind === "agent") {
        map.set(tab.key, { kind: "agent", agentId: tab.agentId });
        continue;
      }
      map.set(tab.key, { kind: "terminal", terminalId: tab.terminalId });
    }
    return map;
  }, [tabs]);

  const activeTabKey = useMemo(() => {
    if (!resolvedTab) {
      return "";
    }
    if (resolvedTab.kind === "agent") {
      return `agent:${resolvedTab.agentId}`;
    }
    return `terminal:${resolvedTab.terminalId}`;
  }, [resolvedTab]);

  const tabSwitcherOptions = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.key,
        label: tab.label,
        description: tab.subtitle,
      })),
    [tabs]
  );

  const activeAgent = useMemo(() => {
    if (resolvedTab?.kind !== "agent") {
      return null;
    }
    return agentsById.get(resolvedTab.agentId) ?? null;
  }, [agentsById, resolvedTab]);

  const activeTabLabel = useMemo(() => {
    const active = tabs.find((tab) => tab.key === activeTabKey);
    return active?.label ?? "Select tab";
  }, [activeTabKey, tabs]);

  const handleCreateAgent = useCallback(() => {
    if (!normalizedServerId) {
      return;
    }
    router.push(
      buildNewAgentRoute(normalizedServerId, normalizedWorkspaceId) as any
    );
  }, [normalizedServerId, normalizedWorkspaceId, router]);

  const handleCreateTerminal = useCallback(() => {
    if (createTerminalMutation.isPending) {
      return;
    }
    if (!normalizedWorkspaceId.startsWith("/")) {
      return;
    }
    createTerminalMutation.mutate();
  }, [createTerminalMutation, normalizedWorkspaceId]);

  const handleSelectSwitcherTab = useCallback(
    (key: string) => {
      const tab = tabByKey.get(key);
      if (!tab) {
        return;
      }
      setIsTabSwitcherOpen(false);
      navigateToTab(tab);
    },
    [navigateToTab, tabByKey]
  );

  const handleSelectNewTabOption = useCallback(
    (key: typeof NEW_TAB_AGENT_OPTION_ID | typeof NEW_TAB_TERMINAL_OPTION_ID) => {
      if (key === NEW_TAB_AGENT_OPTION_ID) {
        handleCreateAgent();
        return;
      }
      if (key === NEW_TAB_TERMINAL_OPTION_ID) {
        handleCreateTerminal();
      }
    },
    [handleCreateAgent, handleCreateTerminal]
  );

  const getTabAfterClosing = useCallback(
    (tabKey: string): WorkspaceTabTarget | null => {
      const currentIndex = tabs.findIndex((tab) => tab.key === tabKey);
      const nextTabs = tabs.filter((tab) => tab.key !== tabKey);
      if (nextTabs.length === 0) {
        return null;
      }
      const safeIndex = currentIndex < 0
        ? 0
        : Math.min(currentIndex, nextTabs.length - 1);
      const candidate = nextTabs[safeIndex] ?? nextTabs[0];
      if (!candidate) {
        return null;
      }
      return toWorkspaceTabTarget(candidate);
    },
    [tabs]
  );

  const handleCloseTerminalTab = useCallback(
    async (terminalId: string) => {
      if (
        killTerminalMutation.isPending &&
        killTerminalMutation.variables === terminalId
      ) {
        return;
      }

      const confirmed = await confirmDialog({
        title: "Close terminal?",
        message: "Any running process in this terminal will be stopped immediately.",
        confirmLabel: "Close",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      killTerminalMutation.mutate(terminalId, {
        onSuccess: () => {
          const tabKey = `terminal:${terminalId}`;
          setHoveredTabKey((current) => (current === tabKey ? null : current));
          setHoveredCloseTabKey((current) =>
            current === tabKey ? null : current
          );

          queryClient.setQueryData<ListTerminalsPayload>(
            terminalsQueryKey,
            (current) => {
              if (!current) {
                return current;
              }
              return {
                ...current,
                terminals: current.terminals.filter((terminal) => terminal.id !== terminalId),
              };
            }
          );

          if (resolvedTab?.kind === "terminal" && resolvedTab.terminalId === terminalId) {
            const nextTab = getTabAfterClosing(`terminal:${terminalId}`);
            if (nextTab) {
              navigateToTab(nextTab);
            } else {
              router.replace(
                buildHostWorkspaceRoute(
                  normalizedServerId,
                  normalizedWorkspaceId
                ) as any
              );
            }
          }
        },
      });
    },
    [
      getTabAfterClosing,
      killTerminalMutation,
      navigateToTab,
      normalizedServerId,
      normalizedWorkspaceId,
      queryClient,
      resolvedTab,
      router,
      terminalsQueryKey,
    ]
  );

  const handleCloseAgentTab = useCallback(
    async (agentId: string) => {
      if (!normalizedServerId || isArchivingAgent({ serverId: normalizedServerId, agentId })) {
        return;
      }

      const confirmed = await confirmDialog({
        title: "Archive agent?",
        message: "This closes the tab and archives the agent.",
        confirmLabel: "Archive",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      await archiveAgent({ serverId: normalizedServerId, agentId });

      const tabKey = `agent:${agentId}`;
      setHoveredTabKey((current) => (current === tabKey ? null : current));
      setHoveredCloseTabKey((current) => (current === tabKey ? null : current));

      if (resolvedTab?.kind === "agent" && resolvedTab.agentId === agentId) {
        const nextTab = getTabAfterClosing(tabKey);
        if (nextTab) {
          navigateToTab(nextTab);
        } else {
          router.replace(
            buildHostWorkspaceRoute(
              normalizedServerId,
              normalizedWorkspaceId
            ) as any
          );
        }
      }
    },
    [
      archiveAgent,
      getTabAfterClosing,
      isArchivingAgent,
      navigateToTab,
      normalizedServerId,
      normalizedWorkspaceId,
      resolvedTab,
      router,
    ]
  );

  const handleOpenAgentChatView = useCallback(() => {
    if (!activeAgent) {
      return;
    }
    router.push(
      buildHostAgentDetailRoute(normalizedServerId, activeAgent.id) as any
    );
  }, [activeAgent, normalizedServerId, router]);

  const renderContent = () => {
    if (!resolvedTab) {
      return (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateText}>
            No tabs are available yet. Use New tab to create an agent or terminal.
          </Text>
        </View>
      );
    }

    if (resolvedTab.kind === "agent") {
      return (
        <AgentReadyScreen
          serverId={normalizedServerId}
          agentId={resolvedTab.agentId}
          showHeader={false}
          showExplorerSidebar={false}
          wrapWithExplorerSidebarProvider={false}
        />
      );
    }

    return (
      <TerminalPane
        serverId={normalizedServerId}
        cwd={normalizedWorkspaceId}
        selectedTerminalId={resolvedTab.terminalId}
        onSelectedTerminalIdChange={(terminalId) => {
          if (!terminalId) {
            return;
          }
          navigateToTab({ kind: "terminal", terminalId });
        }}
        hideHeader
        manageTerminalDirectorySubscription={false}
      />
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.threePaneRow}>
        <View style={styles.centerColumn}>
          <ScreenHeader
            left={
              <>
                <SidebarMenuToggle />
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {headerTitle}
                </Text>
              </>
            }
            right={
              <View style={styles.headerRight}>
                <HeaderToggleButton
                  testID="workspace-explorer-toggle"
                  onPress={handleToggleExplorer}
                  tooltipLabel="Toggle explorer"
                  tooltipKeys={["mod", "E"]}
                  tooltipSide="left"
                  style={styles.menuButton}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={isExplorerOpen ? "Close explorer" : "Open explorer"}
                  accessibilityState={{ expanded: isExplorerOpen }}
                >
                  {isMobile ? (
                    isGitCheckout ? (
                      <GitBranch
                        size={theme.iconSize.lg}
                        color={
                          isExplorerOpen
                            ? theme.colors.foreground
                            : theme.colors.foregroundMuted
                        }
                      />
                    ) : (
                      <Folder
                        size={theme.iconSize.lg}
                        color={
                          isExplorerOpen
                            ? theme.colors.foreground
                            : theme.colors.foregroundMuted
                        }
                      />
                    )
                  ) : (
                    <PanelRight
                      size={theme.iconSize.md}
                      color={
                        isExplorerOpen
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted
                      }
                    />
                  )}
                </HeaderToggleButton>

                {activeAgent ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      testID="workspace-agent-overflow-menu"
                      style={styles.menuButton}
                    >
                      <MoreVertical
                        size={isMobile ? theme.iconSize.lg : theme.iconSize.md}
                        color={theme.colors.foregroundMuted}
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      width={DROPDOWN_WIDTH}
                      testID="workspace-agent-overflow-content"
                    >
                      <DropdownMenuItem
                        testID="workspace-agent-overflow-open-chat"
                        description="Open this agent with the full chat header"
                        onSelect={handleOpenAgentChatView}
                      >
                        Open chat view
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </View>
            }
          />

          {isMobile ? (
            <View style={styles.mobileTabsRow} testID="workspace-tabs-row">
              <Pressable
                ref={tabSwitcherAnchorRef}
                style={({ hovered, pressed }) => [
                  styles.switcherTrigger,
                  (hovered || pressed || isTabSwitcherOpen) && styles.switcherTriggerActive,
                  { borderWidth: 0, borderColor: "transparent" },
                  Platform.OS === "web"
                    ? {
                        outlineStyle: "solid",
                        outlineWidth: 0,
                        outlineColor: "transparent",
                      }
                    : null,
                ]}
                onPress={() => setIsTabSwitcherOpen(true)}
              >
                <View style={styles.switcherTriggerLeft}>
                  <View style={styles.switcherTriggerIcon} testID="workspace-active-tab-icon">
                    {(() => {
                      const activeDescriptor = tabs.find((tab) => tab.key === activeTabKey) ?? null;
                      if (!activeDescriptor) {
                        return <View style={styles.tabIcon}><Bot size={14} color={theme.colors.foregroundMuted} /></View>;
                      }

                      if (activeDescriptor.kind === "terminal") {
                        return <Terminal size={14} color={theme.colors.foreground} />;
                      }

                      const tabAgent = agentsById.get(activeDescriptor.agentId) ?? null;
                      const tabAgentStatusBucket = tabAgent
                        ? deriveSidebarStateBucket({
                            status: tabAgent.status,
                            pendingPermissionCount: tabAgent.pendingPermissions.length,
                            requiresAttention: tabAgent.requiresAttention,
                            attentionReason: tabAgent.attentionReason,
                          })
                        : null;
                      const tabAgentStatusColor =
                        tabAgentStatusBucket === null
                          ? null
                          : getStatusDotColor({
                              theme,
                              bucket: tabAgentStatusBucket,
                              showDoneAsInactive: false,
                            });

                      return (
                        <View style={styles.tabAgentIconWrapper}>
                          {activeDescriptor.provider === "claude" ? (
                            <ClaudeIcon size={14} color={theme.colors.foreground} />
                          ) : activeDescriptor.provider === "codex" ? (
                            <CodexIcon size={14} color={theme.colors.foreground} />
                          ) : (
                            <Bot size={14} color={theme.colors.foreground} />
                          )}
                          {tabAgentStatusColor ? (
                            <View
                              style={[
                                styles.tabStatusDot,
                                {
                                  backgroundColor: tabAgentStatusColor,
                                  borderColor: theme.colors.surface0,
                                },
                              ]}
                            />
                          ) : null}
                        </View>
                      );
                    })()}
                  </View>

                  <Text style={styles.switcherTriggerText} numberOfLines={1}>
                    {activeTabLabel}
                  </Text>
                </View>

                <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              </Pressable>

              <View style={styles.mobileTabsActions}>
                <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                  <TooltipTrigger
                    testID="workspace-new-agent-tab"
                    onPress={() => handleSelectNewTabOption(NEW_TAB_AGENT_OPTION_ID)}
                    accessibilityRole="button"
                    accessibilityLabel="New agent tab"
                    style={({ hovered, pressed }) => [
                      styles.newTabActionButton,
                      (hovered || pressed) && styles.newTabActionButtonHovered,
                    ]}
                  >
                    <Plus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end" offset={8}>
                    <Text style={styles.newTabTooltipText}>New agent tab</Text>
                  </TooltipContent>
                </Tooltip>

                <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                  <TooltipTrigger
                    testID="workspace-new-terminal-tab"
                    onPress={() => handleSelectNewTabOption(NEW_TAB_TERMINAL_OPTION_ID)}
                    disabled={createTerminalMutation.isPending}
                    accessibilityRole="button"
                    accessibilityLabel="New terminal tab"
                    style={({ hovered, pressed }) => [
                      styles.newTabActionButton,
                      createTerminalMutation.isPending && styles.newTabActionButtonDisabled,
                      (hovered || pressed) && styles.newTabActionButtonHovered,
                    ]}
                  >
                    {createTerminalMutation.isPending ? (
                      <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
                    ) : (
                      <View style={styles.terminalPlusIcon}>
                        <Terminal size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                        <View style={styles.terminalPlusBadge}>
                          <Plus size={10} color={theme.colors.foregroundMuted} />
                        </View>
                      </View>
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end" offset={8}>
                    <Text style={styles.newTabTooltipText}>New terminal tab</Text>
                  </TooltipContent>
                </Tooltip>
              </View>

              <Combobox
                options={tabSwitcherOptions}
                value={activeTabKey}
                onSelect={handleSelectSwitcherTab}
                searchable={false}
                title="Switch tab"
                searchPlaceholder="Search tabs"
                open={isTabSwitcherOpen}
                onOpenChange={setIsTabSwitcherOpen}
                anchorRef={tabSwitcherAnchorRef}
              />
            </View>
          ) : (
            <View style={styles.tabsContainer} testID="workspace-tabs-row">
              <ScrollView
                horizontal
                testID="workspace-tabs-scroll"
                style={styles.tabsScroll}
                contentContainerStyle={styles.tabsContent}
                showsHorizontalScrollIndicator={false}
              >
                {tabs.map((tab) => {
                  const isActive = tab.key === activeTabKey;
                  const tabAgent = tab.kind === "agent" ? agentsById.get(tab.agentId) ?? null : null;
                  const isTabHovered = hoveredTabKey === tab.key;
                  const isCloseHovered = hoveredCloseTabKey === tab.key;
                  const isClosingAgent =
                    tab.kind === "agent" &&
                    isArchivingAgent({
                      serverId: normalizedServerId,
                      agentId: tab.agentId,
                    });
                  const isClosingTerminal =
                    tab.kind === "terminal" &&
                    killTerminalMutation.isPending &&
                    killTerminalMutation.variables === tab.terminalId;
                  const isClosingTab = isClosingAgent || isClosingTerminal;
                  const shouldShowCloseButton = true;
                  const iconColor = isActive
                    ? theme.colors.foreground
                    : theme.colors.foregroundMuted;
                  const tabAgentStatusBucket = tabAgent
                    ? deriveSidebarStateBucket({
                        status: tabAgent.status,
                        pendingPermissionCount: tabAgent.pendingPermissions.length,
                        requiresAttention: tabAgent.requiresAttention,
                        attentionReason: tabAgent.attentionReason,
                      })
                    : null;
                  const tabAgentStatusColor =
                    tabAgentStatusBucket === null
                      ? null
                      : getStatusDotColor({
                          theme,
                          bucket: tabAgentStatusBucket,
                          showDoneAsInactive: false,
                        });
                  const icon =
                    tab.kind === "agent" ? (
                      <View style={styles.tabAgentIconWrapper}>
                        {tab.provider === "claude" ? (
                          <ClaudeIcon size={14} color={iconColor} />
                        ) : tab.provider === "codex" ? (
                          <CodexIcon size={14} color={iconColor} />
                        ) : (
                          <Bot size={14} color={iconColor} />
                        )}
                        {tabAgentStatusColor ? (
                          <View
                            style={[
                              styles.tabStatusDot,
                              {
                                backgroundColor: tabAgentStatusColor,
                                borderColor: theme.colors.surface0,
                              },
                            ]}
                          />
                        ) : null}
                      </View>
                    ) : (
                      <Terminal size={14} color={iconColor} />
                    );

                  return (
                    <Pressable
                      key={tab.key}
                      testID={`workspace-tab-${tab.key}`}
                      style={({ hovered, pressed }) => [
                        styles.tab,
                        isActive && styles.tabActive,
                        (hovered || pressed || isCloseHovered) && styles.tabHovered,
                      ]}
                      onHoverIn={() => {
                        setHoveredTabKey(tab.key);
                      }}
                      onHoverOut={() => {
                        setHoveredTabKey((current) =>
                          current === tab.key ? null : current
                        );
                      }}
                      onPress={() => {
                        if (tab.kind === "agent") {
                          navigateToTab({ kind: "agent", agentId: tab.agentId });
                          return;
                        }
                        navigateToTab({
                          kind: "terminal",
                          terminalId: tab.terminalId,
                        });
                      }}
                    >
                      <View style={styles.tabIcon}>{icon}</View>
                      <Text
                        style={[
                          styles.tabLabel,
                          isActive && styles.tabLabelActive,
                          shouldShowCloseButton && styles.tabLabelWithCloseButton,
                        ]}
                        numberOfLines={1}
                      >
                        {tab.label}
                      </Text>
                      <Pressable
                        testID={
                          tab.kind === "agent"
                            ? `workspace-agent-close-${tab.agentId}`
                            : `workspace-terminal-close-${tab.terminalId}`
                        }
                        pointerEvents={shouldShowCloseButton ? "auto" : "none"}
                        disabled={!shouldShowCloseButton || isClosingTab}
                        onHoverIn={() => {
                          setHoveredTabKey(tab.key);
                          setHoveredCloseTabKey(tab.key);
                        }}
                        onHoverOut={() => {
                          setHoveredTabKey((current) =>
                            current === tab.key ? null : current
                          );
                          setHoveredCloseTabKey((current) =>
                            current === tab.key ? null : current
                          );
                        }}
                        onPress={(event) => {
                          event.stopPropagation?.();
                          if (tab.kind === "agent") {
                            void handleCloseAgentTab(tab.agentId);
                            return;
                          }
                          void handleCloseTerminalTab(tab.terminalId);
                        }}
                        style={({ hovered, pressed }) => [
                          styles.tabCloseButton,
                          shouldShowCloseButton
                            ? styles.tabCloseButtonShown
                            : styles.tabCloseButtonHidden,
                          (hovered || pressed) && styles.tabCloseButtonActive,
                        ]}
                      >
                        {isClosingTab ? (
                          <ActivityIndicator
                            size={12}
                            color={theme.colors.foregroundMuted}
                          />
                        ) : (
                          <X size={12} color={theme.colors.foregroundMuted} />
                        )}
                      </Pressable>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <View style={styles.tabsActions}>
                <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                  <TooltipTrigger
                    testID="workspace-new-agent-tab"
                    onPress={() => handleSelectNewTabOption(NEW_TAB_AGENT_OPTION_ID)}
                    accessibilityRole="button"
                    accessibilityLabel="New agent tab"
                    style={({ hovered, pressed }) => [
                      styles.newTabActionButton,
                      (hovered || pressed) && styles.newTabActionButtonHovered,
                    ]}
                  >
                    <Plus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end" offset={8}>
                    <Text style={styles.newTabTooltipText}>New agent tab</Text>
                  </TooltipContent>
                </Tooltip>
                <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                  <TooltipTrigger
                    testID="workspace-new-terminal-tab"
                    onPress={() => handleSelectNewTabOption(NEW_TAB_TERMINAL_OPTION_ID)}
                    disabled={createTerminalMutation.isPending}
                    accessibilityRole="button"
                    accessibilityLabel="New terminal tab"
                    style={({ hovered, pressed }) => [
                      styles.newTabActionButton,
                      createTerminalMutation.isPending && styles.newTabActionButtonDisabled,
                      (hovered || pressed) && styles.newTabActionButtonHovered,
                    ]}
                  >
                    {createTerminalMutation.isPending ? (
                      <ActivityIndicator
                        size="small"
                        color={theme.colors.foregroundMuted}
                      />
                    ) : (
                      <View style={styles.terminalPlusIcon}>
                        <Terminal
                          size={theme.iconSize.sm}
                          color={theme.colors.foregroundMuted}
                        />
                        <View style={styles.terminalPlusBadge}>
                          <Plus size={10} color={theme.colors.foregroundMuted} />
                        </View>
                      </View>
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end" offset={8}>
                    <Text style={styles.newTabTooltipText}>New terminal tab</Text>
                  </TooltipContent>
                </Tooltip>
              </View>
            </View>
          )}

          <View style={styles.centerContent}>
            {isMobile ? (
              <GestureDetector gesture={explorerOpenGesture} touchAction="pan-y">
                <View style={styles.content}>{renderContent()}</View>
              </GestureDetector>
            ) : (
              <View style={styles.content}>{renderContent()}</View>
            )}
          </View>
        </View>

        <ExplorerSidebar
          serverId={normalizedServerId}
          workspaceId={normalizedWorkspaceId}
          workspaceRoot={normalizedWorkspaceId}
          isGit={isGitCheckout}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  threePaneRow: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    alignItems: "stretch",
  },
  centerColumn: {
    flex: 1,
    minHeight: 0,
  },
  headerTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  menuButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  newTabActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  newTabActionButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  newTabActionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  newTabActionButtonDisabled: {
    opacity: 0.6,
  },
  newTabTooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  terminalPlusIcon: {
    position: "relative",
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  terminalPlusBadge: {
    position: "absolute",
    right: -6,
    bottom: -6,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  mobileTabsRow: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  mobileTabsActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  switcherTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    justifyContent: "space-between",
  },
  switcherTriggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  switcherTriggerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  switcherTriggerIcon: {
    flexShrink: 0,
  },
  switcherTriggerText: {
    minWidth: 0,
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tabsContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
  },
  tabsScroll: {
    flex: 1,
    minWidth: 0,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  tabsActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  centerContent: {
    flex: 1,
    minHeight: 0,
  },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 260,
  },
  tabIcon: {
    flexShrink: 0,
  },
  tabAgentIconWrapper: {
    position: "relative",
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  tabStatusDot: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  tabActive: {
    backgroundColor: theme.colors.surface2,
  },
  tabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  tabLabelWithCloseButton: {
    paddingRight: 0,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabCloseButton: {
    width: 18,
    height: 18,
    marginLeft: 0,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  tabCloseButtonShown: {
    opacity: 1,
  },
  tabCloseButtonHidden: {
    opacity: 0,
  },
  tabCloseButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
