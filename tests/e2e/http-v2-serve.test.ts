import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';

const isE2EEnabled = process.env.NEXUS_E2E === '1';
const cliPath = join(process.cwd(), 'dist', 'bin', 'nexus.js');
const protocolVersion = '2026-07-28';

const waitForStartup = (child: ChildProcessWithoutNullStreams): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = '';
    let diagnostics = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`nexus serve did not start in time: ${diagnostics}`));
    }, 30_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onStdout = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = /nexus serve listening on (127\.0\.0\.1|localhost):(\d+)/.exec(output);
      const host = match?.[1];
      const port = match?.[2];
      if (host !== undefined && port !== undefined) {
        cleanup();
        resolve(`http://${host}:${port}`);
      }
    };
    const onStderr = (chunk: Buffer): void => {
      diagnostics += chunk.toString('utf8');
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`nexus serve exited with ${String(code)}: ${diagnostics}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });

describe.skipIf(!isE2EEnabled)('nexus serve E2E', () => {
  let projectRoot: string | undefined;
  let server: ChildProcessWithoutNullStreams | undefined;

  afterEach(async () => {
    if (server?.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
    server = undefined;
    if (projectRoot !== undefined) {
      await rm(projectRoot, { recursive: true, force: true });
      projectRoot = undefined;
    }
  });

  it('serves health and lists MCP v2 tools through the built CLI', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'nexus-serve-e2e-'));
    await writeFile(
      join(projectRoot, '.nexus.json'),
      JSON.stringify({ embedding: { provider: 'ollama', model: 'nomic-embed-text' } }),
    );
    const child = spawn(process.execPath, [cliPath, 'serve', '--project-root', projectRoot, '--port', '0'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NEXUS_E2E: '1' },
    });
    server = child;

    const baseUrl = await waitForStartup(child);
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': protocolVersion,
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(await response.json()).toMatchObject({
      result: {
        tools: [
          { name: 'semantic_search' },
          { name: 'grep_search' },
          { name: 'hybrid_search' },
          { name: 'get_context' },
          { name: 'index_status' },
          { name: 'reindex' },
        ],
      },
    });
  });
});
