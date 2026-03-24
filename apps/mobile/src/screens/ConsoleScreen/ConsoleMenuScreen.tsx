import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, Share2 } from 'lucide-react-native';
import { Animated, Easing, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useIsFocused, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../../theme';
import { FontSize, FontWeight, Radius, Space } from '../../theme/tokens';
import { IconButton } from '../../components/ui';
import { useAppContext } from '../../contexts/AppContext';
import { useConnectionState } from '../../hooks/useConnectionState';
import { logAppTelemetry } from '../../services/app-telemetry';
import { analyticsEvents } from '../../services/analytics/events';
import { readAgentAvatar } from '../../services/agent-avatar';
import { StorageService } from '../../services/storage';
import { formatConsoleHeartbeatAge } from '../../utils/console-heartbeat';
import { parseGatewayRuntimeSettings } from '../../utils/gateway-settings';
import { getConsoleHeaderRefreshState } from './hooks/consoleHeaderRefreshPolicy';
import { StatsPosterModal } from './StatsPosterModal';
import type { ConsoleStackParamList } from './ConsoleTab';
import { isCronJobForAgent } from './cronData';

type ConsoleMenuNavigation = NativeStackNavigationProp<ConsoleStackParamList, 'ConsoleMenu'>;

// ---- Types ----

export type DashboardData = {
  agentName: string;
  agentEmoji: string;
  cost: string | null;
  tokens: string | null;
  agents: number | null;
  channels: number | null;
  cronTotal: number | null;
  cronFailed: number | null;
  skills: number | null;
  tools: number | null;
  models: number | null;
  sessions: number | null;
  files: number | null;
  messages: number | null;
  userMessages: number | null;
  toolCalls: number | null;
  lastHeartbeat: string | null;
  nodes: number | null;
  nodeSummary: string | null;
  nodeCounts: NodeSummary | null;
  pendingPairCount: number | null;
  devices: number | null;
  configDefaultModel: string | null;
  configHeartbeat: string | null;
  configActiveHours: string | null;
};

// ---- Helpers ----

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function getTodayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function classifyNodePlatform(node: { platform?: string; deviceFamily?: string }): 'mobile' | 'desktop' {
  const family = (node.deviceFamily ?? '').toLowerCase();
  if (family === 'iphone' || family === 'ipad' || family === 'android') return 'mobile';
  if (family === 'mac' || family === 'linux' || family === 'windows') return 'desktop';

  const platform = (node.platform ?? '').toLowerCase();
  if (platform.startsWith('ios') || platform.startsWith('ipados') || platform.startsWith('android')) return 'mobile';
  return 'desktop';
}

type NodeSummary = { mobile: number; desktop: number; total: number };

function summarizeNodes(nodes: { platform?: string; deviceFamily?: string }[]): NodeSummary {
  let mobile = 0;
  let desktop = 0;
  for (const node of nodes) {
    if (classifyNodePlatform(node) === 'mobile') mobile++;
    else desktop++;
  }
  return { mobile, desktop, total: nodes.length };
}

function formatNodeSummary(nodes: { platform?: string; deviceFamily?: string }[]): string {
  if (nodes.length === 0) return '0';
  const { mobile, desktop } = summarizeNodes(nodes);
  if (mobile > 0 && desktop > 0) return `${mobile}📱 ${desktop}💻`;
  if (mobile > 0) return `${mobile} 📱`;
  if (desktop > 0) return `${desktop} 💻`;
  return String(nodes.length);
}

function isSessionInAgentScope(sessionKey: string | undefined, currentAgentId: string): boolean {
  if (!sessionKey) return false;
  return sessionKey.startsWith(`agent:${currentAgentId}:`);
}

function normalizeCacheScopePart(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase());
}

function resolveDashboardCacheScope(config: { url?: string; relay?: { gatewayId?: string } } | null, agentId: string): string | null {
  const normalizedAgentId = agentId.trim() || 'main';
  const relayGatewayId = config?.relay?.gatewayId?.trim();
  if (relayGatewayId) {
    return `relay:${normalizeCacheScopePart(relayGatewayId)}:agent:${normalizeCacheScopePart(normalizedAgentId)}`;
  }
  const url = config?.url?.trim();
  if (!url) return null;
  return `url:${normalizeCacheScopePart(url.replace(/\/+$/, ''))}:agent:${normalizeCacheScopePart(normalizedAgentId)}`;
}

