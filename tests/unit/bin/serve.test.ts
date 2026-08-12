import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../../src/config/index.js';
import {
  parseServeArgs,
  resolveServeEndpoint,
  runServeCli,
  type ServeCliDependencies,
} from '../../../src/bin/commands/serve.js';

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
});
