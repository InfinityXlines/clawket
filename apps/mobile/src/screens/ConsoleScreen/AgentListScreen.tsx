import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Bot,
  ChevronRight,
  Clock3,
  FolderKanban,
  History,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from 'lucide-react-native';
import { useFocusEffect, useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Card,
  EmptyState,
  HeaderActionButton,
  LoadingState,
  SearchInput,
  createListContentStyle,
} from '../../components/ui';
import { CreateAgentModal } from '../../components/agents/CreateAgentModal';
import { useTranslation } from 'react-i18next';
import { useAppContext } from '../../contexts/AppContext';
import { useProPaywall } from '../../contexts/ProPaywallContext';
import { useNativeStackModalHeader } from '../../hooks/useNativeStackModalHeader';
import { analyticsEvents } from '../../services/analytics/events';
import { resolveAgentDisplayName } from '../../services/agent-display-name';
import { enrichAgentsWithIdentity } from '../../services/agent-identity';
import {
  buildBackendSections,
  buildBackendSummaries,
  getAgentStatusTone,
  getBackendLabel,
  getBackendTone,
} from '../../features/backends/backendDisplay';
import { useAppTheme } from '../../theme';
import { FontSize, FontWeight, Radius, Space } from '../../theme/tokens';
import { getDisplayAgentEmoji } from '../../utils/agent-emoji';
import type { AgentCapability, AgentInfo, BackendType } from '../../types/agent';
import type { ConsoleStackParamList } from './ConsoleTab';
import { canAddAgent } from '../../utils/pro';

type AgentListNavigation = NativeStackNavigationProp<ConsoleStackParamList, 'AgentList'>;
type AgentListRoute = RouteProp<ConsoleStackParamList, 'AgentList'>;

/** Module-level set shared with AgentDetailScreen to track pending deletes. */
export const pendingAgentDeletes = new Set<string>();

type BackendFilter = 'all' | BackendType;

const CAPABILITY_ICON_MAP: Record<AgentCapability, React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>> = {
  chat: Bot,
  'file-management': FolderKanban,
  'skill-management': Sparkles,
  'cron-scheduling': Clock3,
  'config-editing': SlidersHorizontal,
  'session-history': History,
};