function formatRelativeSnapshotAge(savedAt: number, now: number, t: ReturnType<typeof useTranslation<'console'>>['t']): string {
  const diffMs = Math.max(0, now - savedAt);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return t('just now');
  if (mins < 60) return t('{{count}}m ago', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('{{count}}h ago', { count: hours });
  const days = Math.floor(hours / 24);
  return t('{{count}}d ago', { count: days });
}

// ---- Dashboard Hook ----

const EMPTY_DASHBOARD: DashboardData = {
  agentName: 'Hello?', agentEmoji: '🤖', cost: null, tokens: null,
  messages: null, userMessages: null, toolCalls: null, lastHeartbeat: null,
  agents: null, channels: null, cronTotal: null, cronFailed: null,
  skills: null, tools: null, models: null, sessions: null, files: null,
  nodes: null, nodeSummary: null, nodeCounts: null, pendingPairCount: null, devices: null,
  configDefaultModel: null, configHeartbeat: null, configActiveHours: null,
};

function useDashboardData() {
  const { gateway, gatewayEpoch, foregroundEpoch, currentAgentId, config } = useAppContext();
  const { t, i18n } = useTranslation('console');
  const isFocused = useIsFocused();
  const hasGateway = config != null;
  const cacheScope = useMemo(() => resolveDashboardCacheScope(config, currentAgentId), [config, currentAgentId]);
  const [data, setData] = useState<DashboardData>({
    ...EMPTY_DASHBOARD,
    agentName: hasGateway ? t('Connecting') : t('Hello?'),
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const lastForegroundRefreshRef = useRef(0);
  const lastForegroundEpochRef = useRef<number>(foregroundEpoch);
  const refreshSequenceRef = useRef(0);
  const refreshInFlightRef = useRef(0);
  const latestDataRef = useRef(data);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [hydratedFromCache, setHydratedFromCache] = useState(false);
  const [lastRefreshError, setLastRefreshError] = useState<string | null>(null);

  useEffect(() => {
    latestDataRef.current = data;
  }, [data]);

  useEffect(() => {
    let mounted = true;
    setHydratedFromCache(false);
    setLastUpdatedAt(null);
    setLastRefreshError(null);

    if (!cacheScope) {
      setData({
        ...EMPTY_DASHBOARD,
        agentName: hasGateway ? t('Connecting') : t('Hello?'),
      });
      setLoading(false);
      return () => {
        mounted = false;
      };
    }

    setLoading(true);
    StorageService.getDashboardCache<DashboardData>(cacheScope)
      .then((cached) => {
        if (!mounted || !cached) return;
        setData((prev) => ({
          ...prev,
          ...cached.data,
          agentName: cached.data.agentName || prev.agentName,
          agentEmoji: cached.data.agentEmoji || prev.agentEmoji,
        }));
        setLastUpdatedAt(cached.savedAt > 0 ? cached.savedAt : null);
        setHydratedFromCache(true);
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [cacheScope, hasGateway, t]);

  const refresh = useCallback(async (reason: 'focus' | 'foreground' | 'pull_to_refresh' | 'manual' = 'manual') => {
    const refreshId = ++refreshSequenceRef.current;
    const startedAt = Date.now();
    const currentData = latestDataRef.current;
    const hadVisibleData = currentData.cost !== null
      || currentData.agents !== null
      || currentData.cronTotal !== null
      || currentData.nodes !== null;
    logAppTelemetry('console_dashboard', 'refresh_start', {
      refreshId,
      reason,
      currentAgentId,
      hasGatewayConfig: hasGateway,
      connectionState: gateway.getConnectionState(),
      hadVisibleData,
    });
    refreshInFlightRef.current += 1;
    setRefreshing(true);
    setLastRefreshError(null);
    if (!gateway) {
      setData({
        ...EMPTY_DASHBOARD,
        agentName: hasGateway ? t('Connecting') : t('Hello?'),
      });
      setLoading(false);
      logAppTelemetry('console_dashboard', 'refresh_end', {
        refreshId,
        reason,
        currentAgentId,
        durationMs: Date.now() - startedAt,
        connectionState: 'disconnected',
        hasVisibleData: false,
      });
      return;
    }

    try {
      if (!hadVisibleData) setLoading(true);
      const today = getTodayDateStr();
      const [ackedIds, settledResults] = await Promise.all([
        StorageService.getAckedCronFailures(),
        Promise.allSettled([
          gateway.fetchIdentity(currentAgentId),
          gateway.listAgentFiles(currentAgentId),
          gateway.getChannelsStatus(),
          gateway.listCronJobs(),
          gateway.getSkillsStatus(currentAgentId),
          gateway.request('models.list', {}),
          gateway.listSessions(),
          gateway.fetchUsage({ startDate: today, endDate: today }),
          gateway.request('last-heartbeat', {}),
          gateway.fetchCostSummary({ startDate: today, endDate: today }),
          gateway.listAgents(),
          gateway.listNodes(),
          gateway.listNodePairRequests(),
          gateway.listDevices(),
          gateway.getConfig(),
          gateway.fetchToolsCatalog(currentAgentId),
        ]),
      ]);

      const [identityResult, fileResult, channelResult, cronResult, skillResult, modelResult, sessionResult, usageResult, heartbeatResult, costResult, agentsResult, nodesResult, nodePairResult, devicesResult, configResult, toolCatalogResult] = settledResults;

      const hasUsageData = usageResult.status === 'fulfilled' && Array.isArray(usageResult.value?.sessions);
      const usageSessionsForAgent = hasUsageData
        ? (usageResult.value.sessions ?? []).filter((session) => isSessionInAgentScope(session.key, currentAgentId))
        : [];
      const usageTotals = hasUsageData
        ? usageSessionsForAgent.reduce(
            (acc, session) => {
              acc.totalCost += session.usage?.totalCost ?? 0;
              acc.totalTokens += session.usage?.totalTokens ?? 0;
              acc.messages += session.usage?.messageCounts?.total ?? 0;
              acc.userMessages += session.usage?.messageCounts?.user ?? 0;
              acc.toolCalls += session.usage?.messageCounts?.toolCalls ?? 0;
              return acc;
            },
            { totalCost: 0, totalTokens: 0, messages: 0, userMessages: 0, toolCalls: 0 },
          )
        : null;
      const hasCronData = cronResult.status === 'fulfilled' && Array.isArray(cronResult.value?.jobs);
      const jobsForAgent = hasCronData
        ? cronResult.value.jobs.filter((job) => isCronJobForAgent(job, currentAgentId))
        : [];
      const hasSessionData = sessionResult.status === 'fulfilled' && Array.isArray(sessionResult.value);
      const sessionsForAgent = hasSessionData
        ? sessionResult.value.filter((session) => isSessionInAgentScope(session.key, currentAgentId))
        : [];

      const nextData: DashboardData = {
        agentName: identityResult.status === 'fulfilled' && identityResult.value?.name
          ? identityResult.value.name
          : hasGateway ? t('Connecting') : t('Hello?'),
        agentEmoji: identityResult.status === 'fulfilled' && identityResult.value?.emoji
          ? identityResult.value.emoji
          : '🤖',
        cost: (() => {
          if (costResult.status === 'fulfilled' && costResult.value?.totals?.totalCost != null) return formatCost(costResult.value.totals.totalCost);
          if (usageTotals) return formatCost(usageTotals.totalCost);
          return null;
        })(),
        tokens: (() => {
          if (costResult.status === 'fulfilled' && costResult.value?.totals?.totalTokens != null) return formatTokens(costResult.value.totals.totalTokens);
          if (usageTotals) return formatTokens(usageTotals.totalTokens);
          return null;
        })(),
        agents: agentsResult.status === 'fulfilled' && Array.isArray(agentsResult.value?.agents) ? agentsResult.value.agents.length : null,
        channels: channelResult.status === 'fulfilled' && channelResult.value?.channelOrder ? channelResult.value.channelOrder.length : null,
        cronTotal: hasCronData ? jobsForAgent.length : null,
        cronFailed: hasCronData ? jobsForAgent.filter((job) => job.state?.lastRunStatus === 'error' && !ackedIds.has(job.id)).length : null,
        skills: skillResult.status === 'fulfilled' && skillResult.value?.skills ? Object.keys(skillResult.value.skills).length : null,
        tools: toolCatalogResult.status === 'fulfilled' && Array.isArray(toolCatalogResult.value?.groups)
          ? toolCatalogResult.value.groups.reduce((sum, g) => sum + (g.tools?.length ?? 0), 0)
          : null,
        files: fileResult.status === 'fulfilled' && Array.isArray(fileResult.value) ? fileResult.value.length : null,
        models: modelResult.status === 'fulfilled' && Array.isArray((modelResult.value as any)?.models) ? (modelResult.value as any).models.length : null,
        sessions: hasSessionData ? sessionsForAgent.length : null,
        lastHeartbeat: (() => {
          if (heartbeatResult.status !== 'fulfilled' || !heartbeatResult.value) return null;
          const hb = heartbeatResult.value as any;
          const ts = hb.lastHeartbeatAt || hb.ts || hb.timestamp;
          if (!ts) return null;
          const mins = Math.floor((Date.now() - ts) / 60_000);
          const formatted = formatConsoleHeartbeatAge(mins, i18n.resolvedLanguage ?? i18n.language ?? 'en');
          if (formatted.compactText) return formatted.compactText;
          if (formatted.count == null) return t(formatted.key);
          return t(formatted.key, { count: formatted.count });
        })(),
        messages: usageTotals?.messages ?? null,
        userMessages: usageTotals?.userMessages ?? null,
        toolCalls: usageTotals?.toolCalls ?? null,
        nodes: nodesResult.status === 'fulfilled' && Array.isArray(nodesResult.value?.nodes) ? nodesResult.value.nodes.length : null,
        nodeSummary: nodesResult.status === 'fulfilled' && Array.isArray(nodesResult.value?.nodes) ? formatNodeSummary(nodesResult.value.nodes) : null,
        nodeCounts: nodesResult.status === 'fulfilled' && Array.isArray(nodesResult.value?.nodes) ? summarizeNodes(nodesResult.value.nodes) : null,
        pendingPairCount: (() => {
          const nodePending = nodePairResult.status === 'fulfilled' ? (nodePairResult.value?.pending?.length ?? 0) : 0;
          const devicePending = devicesResult.status === 'fulfilled' ? (devicesResult.value?.pending?.length ?? 0) : 0;
          const total = nodePending + devicePending;
          return total > 0 ? total : null;
        })(),
        devices: devicesResult.status === 'fulfilled' && Array.isArray(devicesResult.value?.paired) ? devicesResult.value.paired.length : null,
        ...(() => {
          if (configResult.status !== 'fulfilled' || !configResult.value?.config) {
            return { configDefaultModel: null, configHeartbeat: null, configActiveHours: null };
          }
          const parsed = parseGatewayRuntimeSettings(configResult.value.config);
          return {
            configDefaultModel: parsed.defaultModel || null,
            configHeartbeat: parsed.heartbeatEvery || null,
            configActiveHours: parsed.heartbeatActiveStart && parsed.heartbeatActiveEnd
              ? `${parsed.heartbeatActiveStart}–${parsed.heartbeatActiveEnd}`
              : null,
          };
        })(),
      };

      const hasAnyData = nextData.cost !== null || nextData.agents !== null || nextData.cronTotal !== null || nextData.nodes !== null;
      if (hasAnyData) {
        setData(nextData);
        const savedAt = Date.now();
        setLastUpdatedAt(savedAt);
        setHydratedFromCache(false);
        if (cacheScope) {
          void StorageService.setDashboardCache(cacheScope, {
            version: 2,
            cacheKey: cacheScope,
            savedAt,
            source: 'network',
            connectionStateAtSave: gateway.getConnectionState(),
            data: nextData,
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load dashboard';
      setLastRefreshError(message);
    } finally {
      refreshInFlightRef.current = Math.max(0, refreshInFlightRef.current - 1);
      setRefreshing(refreshInFlightRef.current > 0);
      setLoading(false);
      const nextData = latestDataRef.current;
      const nextHadVisibleData = nextData.cost !== null
        || nextData.agents !== null
        || nextData.cronTotal !== null
        || nextData.nodes !== null;
      logAppTelemetry('console_dashboard', 'refresh_end', {
        refreshId,
        reason,
        currentAgentId,
        durationMs: Date.now() - startedAt,
        connectionState: gateway.getConnectionState(),
        hasVisibleData: nextHadVisibleData,
      });
    }
  }, [cacheScope, currentAgentId, gateway, hasGateway, t]);

  useEffect(() => {
    refresh('manual').catch(() => {});
  }, [gatewayEpoch, refresh]);

  useFocusEffect(useCallback(() => { refresh('focus').catch(() => {}); }, [refresh]));

  useEffect(() => {
    if (!isFocused) return;
    if (lastForegroundEpochRef.current === foregroundEpoch) return;
    lastForegroundEpochRef.current = foregroundEpoch;
    const now = Date.now();
    if (now - lastForegroundRefreshRef.current < 2000) return;
    lastForegroundRefreshRef.current = now;
    refresh('foreground').catch(() => {});
  }, [foregroundEpoch, isFocused, refresh]);

  return { data, loading, refresh, refreshing, lastUpdatedAt, hydratedFromCache, lastRefreshError };
}

// ---- Components ----

function HeroCard({ label, value, onPress, colors, badge }: {
  label: string;
  value: React.ReactNode;
  onPress: () => void;
  colors: any;
  badge?: string | null;
}) {
  return (
    <TouchableOpacity
      style={[styles.heroCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.heroHeader}>
        <Text style={[styles.heroValue, { color: colors.text }]}>{value}</Text>
        <ChevronRight size={16} color={colors.textSubtle} strokeWidth={2} />
      </View>
      <View style={styles.heroLabelRow}>
        <Text style={[styles.heroLabel, { color: colors.textMuted }]}>{label}</Text>
        {badge ? <Text style={[styles.heroBadge, { color: colors.warning }]}>{badge}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

function GridCard({ emoji, value, label, onPress, colors, badge }: {
  emoji: string;
  value: React.ReactNode;
  label: string;
  onPress: () => void;
  colors: any;
  badge?: { text: string; color: string } | null;
}) {
  return (
    <TouchableOpacity
      style={[styles.gridCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.gridTop}>
        <Text style={styles.gridEmoji}>{emoji}</Text>
        {badge ? (
          <Text style={[styles.gridBadge, { color: badge.color }]}>{badge.text}</Text>
        ) : (
          <ChevronRight size={14} color={colors.textSubtle} strokeWidth={2} />
        )}
      </View>
      {typeof value === 'string'
        ? <Text style={[styles.gridValue, { color: colors.text }]}>{value}</Text>
        : <View style={styles.gridValueRow}>{value}</View>}
      <Text style={[styles.gridLabel, { color: colors.textMuted }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ---- Main Screen ----

export function ConsoleMenuScreen(): React.JSX.Element {
  const { theme } = useAppTheme();
  const { t, i18n } = useTranslation('console');
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<ConsoleMenuNavigation>();
  const { config, gateway, currentAgentId, agents, agentAvatars } = useAppContext();
  const { data, refresh, refreshing, lastUpdatedAt, hydratedFromCache, lastRefreshError } = useDashboardData();
  const connectionState = useConnectionState();
  const colors = theme.colors;
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const refreshSpin = useRef(new Animated.Value(0)).current;

  const handlePullToRefresh = useCallback(async () => {
    setPullRefreshing(true);
    try {
      await refresh('pull_to_refresh');
    } finally {
      setPullRefreshing(false);
    }
  }, [refresh]);
  const handleHeaderRefresh = useCallback(() => {
    void (async () => {
      if (connectionState !== 'ready') {
        const ok = await gateway.probeConnection();
        if (!ok) return;
      }
      await refresh('manual');
    })();
  }, [connectionState, gateway, refresh]);
  const [posterVisible, setPosterVisible] = useState(false);
  const posterAvatarUri = useMemo(() => {
    const agent = agents.find((a) => a.id === currentAgentId);
    const localAvatar = readAgentAvatar(agentAvatars, agent);
    if (localAvatar) return localAvatar;
    const remoteAvatar = agent?.identity?.avatar;
    if (!remoteAvatar) return undefined;
    const base = gateway.getBaseUrl();
    if (remoteAvatar.startsWith('data:') || remoteAvatar.startsWith('http')) return remoteAvatar;
    if (remoteAvatar.startsWith('/') && base) return `${base}${remoteAvatar}`;
    return undefined;
  }, [agents, currentAgentId, agentAvatars, gateway]);
  const headerRefreshState = useMemo(
    () => getConsoleHeaderRefreshState({ config, connectionState, refreshing }),
    [config, connectionState, refreshing],
  );
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const monthLabel = useMemo(
    () => new Date().toLocaleDateString(locale, { month: 'short' }).toUpperCase(),
    [locale],
  );
  const snapshotStatusLabel = useMemo(() => {
    if (!lastUpdatedAt) {
      if (lastRefreshError && connectionState !== 'ready') return t('Offline');
      return null;
    }
    const ageLabel = formatRelativeSnapshotAge(lastUpdatedAt, Date.now(), t);
    if (connectionState !== 'ready') {
      return hydratedFromCache
        ? t('Offline · Showing last snapshot ({{age}})', { age: ageLabel })
        : t('Offline · Updated {{age}}', { age: ageLabel });
    }
    if (refreshing) {
      return t('Refreshing · Updated {{age}}', { age: ageLabel });
    }
    return t('Updated {{age}}', { age: ageLabel });
  }, [connectionState, hydratedFromCache, lastRefreshError, lastUpdatedAt, refreshing, t]);
  const refreshIconStyle = useMemo(
    () => ({
      transform: [
        {
          rotate: refreshSpin.interpolate({
            inputRange: [0, 1],
            outputRange: ['0deg', '360deg'],
          }),
        },
      ],
    }),
    [refreshSpin],
  );

  useEffect(() => {
    if (!headerRefreshState.spinning) {
      refreshSpin.stopAnimation();
      refreshSpin.setValue(0);
      return;
    }

    refreshSpin.setValue(0);
    const spinLoop = Animated.loop(
      Animated.timing(refreshSpin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    spinLoop.start();

    return () => {
      spinLoop.stop();
      refreshSpin.stopAnimation();
      refreshSpin.setValue(0);
    };
  }, [headerRefreshState.spinning, refreshSpin]);

  const nav = useCallback((screen: keyof ConsoleStackParamList, source: string) => {
    analyticsEvents.consoleEntryTapped({
      destination: screen,
      source,
    });
    navigation.navigate(screen as any);
  }, [navigation]);
  const useCompactHeartbeatStat = locale === 'es'
    || locale.startsWith('es-')
    || locale === 'de'
    || locale.startsWith('de-');

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Text style={styles.headerEmoji}>{data.agentEmoji}</Text>
        <View style={styles.headerInfo}>
          <View style={styles.headerNameRow}>
            <Text style={[styles.headerName, { color: colors.text }]}>{data.agentName}</Text>
            <View style={[styles.statusDot, { backgroundColor: connectionState === 'ready' ? colors.success : connectionState === 'pairing_pending' ? colors.warning : colors.warning }]} />
          </View>
          {snapshotStatusLabel ? (
            <Text style={[styles.headerMeta, { color: connectionState === 'ready' ? colors.textMuted : colors.warning }]}>
              {snapshotStatusLabel}
            </Text>
          ) : null}
        </View>
        <IconButton
          icon={(
            <Animated.View style={headerRefreshState.spinning ? refreshIconStyle : undefined}>
              <RefreshCw size={20} color={colors.textMuted} strokeWidth={2} />
            </Animated.View>
          )}
          onPress={handleHeaderRefresh}
          disabled={headerRefreshState.disabled}
        />
        <IconButton
          icon={<Share2 size={20} color={colors.textMuted} strokeWidth={2} />}
          onPress={() => setPosterVisible(true)}
        />
        <View style={styles.headerDate}>
          <Text style={[styles.headerDateDay, { color: colors.text }]}>{String(new Date().getDate())}</Text>
          <Text style={[styles.headerDateMonth, { color: colors.textMuted }]}>{monthLabel}</Text>
        </View>
      </View>

      <StatsPosterModal
        visible={posterVisible}
        onClose={() => setPosterVisible(false)}
        data={data}
        agentAvatarUri={posterAvatarUri}
      />

      {/* Stats grid */}
      <View style={styles.statsGrid}>
        <TouchableOpacity style={styles.statItem} onPress={() => nav('Usage', 'stats_tokens')} activeOpacity={0.6}>
          <Text style={styles.statEmoji}>{'🌀'}</Text>
          <Text style={[styles.statValue, { color: colors.text }]}>{data.tokens ?? '—'}</Text>
          <Text style={[styles.statLabel, { color: colors.textMuted }]}>{t('Tokens')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.statItem} onPress={() => nav('ChatHistory', 'stats_messages')} activeOpacity={0.6}>
          <Text style={styles.statEmoji}>{'💬'}</Text>
          <Text style={[styles.statValue, { color: colors.text }]}>{data.messages != null ? String(data.messages) : '—'}</Text>
          <Text style={[styles.statLabel, { color: colors.textMuted }]}>{t('Messages')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.statItem} onPress={() => nav('ToolList', 'stats_tools')} activeOpacity={0.6}>
          <Text style={styles.statEmoji}>{'🔧'}</Text>
          <Text style={[styles.statValue, { color: colors.text }]}>{data.toolCalls != null ? String(data.toolCalls) : '—'}</Text>
          <Text style={[styles.statLabel, { color: colors.textMuted }]}>{t('Tools')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.statItem} onPress={() => nav('SessionsBoard', 'stats_sessions')} activeOpacity={0.6}>
          <Text style={styles.statEmoji}>{'🗂️'}</Text>
          <Text style={[styles.statValue, { color: colors.text }]}>{data.sessions != null ? String(data.sessions) : '—'}</Text>
          <Text style={[styles.statLabel, { color: colors.textMuted }]}>{t('Sessions')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.statItem} onPress={() => nav('HeartbeatSettings', 'stats_heartbeat')} activeOpacity={0.6}>
          <Text style={styles.statEmoji}>{'💓'}</Text>
          <Text
            style={[styles.statValue, { color: colors.text }, useCompactHeartbeatStat && styles.statValueCompact]}
            numberOfLines={useCompactHeartbeatStat ? 1 : undefined}
            adjustsFontSizeToFit={useCompactHeartbeatStat}
            minimumFontScale={useCompactHeartbeatStat ? 0.85 : undefined}
          >
            {data.lastHeartbeat ?? '—'}
          </Text>
          <Text style={[styles.statLabel, { color: colors.textMuted }]}>{t('Heartbeat')}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={handlePullToRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {/* Hero Row: Cost + Nodes */}
        <View style={styles.heroRow}>
          <HeroCard
            label={t('Cost Today')}
            value={'$' + (data.cost ?? ' —')}
            onPress={() => nav('Usage', 'hero_cost_today')}
            colors={colors}
          />
          <HeroCard
            label={t('Cron Jobs')}
            value={<>{data.cronTotal != null ? String(data.cronTotal) : '—'} <Text style={styles.heroIcon}>⏰</Text></>}
            onPress={() => nav('CronList', 'hero_cron_jobs')}
            colors={colors}
            badge={data.cronFailed ? `⚠ ${t('{{count}} failed', { count: data.cronFailed })}` : null}
          />
        </View>

        {/* Grid: 3×2 */}
        <View style={styles.gridRow}>
          <GridCard
            emoji="🤖"
            value={data.agents ? String(data.agents) : '—'}
            label={t('common:Agents')}
            onPress={() => nav('AgentList', 'grid_agents')}
            colors={colors}
          />
          <GridCard
            emoji="🧬"
            value={data.files != null ? String(data.files) : '—'}
            label={t('Memory')}
            onPress={() => nav('FileList', 'grid_memory')}
            colors={colors}
          />
          <GridCard
            emoji="🌐"
            value={data.nodeCounts ? (
              <>
                {data.nodeCounts.mobile > 0 && (
                  <>
                    <Text style={[styles.gridValue, { color: colors.text }]}>{data.nodeCounts.mobile}</Text>
                    <Text style={styles.nodeDeviceIcon}>📱</Text>
                  </>
                )}
                {data.nodeCounts.mobile > 0 && data.nodeCounts.desktop > 0 && <Text style={styles.nodeDeviceSpacer}>{' '}</Text>}
                {data.nodeCounts.desktop > 0 && (
                  <>
                    <Text style={[styles.gridValue, { color: colors.text }]}>{data.nodeCounts.desktop}</Text>
                    <Text style={styles.nodeDeviceIcon}>💻</Text>
                  </>
                )}
                {data.nodeCounts.total === 0 && <Text style={[styles.gridValue, { color: colors.text }]}>0</Text>}
              </>
            ) : '—'}
            label={t('Nodes')}
            onPress={() => nav('Nodes', 'grid_nodes')}
            colors={colors}
            badge={data.pendingPairCount ? { text: t('{{count}} pending', { count: data.pendingPairCount }), color: colors.warning } : null}
          />
        </View>

        <View style={styles.gridRow}>
          <GridCard
            emoji="🧩"
            value={data.models != null ? String(data.models) : '—'}
            label={t('Models')}
            onPress={() => nav('ModelList', 'grid_models')}
            colors={colors}
          />
          <GridCard
            emoji="⚡"
            value={data.skills != null ? String(data.skills) : '—'}
            label={t('Skills')}
            onPress={() => nav('SkillList', 'grid_skills')}
            colors={colors}
          />
          <GridCard
            emoji="🔧"
            value={data.tools != null ? String(data.tools) : '—'}
            label={t('Tools')}
            onPress={() => nav('ToolList', 'grid_tools')}
            colors={colors}
          />
        </View>

        {/* List items */}
        <View style={styles.listSection}>
          <TouchableOpacity style={[styles.listItem, { borderColor: colors.border }]} onPress={() => nav('Channels', 'list_channels')} activeOpacity={0.7}>
            <Text style={styles.listEmoji}>{'🔗'}</Text>
            <View style={styles.listText}>
              <Text style={[styles.listTitle, { color: colors.text }]}>{t('Channels')}</Text>
              <Text style={[styles.listDesc, { color: colors.textMuted }]}>{t('Manage channel connections')}</Text>
            </View>
            <ChevronRight size={16} color={colors.textSubtle} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.listItem, { borderColor: colors.border }]} onPress={() => nav('Devices', 'list_devices')} activeOpacity={0.7}>
            <Text style={styles.listEmoji}>{'📱'}</Text>
            <View style={styles.listText}>
              <Text style={[styles.listTitle, { color: colors.text }]}>{t('Devices')}</Text>
              <Text style={[styles.listDesc, { color: colors.textMuted }]}>{t('Manage paired devices')}</Text>
            </View>
            <ChevronRight size={16} color={colors.textSubtle} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.listItem, { borderColor: colors.border }]}
            onPress={() => {
              nav('Logs', 'list_logs');
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.listEmoji}>{'🔍'}</Text>
            <View style={styles.listText}>
              <Text style={[styles.listTitle, { color: colors.text }]}>{t('Logs')}</Text>
              <Text style={[styles.listDesc, { color: colors.textMuted }]}>{t('View gateway and agent logs')}</Text>
            </View>
            <ChevronRight size={16} color={colors.textSubtle} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.listItem, { borderColor: colors.border }]} onPress={() => nav('ClawHub', 'list_clawhub')} activeOpacity={0.7}>
            <Text style={styles.listEmoji}>{'🦞'}</Text>
            <View style={styles.listText}>
              <Text style={[styles.listTitle, { color: colors.text }]}>{t('ClawHub')}</Text>
              <Text style={[styles.listDesc, { color: colors.textMuted }]}>{t('Browse and install community skills')}</Text>
            </View>
            <ChevronRight size={16} color={colors.textSubtle} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.listItem, { borderBottomWidth: 0 }]} onPress={() => nav('Docs', 'list_docs')} activeOpacity={0.7}>
            <Text style={styles.listEmoji}>{'📖'}</Text>
            <View style={styles.listText}>
              <Text style={[styles.listTitle, { color: colors.text }]}>{t('Documentation')}</Text>
              <Text style={[styles.listDesc, { color: colors.textMuted }]}>{t('OpenClaw protocol docs')}</Text>
            </View>
            <ChevronRight size={16} color={colors.textSubtle} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

// ---- Styles ----

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: Space.lg,
    marginTop: Space.lg,
    marginBottom: Space.lg,
    marginRight: Space.lg,
  },
  headerEmoji: {
    fontSize: 36,
    marginRight: Space.md - 2,
  },
  headerInfo: {
    flex: 1,
  },
  headerNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  headerName: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
  },
  headerMeta: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
    marginTop: 2,
  },
  title: {
    fontSize: Space.xl,
    fontWeight: FontWeight.bold,
    marginLeft: Space.lg,
    marginTop: Space.lg,
    marginBottom: Space.md,
  },
  content: {
    paddingHorizontal: Space.lg,
    paddingBottom: Space.xxxl,
  },
  headerDate: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    marginLeft: Space.xs,
  },
  headerDateDay: {
    fontSize: 20,
    fontWeight: FontWeight.bold,
    lineHeight: 22,
  },
  headerDateMonth: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    letterSpacing: 0.5,
  },
  // Stats grid
  statsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: Space.lg,
    marginBottom: Space.lg,
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statEmoji: {
    fontSize: 20,
    marginBottom: 4,
  },
  statValue: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },
  statValueCompact: {
    fontSize: FontSize.md,
  },
  statLabel: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  // Hero cards
  heroRow: {
    flexDirection: 'row',
    gap: Space.sm + 2,
    marginBottom: Space.sm + 2,
  },
  heroCard: {
    flex: 1,
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Space.lg,
    paddingVertical: Space.lg + 4,
  },
  heroHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  heroValue: {
    fontSize: 28,
    fontWeight: FontWeight.bold,
    marginBottom: 4,
  },
  heroIcon: {
    fontSize: 26,
  },
  heroLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  heroLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
  heroBadge: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
  },
  // Grid cards
  gridRow: {
    flexDirection: 'row',
    gap: Space.sm + 2,
    marginBottom: Space.sm + 2,
  },
  gridCard: {
    flex: 1,
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Space.md,
    minHeight: 90,
  },
  gridTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Space.xs,
  },
  gridEmoji: {
    fontSize: 20,
  },
  gridBadge: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
  },
  gridValue: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
    marginBottom: 2,
  },
  gridValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  nodeDeviceIcon: {
    fontSize: 16,
  },
  nodeDeviceSpacer: {
    width: 4,
  },
  gridLabel: {
    fontSize: FontSize.xs + 1,
    fontWeight: FontWeight.medium,
  },
  // List items
  listSection: {},
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  listEmoji: {
    fontSize: 20,
    width: 32,
    textAlign: 'center',
  },
  listText: {
    flex: 1,
    marginLeft: Space.sm,
  },
  listTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  listDesc: {
    fontSize: FontSize.sm,
    marginTop: 2,
  },
});
