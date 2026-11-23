import { beforeEach, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({
  extensions: { getExtension: vi.fn<(id: string) => { activate: () => Promise<void> } | undefined>() },
  commands: { executeCommand: vi.fn<(command: string, uri?: Record<string, string>) => Promise<void>>() },
  Uri: { from: vi.fn<(value: Record<string, string>) => Record<string, string>>() },
  env: {
    language: 'en', uriScheme: 'vscode',
    asExternalUri: vi.fn<(uri: Record<string, string>) => Promise<Record<string, string>>>(),
    openExternal: vi.fn<(uri: Record<string, string>) => Promise<boolean>>(),
  },
}));
vi.mock('vscode', () => api);
import { openInCodex } from '../src/routing';

const resolved = { scheme: 'vscode', authority: 'openai.chatgpt', path: '/local/thread-0001', query: 'windowId=7' };
const activate = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  api.env.language = 'en'; api.env.uriScheme = 'vscode';
  api.extensions.getExtension.mockReturnValue({ activate });
  api.commands.executeCommand.mockResolvedValue(undefined);
  api.Uri.from.mockImplementation(value => value);
  api.env.asExternalUri.mockResolvedValue(resolved);
  api.env.openExternal.mockResolvedValue(true);
});

test('sidebar route reveals Codex and forwards the current-window URI without an editor tab', async () => {
  await openInCodex('thread-0001');
  expect(api.extensions.getExtension).toHaveBeenCalledWith('openai.chatgpt');
  expect(activate).toHaveBeenCalledOnce();
  expect(api.env.asExternalUri).toHaveBeenCalledWith({ scheme: 'vscode', authority: 'openai.chatgpt', path: '/local/thread-0001' });
  expect(api.commands.executeCommand).toHaveBeenCalledExactlyOnceWith('vscode.open', resolved);
  expect(api.env.openExternal).not.toHaveBeenCalled();
});

test('sidebar routing uses the running editor scheme and rejects failed routing', async () => {
  api.env.uriScheme = 'vscode-insiders';
  const insiders = { ...resolved, scheme: 'vscode-insiders' };
  api.env.asExternalUri.mockResolvedValueOnce(insiders);
  await openInCodex('thread-0001');
  expect(api.env.asExternalUri).toHaveBeenCalledWith(expect.objectContaining({ scheme: 'vscode-insiders' }));
  expect(api.commands.executeCommand).toHaveBeenCalledExactlyOnceWith('vscode.open', insiders);
  api.env.asExternalUri.mockResolvedValueOnce({ ...insiders, query: '' });
  await expect(openInCodex('thread-0001')).rejects.toThrow(/did not accept/);
  expect(api.commands.executeCommand).toHaveBeenCalledOnce();
});

test('invalid IDs and a missing official extension cause no navigation', async () => {
  await expect(openInCodex('../wrong-id')).rejects.toThrow(/format is invalid/);
  expect(api.extensions.getExtension).not.toHaveBeenCalled();
  api.extensions.getExtension.mockReturnValue(undefined);
  await expect(openInCodex('thread-0001')).rejects.toThrow(/Enable the official/);
  expect(api.commands.executeCommand).not.toHaveBeenCalled();
  expect(api.env.openExternal).not.toHaveBeenCalled();
});

test('routing errors follow the VS Code display language', async () => {
  api.env.language = 'zh-cn';
  api.env.asExternalUri.mockResolvedValueOnce({ ...resolved, scheme: 'https' });
  await expect(openInCodex('thread-0001')).rejects.toThrow(/未接受/);
});
