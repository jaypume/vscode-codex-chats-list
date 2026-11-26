import { beforeEach, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({
  extensions: { getExtension: vi.fn<(id: string) => { id: string; activate: () => Promise<void>; packageJSON?: unknown } | undefined>() },
  commands: { executeCommand: vi.fn<(command: string, ...args: unknown[]) => Promise<void>>() },
  Uri: { from: vi.fn<(value: Record<string, string>) => Record<string, string>>() },
  ViewColumn: { Active: -1 },
  window: {
    state: { focused: true },
    onDidChangeWindowState: vi.fn<(listener: (state: { focused: boolean }) => void) => { dispose: () => void }>(),
  },
  env: {
    language: 'en', uriScheme: 'vscode',
    asExternalUri: vi.fn<(uri: Record<string, string>) => Promise<Record<string, string>>>(),
    openExternal: vi.fn<(uri: Record<string, string>) => Promise<boolean>>(),
  },
}));
vi.mock('vscode', () => api);
import { openInCodex } from '../src/routing';

const resource = { scheme: 'openai-codex', authority: 'route', path: '/local/thread-0001' };
const packageJSON = { contributes: { customEditors: [{ viewType: 'chatgpt.conversationEditor' }] } };
const activate = vi.fn(async () => {});
const official = { id: 'openai.chatgpt', activate, packageJSON };

beforeEach(() => {
  vi.clearAllMocks();
  api.env.language = 'en'; api.env.uriScheme = 'vscode';
  api.window.state.focused = true;
  api.window.onDidChangeWindowState.mockReturnValue({ dispose() {} });
  activate.mockReset().mockResolvedValue(undefined);
  api.extensions.getExtension.mockReturnValue(official);
  api.commands.executeCommand.mockResolvedValue(undefined);
  api.Uri.from.mockImplementation(value => value);
});

test('opens the official Codex editor through the active workbench group', async () => {
  api.window.state.focused = false;
  await openInCodex('thread-0001', { target: 'editor' });
  expect(api.extensions.getExtension).toHaveBeenCalledWith('openai.chatgpt');
  expect(activate).toHaveBeenCalledOnce();
  expect(api.commands.executeCommand).toHaveBeenCalledExactlyOnceWith(
    'vscode.openWith', resource, 'chatgpt.conversationEditor', { viewColumn: -1, preview: true },
  );
  expect(api.env.asExternalUri).not.toHaveBeenCalled();
  expect(api.env.openExternal).not.toHaveBeenCalled();
  expect(api.window.onDidChangeWindowState).not.toHaveBeenCalled();
});

test('default opens the focused window Codex sidebar without a numeric window ID', async () => {
  api.env.uriScheme = 'vscode-insiders';
  api.extensions.getExtension.mockReturnValue({ id: official.id, activate });
  await openInCodex('thread-0001');
  expect(api.commands.executeCommand).toHaveBeenCalledExactlyOnceWith('vscode.open', {
    scheme: 'vscode-insiders', authority: 'openai.chatgpt', path: '/local/thread-0001',
  });
  expect(api.env.asExternalUri).not.toHaveBeenCalled();
  expect(api.env.openExternal).not.toHaveBeenCalled();
});

test('routing reports a failed editor handoff', async () => {
  api.commands.executeCommand.mockRejectedValueOnce(new Error('editor resolution failed'));
  await expect(openInCodex('thread-0001', { target: 'editor' })).rejects.toThrow(/Could not open/);
  expect(api.Uri.from).toHaveBeenCalledExactlyOnceWith(resource);
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
  api.extensions.getExtension.mockReturnValue({ id: official.id, activate });
  await expect(openInCodex('thread-0001', { target: 'editor' })).rejects.toThrow(/未提供会话编辑页/);
  expect(activate).not.toHaveBeenCalled();
  expect(api.commands.executeCommand).not.toHaveBeenCalled();
});

test('activation that outlives the opening deadline cannot open a late editor', async () => {
  vi.useFakeTimers();
  try {
    let finishActivation!: () => void;
    activate.mockImplementationOnce(() => new Promise(resolve => { finishActivation = resolve; }));
    const failed = expect(openInCodex('thread-0001')).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(8_000);
    await failed;
    finishActivation();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.commands.executeCommand).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('a superseded request cannot dispatch after activation completes', async () => {
  let finishActivation!: () => void;
  activate.mockImplementationOnce(() => new Promise(resolve => { finishActivation = resolve; }));
  const controller = new AbortController();
  const cancelled = expect(openInCodex('thread-0001', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await cancelled;
  finishActivation();
  await openInCodex('thread-0002', { target: 'editor' });
  expect(api.commands.executeCommand).toHaveBeenCalledOnce();
  expect(api.Uri.from).toHaveBeenCalledExactlyOnceWith({ ...resource, path: '/local/thread-0002' });
});

test('sidebar requests from an unfocused window stop before activation', async () => {
  api.window.state.focused = false;
  await expect(openInCodex('thread-0001')).rejects.toThrow(/Return to this VS Code window/);
  expect(activate).not.toHaveBeenCalled();
  expect(api.commands.executeCommand).not.toHaveBeenCalled();
});

test('a sidebar request cannot reach another window after focus changes during activation', async () => {
  let finishActivation!: () => void;
  activate.mockImplementationOnce(() => new Promise(resolve => { finishActivation = resolve; }));
  const failed = expect(openInCodex('thread-0001')).rejects.toThrow(/Return to this VS Code window/);
  api.window.onDidChangeWindowState.mock.calls[0]![0]({ focused: false });
  await failed;
  finishActivation();
  await Promise.resolve();
  expect(api.commands.executeCommand).not.toHaveBeenCalled();
});