export function AgentListScreen(): React.JSX.Element {
  const { gateway, currentAgentId, setAgents } = useAppContext();
  const { theme } = useAppTheme();
  const { t } = useTranslation('console');
  const { isPro, showPaywall } = useProPaywall();
  const navigation = useNavigation<AgentListNavigation>();
  const route = useRoute<AgentListRoute>();
  const styles = useMemo(() => createStyles(theme.colors), [theme]);

  const [agents, setLocalAgents] = useState<AgentInfo[]>([]);
  const [mainKey, setMainKey] = useState('main');
  const [loading, setLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [backendFilter, setBackendFilter] = useState<BackendFilter>('all');
  const [createVisible, setCreateVisible] = useState(false);

  const openCreateModal = useCallback((source: string) => {
    if (!canAddAgent(agents.length, isPro)) {
      showPaywall('agents');
      return;
    }
    analyticsEvents.agentCreateStarted({ source });
    setCreateVisible(true);
  }, [agents.length, isPro, showPaywall]);

  const headerRight = useMemo(
    () => (
      <HeaderActionButton
        icon={Plus}
        onPress={() => {
          openCreateModal('agent_header');
        }}
        size={22}
      />
    ),
    [openCreateModal],
  );

  useNativeStackModalHeader({
    navigation,
    title: t('common:Agents'),
    rightContent: headerRight,
    onClose: () => navigation.goBack(),
  });

  const pendingDeleteIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (route.params?.openCreate) {
      openCreateModal('agent_route_param');
      navigation.setParams({ openCreate: undefined });
    }
  }, [navigation, openCreateModal, route.params?.openCreate]);

  useFocusEffect(
    useCallback(() => {
      if (pendingAgentDeletes.size === 0) return;
      for (const id of pendingAgentDeletes) {
        pendingDeleteIdsRef.current.add(id);
      }
      pendingAgentDeletes.clear();
      setLocalAgents(prev => prev.filter(agent => !pendingDeleteIdsRef.current.has(agent.id)));
    }, []),
  );

  const loadAgents = useCallback(async (mode: 'initial' | 'refresh' | 'background' = 'initial') => {
    if (mode === 'initial') setLoading(true);
    if (mode === 'refresh') setRefreshing(true);

    try {
      const result = await gateway.listAgents();
      const serverIds = new Set(result.agents.map(agent => agent.id));
      for (const id of pendingDeleteIdsRef.current) {
        if (!serverIds.has(id)) pendingDeleteIdsRef.current.delete(id);
      }
      const filtered = pendingDeleteIdsRef.current.size > 0
        ? result.agents.filter(agent => !pendingDeleteIdsRef.current.has(agent.id))
        : result.agents;
      const enriched = await enrichAgentsWithIdentity(gateway, filtered);
      setLocalAgents(enriched);
      setMainKey(result.mainKey);
      setAgents(enriched);
      setHasLoadedOnce(true);
    } catch {
      // Empty state covers load failures here.
    } finally {
      if (mode === 'initial') setLoading(false);
      if (mode === 'refresh') setRefreshing(false);
    }
  }, [gateway, setAgents]);

  useFocusEffect(
    useCallback(() => {
      loadAgents(hasLoadedOnce ? 'background' : 'initial').catch(() => {});
    }, [hasLoadedOnce, loadAgents]),
  );

  const backendSummaries = useMemo(
    () => buildBackendSummaries(agents),
    [agents],
  );

  const connectedBackends = useMemo(
    () => backendSummaries.filter((backend) => backend.count > 0).length,
    [backendSummaries],
  );

  const visibleBackendFilters = useMemo(
    () => backendSummaries.filter((backend) => backend.count > 0),
    [backendSummaries],
  );

  const filteredAgents = useMemo(() => {
    const candidates = backendFilter === 'all'
      ? agents
      : agents.filter((agent) => agent.backend === backendFilter);
    const query = searchQuery.trim().toLowerCase();
    if (!query) return candidates;
    return candidates.filter((agent) => {
      const searchText = [
        resolveAgentDisplayName(agent),
        agent.id,
        agent.model,
        agent.backend ? getBackendLabel(agent.backend) : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();
      return searchText.includes(query);
    });
  }, [agents, backendFilter, searchQuery]);

  const sections = useMemo(
    () => buildBackendSections(filteredAgents, currentAgentId),
    [currentAgentId, filteredAgents],
  );

  const renderCapabilityPreview = useCallback((capabilities: AgentCapability[] | undefined) => {
    const preview = capabilities?.slice(0, 3) ?? [];
    if (!preview.length) return null;
    return (
      <View style={styles.capabilityRow}>
        {preview.map((capability) => {
          const Icon = CAPABILITY_ICON_MAP[capability] ?? Wrench;
          return (
            <View key={capability} style={styles.capabilityChip}>
              <Icon size={12} color={theme.colors.textMuted} strokeWidth={2} />
            </View>
          );
        })}
      </View>
    );
  }, [styles.capabilityChip, styles.capabilityRow, theme.colors.textMuted]);

  const renderSectionHeader = useCallback(({ section }: { section: (typeof sections)[number] }) => {
    const tone = getBackendTone(section.backend, theme.colors);
    return (
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          <Text style={styles.sectionMeta}>{t('{{count}} agents', { count: section.count })}</Text>
        </View>
        <View style={[styles.backendChip, { backgroundColor: tone.background }]}>
          <Text style={[styles.backendChipText, { color: tone.foreground }]}>{section.title}</Text>
        </View>
      </View>
    );
  }, [styles.backendChip, styles.backendChipText, styles.sectionHeader, styles.sectionMeta, styles.sectionTitle, t, theme.colors]);

  const renderItem = useCallback(({ item }: { item: AgentInfo }) => {
    const isCurrent = item.id === currentAgentId;
    const isMain = item.id === mainKey;
    const displayName = resolveAgentDisplayName(item) ?? item.id;
    const emoji = getDisplayAgentEmoji(item.identity?.emoji);
    const tone = getBackendTone(item.backend, theme.colors);
    const statusColor = getAgentStatusTone(item.status, theme.colors);

    return (
      <Card
        style={[
          styles.card,
          isCurrent && styles.cardCurrent,
        ]}
        onPress={() => navigation.navigate('AgentDetail', { agentId: item.id })}
      >
        <View style={styles.cardRow}>
          <View style={[styles.avatarWrap, isCurrent && styles.avatarWrapCurrent]}>
            <Text style={styles.cardEmoji}>{emoji}</Text>
          </View>

          <View style={styles.cardTextWrap}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle} numberOfLines={1}>{displayName}</Text>
              <View style={[styles.backendChip, { backgroundColor: tone.background }]}>
                <Text style={[styles.backendChipText, { color: tone.foreground }]}>
                  {item.backend ? getBackendLabel(item.backend) : 'Agent'}
                </Text>
              </View>
            </View>
            <Text style={styles.cardSubtitle} numberOfLines={1}>{item.id}</Text>
            <View style={styles.metaRow}>
              {item.model ? (
                <View style={styles.modelChip}>
                  <Text style={styles.modelChipText} numberOfLines={1}>{item.model}</Text>
                </View>
              ) : null}
              {renderCapabilityPreview(item.capabilities)}
            </View>
          </View>

          <View style={styles.cardRight}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            {isCurrent ? (
              <View style={styles.activeBadge}>
                <Text style={styles.activeBadgeText}>{t('Active')}</Text>
              </View>
            ) : null}
            {isMain ? (
              <View style={styles.defaultBadge}>
                <Text style={styles.defaultBadgeText}>{t('Default')}</Text>
              </View>
            ) : null}
            <ChevronRight size={16} color={theme.colors.textSubtle} strokeWidth={2} />
          </View>
        </View>
      </Card>
    );
  }, [
    currentAgentId,
    mainKey,
    navigation,
    renderCapabilityPreview,
    styles.activeBadge,
    styles.activeBadgeText,
    styles.avatarWrap,
    styles.avatarWrapCurrent,
    styles.backendChip,
    styles.backendChipText,
    styles.card,
    styles.cardCurrent,
    styles.cardEmoji,
    styles.cardRight,
    styles.cardRow,
    styles.cardSubtitle,
    styles.cardTextWrap,
    styles.cardTitle,
    styles.cardTitleRow,
    styles.defaultBadge,
    styles.defaultBadgeText,
    styles.metaRow,
    styles.modelChip,
    styles.modelChipText,
    styles.statusDot,
    t,
    theme.colors,
  ]);

  const listHeader = useMemo(() => (
    <View style={styles.listHeader}>
      <View style={styles.heroCard}>
        <Text style={styles.heroEyebrow}>
          {t('{{healthy}}/{{total}} backends live', {
            healthy: connectedBackends,
            total: backendSummaries.length,
          })}
        </Text>
        <Text style={styles.heroTitle}>{t('{{count}} agents in one control surface', { count: agents.length })}</Text>
        <View style={styles.metricRow}>
          <View style={styles.metricCard}>
            <Text style={styles.metricLabel}>{t('Total agents')}</Text>
            <Text style={styles.metricValue}>{agents.length}</Text>
          </View>
          <View style={styles.metricCard}>
            <Text style={styles.metricLabel}>{t('Connected backends')}</Text>
            <Text style={styles.metricValue}>{connectedBackends}</Text>
          </View>
        </View>
        <SearchInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder={t('Search agents or backends...')}
          style={styles.search}
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: backendFilter === 'all' }}
            onPress={() => setBackendFilter('all')}
            style={[
              styles.filterChip,
              backendFilter === 'all' && styles.filterChipActive,
            ]}
          >
            <Text
              style={[
                styles.filterChipText,
                backendFilter === 'all' && styles.filterChipTextActive,
              ]}
            >
              {t('All backends')}
            </Text>
          </Pressable>
          {visibleBackendFilters.map((backend) => {
            const selected = backendFilter === backend.backend;
            const tone = getBackendTone(backend.backend, theme.colors);
            return (
              <Pressable
                key={backend.backend}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => setBackendFilter(backend.backend)}
                style={[
                  styles.filterChip,
                  selected && styles.filterChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    selected && styles.filterChipTextActive,
                  ]}
                >
                  {backend.title}
                </Text>
                <View
                  style={[
                    styles.filterCountChip,
                    { backgroundColor: selected ? `${theme.colors.primaryText}26` : tone.background },
                  ]}
                >
                  <Text
                    style={[
                      styles.filterCountText,
                      { color: selected ? theme.colors.primaryText : tone.foreground },
                    ]}
                  >
                    {backend.count}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </View>
  ), [
    agents.length,
    backendFilter,
    backendSummaries.length,
    connectedBackends,
    searchQuery,
    styles.filterChip,
    styles.filterChipActive,
    styles.filterChipText,
    styles.filterChipTextActive,
    styles.filterCountChip,
    styles.filterCountText,
    styles.filterRow,
    styles.heroCard,
    styles.heroEyebrow,
    styles.heroTitle,
    styles.listHeader,
    styles.metricCard,
    styles.metricLabel,
    styles.metricRow,
    styles.metricValue,
    styles.search,
    t,
    theme.colors,
    visibleBackendFilters,
  ]);

  return (
    <View style={styles.root}>
      {loading ? (
        <LoadingState message={t('Loading agents...')} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={[styles.content, { flexGrow: 1 }]}
          ListHeaderComponent={listHeader}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadAgents('refresh')}
              tintColor={theme.colors.primary}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="🤖"
              title={searchQuery.trim() ? t('No agents match your search') : t('No agents found')}
            />
          }
        />
      )}

      <CreateAgentModal
        visible={createVisible}
        onClose={() => setCreateVisible(false)}
        onCreated={() => loadAgents('background')}
      />
    </View>
  );
}

