import { createLocalizer } from './i18n';
import * as vscode from 'vscode';

const CODEX_EDITOR = 'chatgpt.conversationEditor';
const OPEN_TIMEOUT_MS = 8_000;
export type CodexOpenTarget = 'sidebar' | 'editor';

export async function openInCodex(
  id: string, { target = 'sidebar', signal }: { target?: CodexOpenTarget; signal?: AbortSignal } = {},
): Promise<void> {
  const t = createLocalizer(vscode.env.language);
  if (!/^[a-z0-9_-]{8,128}$/i.test(id)) throw new Error(t('errorInvalidId'));
  signal?.throwIfAborted();
  const official = vscode.extensions.getExtension('openai.chatgpt');
  if (!official) throw new Error(t('errorEnableOfficial'));
  const editors: unknown = official.packageJSON?.contributes?.customEditors;
  if (target === 'editor' && (!Array.isArray(editors) || !editors.some(editor => editor?.viewType === CODEX_EDITOR))) {
    throw new Error(t('errorEditorUnavailable'));
  }
  if (target === 'sidebar' && !vscode.window.state.focused) throw new Error(t('errorSidebarFocus'));

  const deadline = new AbortController();
  const cancellation = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timeout = setTimeout(() => deadline.abort(new Error(t('errorOpenTimeout'))), OPEN_TIMEOUT_MS);
  const focus = target === 'sidebar' ? vscode.window.onDidChangeWindowState(state => {
    if (!state.focused) deadline.abort(new Error(t('errorSidebarFocus')));
  }) : undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(cancellation.reason);
      cancellation.addEventListener('abort', abort, { once: true });
      const open = async () => {
        try {
          await official.activate();
          cancellation.throwIfAborted();
          const path = `/local/${id}`;
          if (target === 'sidebar') {
            if (!vscode.window.state.focused) deadline.abort(new Error(t('errorSidebarFocus')));
            cancellation.throwIfAborted();
            focus?.dispose();
            // A windowId can match a different window with the same numeric prefix.
            const resource = vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: official.id, path });
            await vscode.commands.executeCommand('vscode.open', resource);
          } else {
            const resource = vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path });
            await vscode.commands.executeCommand('vscode.openWith', resource, CODEX_EDITOR, {
              viewColumn: vscode.ViewColumn.Active,
              preview: true,
            });
          }
          resolve();
        } catch {
          reject(cancellation.aborted ? cancellation.reason : new Error(t('errorOpenFailed')));
        } finally {
          cancellation.removeEventListener('abort', abort);
        }
      };
      void open();
    });
  } finally {
    clearTimeout(timeout);
    focus?.dispose();
  }
}
