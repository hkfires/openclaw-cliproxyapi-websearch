// Exercise the pinned real host in a temporary state directory, never user credentials.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const state = await mkdtemp(join(tmpdir(), 'cpa-websearch-host-'));
const savedEnv = { ...process.env };
const bodies = [];
const summary = "    Host search smoke passed.\n    Second line.  \n";
const server = createServer(async (req, res) => {
  // Simulate a reverse proxy exposing only standard Responses routes.
  if (!['/v1/responses', '/proxy/v1/responses'].includes(req.url)) {
    res.writeHead(404); res.end(); return;
  }
  if (req.headers.authorization !== 'Bearer smoke-key') {
    res.writeHead(401); res.end(); return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  bodies.push(JSON.parse(raw));
  res.setHeader('Content-Type', 'text/event-stream');
  for (const event of [
    { type: 'response.web_search_call.searching' },
    { type: 'response.output_text.delta', delta: summary },
    { type: 'response.completed', response: { status: 'completed', output: [
      { type: 'web_search_call', action: { sources: [{ url: 'https://example.com/', title: 'Example' }] } },
      { type: 'message', content: [{ type: 'output_text', text: summary }] },
    ] } },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end('data: [DONE]\n\n');
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const key of Object.keys(process.env)) if (/^(CLIPROXYAPI_|CPA_|OPENCLAW_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: join(state, 'openclaw.json') });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workspace = join(state, 'workspace'); const agentDir = join(state, 'agents', 'main', 'agent');
  await mkdir(workspace, { recursive: true }); await mkdir(agentDir, { recursive: true });
  await writeFile(join(state, 'cliproxyapi.json'), JSON.stringify({ baseUrl, apiKey: 'smoke-key' }));
  const config = {
    agents: { defaults: { workspace } },
    tools: { web: { search: { enabled: false }, fetch: { enabled: false } } },
    plugins: { allow: ['cliproxyapi-websearch'], load: { paths: [resolve('.')] }, entries: { 'cliproxyapi-websearch': { enabled: true } } },
  };
  await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const cli = resolve('node_modules/openclaw/openclaw.mjs');
  async function run(...args) {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { env: process.env, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    if (stderr) console.error(stderr);
    return stdout;
  }
  await run('config', 'validate');
  const inspection = JSON.parse(await run('plugins', 'inspect', 'cliproxyapi-websearch', '--runtime', '--json'));
  assert.equal(inspection.plugin.status, 'loaded');
  assert.ok(inspection.plugin.toolNames.includes('web_search'));
  // Internal imports are test-only and deliberately restricted to the pinned host version.
  const dist = resolve('node_modules/openclaw/dist');
  const loaderFile = (await readdir(dist)).find(name => /^loader-runtime-load-.*\.mjs$/.test(name));
  assert.ok(loaderFile, 'pinned host full plugin loader exists');
  const { r: loadOpenClawPlugins } = await import(pathToFileURL(join(dist, loaderFile)).href);
  loadOpenClawPlugins({ config, workspaceDir: workspace, activate: true, cache: false });
  let toolsModule;
  for (const file of (await readdir(dist)).filter(name => /^openclaw-tools-.*\.mjs$/.test(name))) {
    const source = await readFile(join(dist, file), 'utf8');
    if (source.length < 1000 && source.includes('export { createOpenClawTools')) { toolsModule = file; break; }
  }
  assert.ok(toolsModule, 'pinned host tool assembly export exists');
  const { createOpenClawTools } = await import(pathToFileURL(join(dist, toolsModule)).href);
  const tools = createOpenClawTools({
    config, workspaceDir: workspace, agentDir,
    agentSessionKey: 'agent:main:smoke', sessionId: 'smoke-session',
    modelProvider: 'cliproxyapi', modelId: 'active-smoke-model',
    disableMessageTool: true, wrapBeforeToolCallHook: false,
  });
  const searches = tools.filter(tool => tool.name === 'web_search');
  assert.equal(searches.length, 1, 'exactly one replacement tool is assembled');
  assert.match(searches[0].description, /CLIProxyAPI/);
  const updates = [];
  const result = await searches[0].execute('smoke-call', { query: 'host smoke' }, undefined, update => updates.push(update));
  assert.ok(result.content[0].text.includes(summary), 'the wrapped result preserves body whitespace');
  assert.match(result.content[0].text, /EXTERNAL_UNTRUSTED_CONTENT/);
  assert.equal(result.details.model, 'active-smoke-model');
  assert.equal(result.details.sourcesCount, 1);
  assert.ok(updates.length > 0);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].tools, [{ type: 'web_search' }]);
  assert.equal(bodies[0].input.length, 1);
  assert.equal(bodies[0].model, 'active-smoke-model');
  assert.match(bodies[0].instructions, /Current reference date \(UTC\): \d{4}-\d{2}-\d{2}/);
  for (const suffix of ['/backend-api', '/proxy/backend-api/']) {
    await writeFile(join(state, 'cliproxyapi.json'), JSON.stringify({ baseUrl: baseUrl + suffix, apiKey: 'smoke-key' }));
    const legacyResult = await searches[0].execute('legacy-call', { query: 'legacy provider base URL' });
    assert.ok(legacyResult.content[0].text.includes(summary));
    assert.equal(legacyResult.details.model, 'active-smoke-model');
  }
  assert.equal(bodies.length, 3, 'legacy base URLs work through standard-only reverse proxy routes');
  await writeFile(join(state, 'cliproxyapi.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:1', apiKey: 'stale-key' }));
  const runtimeConfig = { ...config, models: { providers: { cliproxyapi: { baseUrl: `${baseUrl}/v1`, api: 'openai-responses', apiKey: 'smoke-key', models: [] } } } };
  const runtimeTools = createOpenClawTools({
    config: runtimeConfig, workspaceDir: workspace, agentDir,
    modelProvider: 'cliproxyapi', modelId: 'active-smoke-model',
    disableMessageTool: true, wrapBeforeToolCallHook: false,
  });
  const runtimeSearch = runtimeTools.find(tool => tool.name === 'web_search');
  assert.ok(runtimeSearch);
  const runtimeResult = await runtimeSearch.execute('runtime-call', { query: 'runtime route and auth' });
  assert.ok(runtimeResult.content[0].text.includes(summary));
  assert.equal(bodies.length, 4, 'runtime provider address and SDK credentials override stale file defaults');
  const otherTools = createOpenClawTools({
    config, workspaceDir: workspace, agentDir,
    modelProvider: 'other', modelId: 'active-smoke-model',
    disableMessageTool: true, wrapBeforeToolCallHook: false,
  });
  const otherSearch = otherTools.find(tool => tool.name === 'web_search');
  assert.ok(otherSearch);
  await assert.rejects(otherSearch.execute('other-call', { query: 'must not search' }), /仅支持当前会话/);
  const missingModelTools = createOpenClawTools({
    config, workspaceDir: workspace, agentDir,
    modelProvider: 'cliproxyapi',
    disableMessageTool: true, wrapBeforeToolCallHook: false,
  });
  const missingModelSearch = missingModelTools.find(tool => tool.name === 'web_search');
  assert.ok(missingModelSearch);
  await assert.rejects(missingModelSearch.execute('missing-model-call', { query: 'must not search' }), /模型 ID/);
  assert.equal(bodies.length, 4, 'other providers and missing models never issue search requests');
  assert.deepEqual(inspection.plugin.commandNames ?? [], []);
  console.log('PASS: real host preserves body whitespace, reuses runtime provider URL/auth, normalizes legacy URLs, uses the current CPA model and UTC date, and rejects other providers/missing models without fallback.');
} finally {
  // Windows cannot remove SQLite files until the host's process-wide handles close.
  const hostDist = resolve('node_modules/openclaw/dist');
  for (const file of (await readdir(hostDist)).filter(name => /^openclaw-agent-db-.*\.mjs$/.test(name))) {
    const source = await readFile(join(hostDist, file), 'utf8');
    if (source.includes('function closeOpenClawAgentDatabasesAsync(')) {
      const { M: closeOpenClawAgentDatabasesAsync } = await import(pathToFileURL(join(hostDist, file)).href);
      await closeOpenClawAgentDatabasesAsync();
      break;
    }
  }
  const cacheModule = (await readdir(hostDist)).find(name => /^openclaw-state-db-cache-.*\.mjs$/.test(name));
  if (cacheModule) {
    const { r: closeOpenClawStateDatabase } = await import(pathToFileURL(join(hostDist, cacheModule)).href);
    closeOpenClawStateDatabase();
  }
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(state, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}

