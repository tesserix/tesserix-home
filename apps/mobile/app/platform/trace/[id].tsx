// Trace detail — spans for one distributed trace, indented by parent depth.
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTrace } from '../../../lib/platform-hooks';
import type { TraceSpan } from '../../../lib/platform-contracts';
import { formatMs } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, EmptyState, LoadingRows, StatusDot, type Tone,
} from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

// Duration nanoseconds -> milliseconds (CH may serialize the number as a string).
function ms(ns: number | string): number {
  return Number(ns) / 1_000_000;
}

// depth of each span = length of its parent chain within this trace.
function computeDepths(spans: TraceSpan[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const depth = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    const s = byId.get(id);
    if (!s || !s.parentId || !byId.has(s.parentId) || seen.has(id)) {
      depth.set(id, 0);
      return 0;
    }
    seen.add(id);
    const d = resolve(s.parentId, seen) + 1;
    depth.set(id, d);
    return d;
  };
  spans.forEach((s) => resolve(s.spanId, new Set()));
  return depth;
}

export default function TraceDetail() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useTrace(id ?? '');
  const spans = q.data?.spans ?? [];
  const depths = computeDepths(spans);

  return (
    <Screen>
      <ScreenHeader
        title="Trace"
        subtitle={id ? `${id.slice(0, 16)}…` : undefined}
        right={<BackButton onPress={() => router.back()} />}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : spans.length === 0 ? (
        <Card>
          <EmptyState title="No spans" body={q.isError ? 'Could not load this trace.' : 'This trace has no spans.'} />
        </Card>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 8 }}>
          {spans.map((s) => {
            const d = depths.get(s.spanId) ?? 0;
            const tone: Tone = s.status === 'Error' ? 'danger' : 'success';
            return (
              <View key={s.spanId} style={{ marginLeft: Math.min(d, 8) * 14 }}>
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <StatusDot tone={tone} />
                    <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>
                      {s.op}
                    </Text>
                    <Text style={[text.mono, { color: p.mutedForeground }]}>{formatMs(ms(s.durationNs))}</Text>
                  </View>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>
                    {s.service}{s.kind ? ` · ${s.kind}` : ''}
                  </Text>
                </Card>
              </View>
            );
          })}
        </ScrollView>
      )}
    </Screen>
  );
}
