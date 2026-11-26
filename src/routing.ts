import { createLocalizer } from './i18n';
import * as vscode from 'vscode';

const CODEX_EDITOR = 'chatgpt.conversationEditor';
const OPEN_TIMEOUT_MS = 8_000;

/** Open the official Codex editor through the current workbench's editor service. */
export async function openInCodex(id: string, signal?: AbortSignal): Promise<void> {
  const t = createLocalizer(vscode.env.language);
  if (!/^[a-z0-9_-]{8,128}$/i.test(id)) throw new Error(t('errorInvalidId'));
  signal?.throwIfAborted();
  const official = vscode.extensions.getExtension('openai.chatgpt');
  if (!official) throw new Error(t('errorEnableOfficial'));
  const editors: unknown = official.packageJSON?.contributes?.customEditors;
  if (!Array.isArray(editors) || !editors.some(editor => editor?.viewType === CODEX_EDITOR)) {
    throw new Error(t('errorEditorUnavailable'));
  }

  const deadline = new AbortController();
  const cancellation = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timeout = setTimeout(() => deadline.abort(new Error(t('errorOpenTimeout'))), OPEN_TIMEOUT_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(cancellation.reason);
      cancellation.addEventListener('abort', abort, { once: true });
      const open = async () => {
        try {
          await official.activate();
          cancellation.throwIfAborted();
          // The official custom editor consumes this resource directly in the invoking window.
          const resource = vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: `/local/${id}` });
          await vscode.commands.executeCommand('vscode.openWith', resource, CODEX_EDITOR, {
            viewColumn: vscode.ViewColumn.Active,
            preview: true,
          });
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
  }
}
