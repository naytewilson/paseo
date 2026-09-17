import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { ScanEye, TriangleAlert } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SieveLensUpdate } from "@getpaseo/client";
import { SieveLensClient } from "@getpaseo/client";
import type { SieveObservation, SieveStatusSnapshot } from "@getpaseo/protocol/messages";
import { useEarliestOnlineHostServerId } from "@/app/_layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  describeUnavailableReason,
  formatMode,
  formatObservation,
  resolveSieveLensRenderState,
} from "./sieve-lens-view";

// ---------------------------------------------------------------------------
// SIEVE Lens — read-only operator view of the SIEVE data plane.
//
// The daemon carries no SIEVE objects today; until an upstream feed attaches,
// every reachable state here is the typed `unavailable` disposition. The
// feature gate is `server_info.features.sieveLens` — older daemons render the
// update-host state, never a fallback emulation.
// ---------------------------------------------------------------------------

const ThemedScanEye = withUnistyles(ScanEye);
const ThemedTriangleAlert = withUnistyles(TriangleAlert);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

export function SieveLensScreen() {
  const workspaceSelection = useLastWorkspaceSelection();
  const earliestOnlineServerId = useEarliestOnlineHostServerId();
  const serverId = workspaceSelection?.serverId ?? earliestOnlineServerId;
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const serverInfo = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.serverInfo ?? null) : null,
  );
  const [update, setUpdate] = useState<SieveLensUpdate | null>(null);

  const featureAdvertised = serverInfo?.features?.sieveLens;

  const lens = useMemo(
    () => (client && featureAdvertised === true ? new SieveLensClient(client) : null),
    [client, featureAdvertised],
  );

  useEffect(() => {
    if (!lens || !isConnected) return;
    const unsubscribeUpdates = lens.onUpdate(setUpdate);
    void lens.setSubscribed(true).catch(() => {});
    return () => {
      unsubscribeUpdates();
      void lens.setSubscribed(false).catch(() => {});
      lens.dispose();
      setUpdate(null);
    };
  }, [lens, isConnected]);

  const renderState = resolveSieveLensRenderState({
    serverId,
    isConnected,
    featureAdvertised,
    update,
  });

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <ThemedScanEye size={ICON_SIZE.md} uniProps={foregroundMutedColorMapping} />
        <Text style={styles.title}>SIEVE Lens</Text>
      </View>
      {renderState.kind === "no_host" && (
        <Notice text="No host is selected. Open a workspace to choose which daemon to inspect." />
      )}
      {renderState.kind === "gate_update_host" && (
        <Notice text="This daemon does not advertise the SIEVE Lens surface. Update the host daemon to v0.8.0 or newer." />
      )}
      {renderState.kind === "connecting" && <Notice text="Connecting to daemon…" />}
      {renderState.kind === "status" && <StatusBody update={renderState.update} />}
    </ScrollView>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function StatusBody({ update }: { update: SieveLensUpdate }) {
  const { status } = update;
  return (
    <View style={styles.card}>
      <Row label="State" value={status.state} />
      <Row label="Observed" value={update.observedAt} />
      {status.state === "unavailable" && (
        <View style={styles.banner}>
          <ThemedTriangleAlert size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />
          <Text style={styles.bannerText}>{describeUnavailableReason(status)}</Text>
        </View>
      )}
      {status.state === "degraded" && (
        <View style={styles.banner}>
          <ThemedTriangleAlert size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />
          <Text style={styles.bannerText}>
            {status.staleSince
              ? `Showing last known state — stale since ${status.staleSince}.`
              : "Showing last known state."}
            {status.detail ? ` ${status.detail}` : ""}
          </Text>
        </View>
      )}
      {(status.state === "ok" || status.state === "degraded") && status.snapshot && (
        <SnapshotRows snapshot={status.snapshot} />
      )}
    </View>
  );
}

interface SnapshotRow {
  label: string;
  value: string;
}

// Rows exist only for fields the feed actually reported — absent fields render
// as absent rows, never as zeroed counters.
function collectSnapshotRows(snapshot: SieveStatusSnapshot): SnapshotRow[] {
  const scalars: Array<[string, string | undefined]> = [
    ["Mode", snapshot.mode && formatMode(snapshot.mode)],
    ["Health", snapshot.health],
    ["Run", snapshot.run?.runId],
    ["Session", snapshot.run?.sessionId],
    ["Agent", snapshot.run?.agentId],
    ["Node", snapshot.run?.nodeId],
  ];
  const observations: Array<[string, SieveObservation | undefined]> = [
    ["Pristine tokens", snapshot.savings?.pristineTokens],
    ["Presented tokens", snapshot.savings?.presentedTokens],
    ["Saved tokens", snapshot.savings?.savedTokens],
    ["Savings", snapshot.savings?.savedRatio],
    ["Prefix retained", snapshot.cache?.prefixRetainedRatio],
    ["Divergences", snapshot.cache?.divergences],
    ["Overhead", snapshot.overhead],
    ["Integrity faults", snapshot.integrityFaults],
  ];
  const rows: SnapshotRow[] = [];
  for (const [label, value] of scalars) {
    if (value) rows.push({ label, value });
  }
  for (const [label, observation] of observations) {
    if (observation) rows.push({ label, value: formatObservation(observation) });
  }
  if (snapshot.fallback) {
    rows.push({
      label: "Fallback",
      value: snapshot.fallback.reason
        ? `${formatMode(snapshot.fallback.state)} — ${snapshot.fallback.reason}`
        : formatMode(snapshot.fallback.state),
    });
  }
  return rows;
}

function SnapshotRows({ snapshot }: { snapshot: SieveStatusSnapshot }) {
  return (
    <>
      {collectSnapshotRows(snapshot).map((row) => (
        <Row key={row.label} label={row.label} value={row.value} />
      ))}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
  },
  notice: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  noticeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  card: {
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[3],
  },
  rowLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    textAlign: "right",
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  bannerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));
