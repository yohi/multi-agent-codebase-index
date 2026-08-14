import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../../src/config/index.js';
import {
  parseServeArgs,
  resolveServeEndpoint,
  runServeCli,
  type ServeCliDependencies,
} from '../../../src/bin/commands/serve.js';
import type { NexusRuntime } from '../../../src/server/index.js';
import type { HttpV2ServerHandle } from '../../../src/server/http-v2/entry.js';
import { createV1RuntimeToolBridge } from '../../../src/server/http-v2/v1-runtime-bridge.js';
import { createTestNexusOptions } from '../../shared/create-test-nexus-options.js';

const collectOutput = (): { readonly stream: PassThrough; readonly text: () => string } => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
};

const createDependencies = (
  output: PassThrough,
  errorOutput: PassThrough,
): ServeCliDependencies => ({
  output,
  errorOutput,
  exit: vi.fn(),
  signalSource: new EventEmitter(),
});

const createRuntimeFixture = async (
  initialize: () => Promise<void>,
  close: () => Promise<void>,
): Promise<NexusRuntime> => {
  const { options } = await createTestNexusOptions();
  return {
    createServer: () => new McpServer({ name: 'serve-test', version: '1.0.0' }),
    orchestrator: options.orchestrator,
    sanitizer: options.sanitizer,
    initialize,
    close,
    reindex: async () => {},
    registrationClient: null,
  };
};

describe('parseServeArgs', () => {
  it('parses serve flags', () => {
    expect(parseServeArgs(['--host', '127.0.0.1', '--port', '9200', '--project-root', 'project'])).toEqual({
      host: '127.0.0.1',
      port: 9200,
      projectRoot: 'project',
      help: false,
    });
  });

  it('defaults optional flags to undefined', () => {
    expect(parseServeArgs([])).toEqual({
      host: undefined,
      port: undefined,
      projectRoot: undefined,
      help: false,
    });
  });
});

describe('resolveServeEndpoint', () => {
  it('prioritizes CLI over config over defaults', async () => {
    const configured = await loadConfig({
      projectRoot: process.cwd(),
      env: { NEXUS_HTTP_HOST: 'localhost', NEXUS_HTTP_PORT: '9230' },
      transportMode: 'v2-http',
    });
    const defaults = await loadConfig({ projectRoot: process.cwd(), env: {}, transportMode: 'v2-http' });

    expect(resolveServeEndpoint(parseServeArgs([]), configured)).toEqual({ host: 'localhost', port: 9230 });
    expect(resolveServeEndpoint(parseServeArgs(['--host', '127.0.0.1', '--port', '9200']), configured)).toEqual({
      host: '127.0.0.1',
      port: 9200,
    });
    expect(resolveServeEndpoint(parseServeArgs([]), defaults)).toEqual({ host: '127.0.0.1', port: 9200 });
  });

  it('rejects non-loopback hosts and invalid ports', async () => {
    const config = await loadConfig({ projectRoot: process.cwd(), env: {}, transportMode: 'v2-http' });

    expect(() => resolveServeEndpoint(parseServeArgs(['--host', '0.0.0.0']), config)).toThrow(/loopback/);
    expect(() => parseServeArgs(['--port', 'abc'])).toThrow(/port/i);
    expect(() => parseServeArgs(['--port', '65536'])).toThrow(/port/i);
  });

  it('normalizes whitespace-padded and bracketed IPv6 loopback hosts', async () => {
    const config = await loadConfig({ projectRoot: process.cwd(), env: {}, transportMode: 'v2-http' });

    expect(resolveServeEndpoint(parseServeArgs(['--host', '  localhost  ']), config)).toEqual({
      host: 'localhost',
      port: 9200,
    });
    expect(resolveServeEndpoint(parseServeArgs(['--host', ' [::1] ']), config)).toEqual({
      host: '::1',
      port: 9200,
    });
  });
});