function createStyles(colors: ReturnType<typeof import('../../theme').useAppTheme>['theme']['colors']) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
    },
    content: {
      ...createListContentStyle({ grow: true, bottom: Space.xxxl }),
    },
    listHeader: {
      paddingTop: Space.sm,
      paddingBottom: Space.lg,
    },
    heroCard: {
      backgroundColor: colors.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: Space.lg,
      gap: Space.md,
    },
    heroEyebrow: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.semibold,
      color: colors.primary,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    heroTitle: {
      fontSize: FontSize.xxl,
      fontWeight: FontWeight.bold,
      color: colors.text,
      lineHeight: 28,
    },
    metricRow: {
      flexDirection: 'row',
      gap: Space.sm,
    },
    metricCard: {
      flex: 1,
      backgroundColor: colors.surfaceMuted,
      borderRadius: Radius.lg,
      paddingHorizontal: Space.md,
      paddingVertical: Space.md - 2,
      gap: Space.xs,
    },
    metricLabel: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      color: colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.7,
    },
    metricValue: {
      fontSize: FontSize.xl,
      fontWeight: FontWeight.bold,
      color: colors.text,
    },
    search: {
      marginTop: Space.xs,
    },
    filterRow: {
      alignItems: 'center',
      gap: Space.sm,
      paddingTop: Space.xs,
      paddingRight: Space.xs,
    },
    filterChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Space.xs,
      borderRadius: Radius.full,
      backgroundColor: colors.surfaceMuted,
      paddingHorizontal: Space.md,
      paddingVertical: Space.sm + 1,
    },
    filterChipActive: {
      backgroundColor: colors.primary,
    },
    filterChipText: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.semibold,
      color: colors.text,
    },
    filterChipTextActive: {
      color: colors.primaryText,
    },
    filterCountChip: {
      minWidth: 22,
      height: 22,
      borderRadius: Radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: Space.xs,
    },
    filterCountText: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
    },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: Space.sm,
      marginTop: Space.md,
    },
    sectionTitle: {
      fontSize: FontSize.lg,
      fontWeight: FontWeight.bold,
      color: colors.text,
    },
    sectionMeta: {
      fontSize: FontSize.sm,
      color: colors.textMuted,
      marginTop: 2,
    },
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.lg,
      marginBottom: Space.md - 2,
      backgroundColor: colors.surface,
    },
    cardCurrent: {
      borderColor: colors.primary,
      backgroundColor: colors.primarySoft,
    },
    cardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Space.md,
    },
    avatarWrap: {
      width: 44,
      height: 44,
      borderRadius: Radius.md,
      backgroundColor: colors.surfaceMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarWrapCurrent: {
      backgroundColor: colors.primary,
    },
    cardEmoji: {
      fontSize: 24,
    },
    cardTextWrap: {
      flex: 1,
      minWidth: 0,
    },
    cardTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: Space.sm,
    },
    cardTitle: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.bold,
      color: colors.text,
      flexShrink: 1,
    },
    cardSubtitle: {
      fontSize: FontSize.sm,
      color: colors.textMuted,
      marginTop: 2,
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: Space.sm,
      marginTop: Space.sm,
    },
    backendChip: {
      borderRadius: Radius.full,
      paddingHorizontal: Space.sm + 2,
      paddingVertical: 4,
    },
    backendChipText: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
    },
    modelChip: {
      borderRadius: Radius.full,
      backgroundColor: colors.surfaceMuted,
      paddingHorizontal: Space.sm + 2,
      paddingVertical: 4,
      maxWidth: 170,
    },
    modelChipText: {
      fontSize: FontSize.xs,
      color: colors.textMuted,
      fontWeight: FontWeight.semibold,
    },
    capabilityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Space.xs,
    },
    capabilityChip: {
      width: 22,
      height: 22,
      borderRadius: Radius.full,
      backgroundColor: colors.surfaceMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardRight: {
      alignItems: 'flex-end',
      gap: Space.sm,
    },
    statusDot: {
      width: 10,
      height: 10,
      borderRadius: Radius.full,
    },
    activeBadge: {
      backgroundColor: `${colors.success}1A`,
      borderRadius: Radius.full,
      paddingHorizontal: Space.sm + 2,
      paddingVertical: 4,
    },
    activeBadgeText: {
      color: colors.success,
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
    },
    defaultBadge: {
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.surfaceMuted,
      paddingHorizontal: Space.sm + 2,
      paddingVertical: 4,
    },
    defaultBadgeText: {
      color: colors.textMuted,
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
    },
  });
}
