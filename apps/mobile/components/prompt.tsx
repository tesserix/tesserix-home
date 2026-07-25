// prompt.tsx — an imperative confirm/prompt over a single app-level Modal, the
// native twin of the web `useConfirm` (confirm-dialog). Mount <PromptProvider>
// once above the navigator; call useConfirm().confirm / .prompt from any screen.
import {
  createContext, useCallback, useContext, useMemo, useState, type ReactNode,
} from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { radius, space, text, usePalette } from '../lib/theme';
import { Button } from './kit';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'destructive';
}
export interface PromptOptions extends ConfirmOptions {
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  required?: boolean;
  minLength?: number;
  numeric?: boolean;
}

interface PromptApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}
interface Pending {
  kind: 'confirm' | 'prompt';
  opts: PromptOptions;
  resolve: (v: boolean | string | null) => void;
}

const Ctx = createContext<PromptApi | null>(null);

export function useConfirm(): PromptApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useConfirm must be used within <PromptProvider>');
  return api;
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const p = usePalette();
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setValue('');
        setError(null);
        setPending({ kind: 'confirm', opts, resolve: resolve as Pending['resolve'] });
      }),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.defaultValue ?? '');
        setError(null);
        setPending({ kind: 'prompt', opts, resolve: resolve as Pending['resolve'] });
      }),
    [],
  );
  const api = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);

  function close(result: boolean | string | null) {
    pending?.resolve(result);
    setPending(null);
    setValue('');
    setError(null);
  }
  function onCancel() {
    if (pending) close(pending.kind === 'confirm' ? false : null);
  }
  function onConfirm() {
    if (!pending) return;
    if (pending.kind === 'confirm') {
      close(true);
      return;
    }
    const o = pending.opts;
    const trimmed = value.trim();
    if (o.required && trimmed.length === 0) return setError('This field is required.');
    if (o.minLength && trimmed.length < o.minLength)
      return setError(`Enter at least ${o.minLength} characters.`);
    if (o.numeric && !/^\d+$/.test(trimmed)) return setError('Enter a number.');
    close(trimmed);
  }

  const o = pending?.opts;
  const destructive = o?.tone === 'destructive';

  return (
    <Ctx.Provider value={api}>
      {children}
      <Modal visible={!!pending} transparent animationType="fade" onRequestClose={onCancel}>
        <Pressable style={styles.backdrop} onPress={onCancel}>
          <Pressable
            style={[styles.sheet, { backgroundColor: p.elevated, borderColor: p.border }]}
            onPress={() => {}}
          >
            {o ? (
              <>
                <Text style={[text.title, { color: p.foreground }]}>{o.title}</Text>
                {o.message ? (
                  <Text style={[text.body, { color: p.mutedForeground, marginTop: 6 }]}>{o.message}</Text>
                ) : null}
                {pending?.kind === 'prompt' ? (
                  <>
                    {o.label ? (
                      <Text style={[text.label, { color: p.foreground, marginTop: 14, marginBottom: 6 }]}>
                        {o.label}
                      </Text>
                    ) : null}
                    <TextInput
                      value={value}
                      onChangeText={(t) => {
                        setValue(t);
                        if (error) setError(null);
                      }}
                      placeholder={o.placeholder}
                      placeholderTextColor={p.mutedForeground}
                      multiline={o.multiline}
                      keyboardType={o.numeric ? 'number-pad' : 'default'}
                      autoFocus
                      style={[
                        styles.input,
                        o.multiline ? { minHeight: 88 } : null,
                        { borderColor: error ? p.destructive : p.border, color: p.foreground, backgroundColor: p.muted },
                      ]}
                    />
                    {error ? (
                      <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: p.destructive, marginTop: 6 }}>
                        {error}
                      </Text>
                    ) : null}
                  </>
                ) : null}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                  <View style={{ flex: 1 }}>
                    <Button label={o.cancelLabel ?? 'Cancel'} variant="secondary" onPress={onCancel} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      label={o.confirmLabel ?? 'Confirm'}
                      tone={destructive ? 'danger' : 'default'}
                      onPress={onConfirm}
                    />
                  </View>
                </View>
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </Ctx.Provider>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[5],
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space[5],
  },
  input: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: 'InterTight',
    fontSize: 15,
    textAlignVertical: 'top',
  },
});
