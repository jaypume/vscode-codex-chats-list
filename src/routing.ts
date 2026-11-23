import { createLocalizer } from './i18n';
import * as vscode from 'vscode';

/**
 * Resume a conversation in the official Codex sidebar already placed by the user.
 *
 * This adapter uses an existing, undocumented Codex URI route. Keeping it
 * here limits future compatibility changes to one place, without patching Codex.
 */
export async function openInCodex(id: string): Promise<void> {
  const t = createLocalizer(vscode.env.language);
  if (!/^[a-z0-9_-]{8,128}$/i.test(id)) throw new Error(t('errorInvalidId'));
  const official = vscode.extensions.getExtension('openai.chatgpt');
  if (!official) throw new Error(t('errorEnableOfficial'));
  await official.activate();
  const route = vscode.Uri.from({
    scheme: vscode.env.uriScheme, authority: 'openai.chatgpt', path: `/local/${id}`,
  });
  const target = await vscode.env.asExternalUri(route);
  if (target.scheme !== route.scheme || target.authority !== route.authority || target.path !== route.path
    || !/^\d+$/.test(new URLSearchParams(target.query).get('windowId') ?? '')) {
    throw new Error(t('errorRouteRejected'));
  }
  // Use the workbench's URI opener so windowId is resolved inside this VS Code process.
  await vscode.commands.executeCommand('vscode.open', target);
}