describe('runServeCli', () => {
  it('prints help and fails closed before runtime construction for a non-loopback host', async () => {
    const helpOutput = collectOutput();
    const helpDependencies = createDependencies(helpOutput.stream, new PassThrough());

    await runServeCli(['--help'], {}, helpDependencies);

    expect(helpOutput.text()).toContain('nexus serve');
    expect(helpDependencies.exit).not.toHaveBeenCalled();

    const errorOutput = collectOutput();
    const failureDependencies = createDependencies(new PassThrough(), errorOutput.stream);
    await runServeCli(['--host', '0.0.0.0'], {}, failureDependencies);

    expect(errorOutput.text()).toMatch(/loopback/);
    expect(failureDependencies.exit).toHaveBeenCalledWith(1);
  });

  it('waits for runtime initialization before listening and only reports ready afterward', async () => {
    const config = await loadConfig({ projectRoot: process.cwd(), env: {}, transportMode: 'v2-http' });
    let resolveInitialization: (() => void) | undefined;
    const initialization = new Promise<void>((resolve) => {
      resolveInitialization = resolve;
    });
    const initialize = vi.fn(() => initialization);
    const close = vi.fn(async () => {});
    const runtime = await createRuntimeFixture(initialize, close);
    let readyAtListen: boolean | undefined;
    const startServer = vi.fn(async (deps): Promise<HttpV2ServerHandle> => {
      readyAtListen = deps.isReady();
      return {
        server: createServer(),
        close: async () => {},
        port: () => 9210,
      };
    });
    const dependencies: ServeCliDependencies = {
      ...createDependencies(new PassThrough(), new PassThrough()),
      loadConfig: async () => config,
      createRuntime: async () => runtime,
      startServer,
    };

    const serving = runServeCli([], {}, dependencies);
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    expect(startServer).not.toHaveBeenCalled();

    if (resolveInitialization === undefined) {
      throw new Error('initialization was not started');
    }
    resolveInitialization();
    await serving;

    expect(startServer).toHaveBeenCalledOnce();
    expect(readyAtListen).toBe(true);
  });

  it('does not listen and closes the runtime when initialization fails', async () => {
    const config = await loadConfig({ projectRoot: process.cwd(), env: {}, transportMode: 'v2-http' });
    const close = vi.fn(async () => {});
    const runtime = await createRuntimeFixture(async () => {
      throw new Error('initialization failed');
    }, close);
    const startServer = vi.fn();
    const dependencies: ServeCliDependencies = {
      ...createDependencies(new PassThrough(), new PassThrough()),
      loadConfig: async () => config,
      createRuntime: async () => runtime,
      startServer,
    };

    await runServeCli([], {}, dependencies);

    expect(startServer).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(dependencies.exit).toHaveBeenCalledWith(1);
  });

  it('runs shutdown cleanup once when both termination signals arrive', async () => {
    const config = await loadConfig({ projectRoot: process.cwd(), env: {}, transportMode: 'v2-http' });
    const runtimeClose = vi.fn(async () => {});
    const runtime = await createRuntimeFixture(async () => {}, runtimeClose);
    const bridge = await createV1RuntimeToolBridge(runtime.createServer());
    const bridgeClose = vi.spyOn(bridge, 'close');
    let resolveServerClose: (() => void) | undefined;
    const serverCloseCompletion = new Promise<void>((resolve) => {
      resolveServerClose = resolve;
    });
    const serverClose = vi.fn(() => serverCloseCompletion);
    const signalSource = new EventEmitter();
    const dependencies: ServeCliDependencies = {
      ...createDependencies(new PassThrough(), new PassThrough()),
      signalSource,
      loadConfig: () => Promise.resolve(config),
      createRuntime: () => Promise.resolve(runtime),
      createToolBridge: () => Promise.resolve(bridge),
      startServer: vi.fn(() =>
        Promise.resolve<HttpV2ServerHandle>({
          server: createServer(),
          close: serverClose,
          port: () => 9210,
        }),
      ),
    };

    await runServeCli([], {}, dependencies);

    signalSource.emit('SIGINT');
    signalSource.emit('SIGTERM');

    expect(serverClose).toHaveBeenCalledOnce();
    expect(bridgeClose).not.toHaveBeenCalled();
    expect(runtimeClose).not.toHaveBeenCalled();
    expect(dependencies.exit).not.toHaveBeenCalled();

    resolveServerClose?.();
    await vi.waitFor(() => expect(dependencies.exit).toHaveBeenCalledOnce());

    expect(bridgeClose).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(dependencies.exit).toHaveBeenCalledWith(0);
  });
});
