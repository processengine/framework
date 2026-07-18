import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImages, imageDefinitions, shop } from './images.mjs';

const context = 'docker-desktop';
const namespace = 'processengine-test-shop';
const release = 'test-shop';
const chart = path.join(shop, 'deploy/helm/test-shop');
const values = path.join(chart, 'values.docker-desktop.yaml');

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: shop,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${program} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

const kubectl = (args, options) => execute('kubectl', ['--context', context, ...args], options);
const helm = (args, options) => execute('helm', ['--kube-context', context, ...args], options);

function assertContext() {
  const current = execute('kubectl', ['config', 'current-context'], { quiet: true }).stdout;
  if (current !== context) throw new Error(`Current Kubernetes context is ${current || '<empty>'}; expected ${context}`);
}

function namespaceObject() {
  const result = kubectl(['get', 'namespace', namespace, '-o', 'json'], { allowFailure: true, quiet: true });
  if (!result.ok && !result.stderr.includes('(NotFound)')) throw new Error(`Cannot inspect namespace: ${result.stderr}`);
  return result.ok ? JSON.parse(result.stdout) : undefined;
}

function assertOwnedNamespace(value) {
  const labels = value?.metadata?.labels ?? {};
  if (labels['processengine.io/owner'] !== 'test-shop'
    || labels['processengine.io/environment'] !== 'docker-desktop') {
    throw new Error(`Refusing to mutate unowned namespace ${namespace}`);
  }
}

function ensureNamespace() {
  const existing = namespaceObject();
  if (existing) assertOwnedNamespace(existing);
  else kubectl(['create', 'namespace', namespace], { quiet: true });
  kubectl(['label', 'namespace', namespace, '--overwrite',
    'processengine.io/owner=test-shop', 'processengine.io/environment=docker-desktop'], { quiet: true });
  assertOwnedNamespace(namespaceObject());
}

async function doctor({ requireImages = true } = {}) {
  assertContext();
  execute('docker', ['version'], { quiet: true });
  execute('helm', ['version', '--short'], { quiet: true });
  execute('kubectl', ['version', '--client', '-o', 'json'], { quiet: true });
  const nodes = JSON.parse(kubectl(['get', 'nodes', '-o', 'json'], { quiet: true }).stdout);
  if (!Array.isArray(nodes.items) || nodes.items.length === 0 || nodes.items.some((node) =>
    !node.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'))) {
    throw new Error('Every docker-desktop Kubernetes node must be Ready');
  }
  const existing = namespaceObject();
  if (existing) assertOwnedNamespace(existing);
  if (requireImages) {
    for (const image of await imageDefinitions()) execute('docker', ['image', 'inspect', image.image], { quiet: true });
  }
  console.log(`Doctor passed: context=${context}, namespace=${namespace}, nodes=${nodes.items.length}`);
}

function helmWaitArgs() {
  const version = execute('helm', ['version', '--short'], { quiet: true }).stdout;
  const match = /^v?(\d+)/u.exec(version);
  if (!match?.[1]) throw new Error(`Cannot determine Helm major version from ${version}`);
  return Number(match[1]) >= 4 ? ['--wait=legacy'] : ['--wait'];
}

async function deploy() {
  try {
    assertContext();
    await buildImages();
    await doctor();
    ensureNamespace();
    helm(['lint', chart, '--values', values], { quiet: true });
    const images = await imageDefinitions();
    const imageArgs = images.flatMap((image) => {
      const valueName = image.component === 'shop-host' ? 'shopHost'
        : image.component === 'shop-warehouse' ? 'shopWarehouse' : 'shopPayment';
      return ['--set-string', `images.${valueName}.repository=${image.repository}`, '--set-string', `images.${valueName}.tag=${image.tag}`];
    });
    helm(['upgrade', '--install', release, chart, '--namespace', namespace, '--values', values,
      ...imageArgs, ...helmWaitArgs(), '--wait-for-jobs', '--timeout', '10m']);
    status();
    await collectEvidence('deploy-pass');
  } catch (error) {
    await safeCollectEvidence('deploy-failure', { 'deploy-error.txt': String(error) });
    throw error;
  }
}

function status() {
  assertContext();
  const existing = namespaceObject();
  if (!existing) throw new Error(`Namespace ${namespace} does not exist`);
  assertOwnedNamespace(existing);
  kubectl(['get', 'deployments,statefulsets,pods,services,jobs,pvc,pdb', '--namespace', namespace, '-o', 'wide']);
}

async function test() {
  try {
    await doctor();
    await assertWorkloads();
    helm(['test', release, '--namespace', namespace, '--logs', '--timeout', '120s']);
    const output = await withForwards('acceptance.mjs');
    process.stdout.write(output);
    await collectEvidence('business-pass', { 'business-acceptance.log': output });
  } catch (error) {
    await safeCollectEvidence('business-failure', { 'business-acceptance-error.txt': String(error) });
    throw error;
  }
}

async function resilience() {
  try {
    await doctor();
    await assertWorkloads();
    const output = await withProxy('resilience.mjs');
    process.stdout.write(output);
    await assertWorkloads();
    await collectEvidence('resilience-pass', { 'resilience-acceptance.log': output });
  } catch (error) {
    await safeCollectEvidence('resilience-failure', { 'resilience-acceptance-error.txt': String(error) });
    throw error;
  }
}

async function assertWorkloads() {
  for (const component of ['shop-host', 'shop-warehouse', 'shop-payment']) {
    kubectl(['rollout', 'status', '--namespace', namespace, `deployment/${release}-${component}`, '--timeout=180s']);
  }
  for (const component of ['postgres', 'kafka']) {
    kubectl(['rollout', 'status', '--namespace', namespace, `statefulset/${release}-${component}`, '--timeout=240s']);
  }
  for (const component of ['shop-host', 'shop-warehouse', 'shop-payment']) {
    const pods = JSON.parse(kubectl(['get', 'pods', '--namespace', namespace,
      '-l', `app.kubernetes.io/component=${component}`, '-o', 'json'], { quiet: true }).stdout);
    const ready = (pods.items ?? []).filter((pod) => !pod.metadata?.deletionTimestamp
      && pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'));
    if (ready.length !== 2) throw new Error(`Expected exactly two Ready ${component} pods, got ${ready.length}`);
  }
}

async function withForwards(script) {
  const services = [
    [`${release}-shop-host`, 3000],
    [`${release}-shop-warehouse`, 8081],
    [`${release}-shop-payment`, 8082],
  ];
  const children = [];
  const ports = [];
  try {
    for (const [service, remotePort] of services) {
      const localPort = await freePort();
      ports.push(localPort);
      children.push(await forward(service, localPort, remotePort));
    }
    const result = execute(process.execPath, [path.join(shop, 'scripts', script),
      '--base-url', `http://127.0.0.1:${ports[0]}`,
      '--warehouse-url', `http://127.0.0.1:${ports[1]}`,
      '--payment-url', `http://127.0.0.1:${ports[2]}`,
      '--timeout-ms', '300000'], { quiet: true });
    return `${result.stdout}\n${result.stderr}`.trimStart();
  } finally {
    for (const child of children) child.kill('SIGTERM');
  }
}

async function withProxy(script) {
  const port = await freePort();
  const child = spawn('kubectl', ['--context', context, 'proxy', `--port=${port}`, '--address=127.0.0.1',
    '--accept-hosts=^127\\.0\\.0\\.1$'], { cwd: shop, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stdout.on('data', (chunk) => { diagnostics += chunk.toString(); });
  child.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
  const root = `http://127.0.0.1:${port}/api/v1/namespaces/${namespace}/services`;
  const urls = {
    host: `${root}/http:${release}-shop-host:3000/proxy`,
    warehouse: `${root}/http:${release}-shop-warehouse:8081/proxy`,
    payment: `${root}/http:${release}-shop-payment:8082/proxy`,
  };
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      const probe = spawnSync(process.execPath, ['-e', `fetch('${urls.host}/health/live',{signal:AbortSignal.timeout(500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`]);
      if (probe.status === 0) {
        ready = true;
        break;
      }
      if (child.exitCode !== null) throw new Error(`kubectl proxy exited: ${diagnostics}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`kubectl proxy did not become ready: ${diagnostics}`);
    const result = execute(process.execPath, [path.join(shop, 'scripts', script),
      '--base-url', urls.host, '--warehouse-url', urls.warehouse, '--payment-url', urls.payment,
      '--timeout-ms', '300000'], { quiet: true });
    return `${result.stdout}\n${result.stderr}`.trimStart();
  } finally {
    child.kill('SIGTERM');
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function forward(service, localPort, remotePort) {
  const child = spawn('kubectl', ['--context', context, '--namespace', namespace,
    'port-forward', `service/${service}`, `${localPort}:${remotePort}`], { cwd: shop, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stdout.on('data', (chunk) => { diagnostics += chunk.toString(); });
  child.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`port-forward ${service} exited: ${diagnostics}`);
    const probe = spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${localPort}/health/live',{signal:AbortSignal.timeout(500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`]);
    if (probe.status === 0) return child;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`port-forward ${service} did not become ready: ${diagnostics}`);
}

async function collectEvidence(label, extra = {}) {
  assertContext();
  const existing = namespaceObject();
  const directory = path.join(shop, '.artifacts', 'k8s', `${new Date().toISOString().replaceAll(':', '-')}-${label}`);
  await mkdir(directory, { recursive: true });
  const files = { ...extra };
  files['environment.json'] = JSON.stringify({
    collectedAt: new Date().toISOString(), label, context, namespace,
    docker: execute('docker', ['version', '--format', '{{json .}}'], { allowFailure: true, quiet: true }).stdout,
    kubectl: execute('kubectl', ['version', '-o', 'json'], { allowFailure: true, quiet: true }).stdout,
    helm: execute('helm', ['version', '--short'], { allowFailure: true, quiet: true }).stdout,
    images: await imageDefinitions(),
  }, null, 2);
  if (!existing) {
    files['namespace.txt'] = 'namespace does not exist\n';
  } else {
    assertOwnedNamespace(existing);
    files['helm-status.json'] = helm(['status', release, '--namespace', namespace, '-o', 'json'], { allowFailure: true, quiet: true }).stdout;
    files['helm-values.yaml'] = helm(['get', 'values', release, '--namespace', namespace, '--all'], { allowFailure: true, quiet: true }).stdout;
    files['manifest.yaml'] = helm(['get', 'manifest', release, '--namespace', namespace], { allowFailure: true, quiet: true }).stdout;
    files['inventory.yaml'] = kubectl(['get', 'deploy,statefulset,pod,service,job,pvc,pdb', '--namespace', namespace, '-o', 'yaml'], { allowFailure: true, quiet: true }).stdout;
    files['events.txt'] = kubectl(['get', 'events', '--namespace', namespace, '--sort-by=.lastTimestamp'], { allowFailure: true, quiet: true }).stdout;
    const pods = JSON.parse(kubectl(['get', 'pods', '--namespace', namespace, '-o', 'json'], { allowFailure: true, quiet: true }).stdout || '{"items":[]}');
    for (const pod of pods.items ?? []) {
      const name = pod.metadata?.name;
      if (typeof name !== 'string') continue;
      files[`logs-${name}.txt`] = kubectl(['logs', '--namespace', namespace, `pod/${name}`, '--all-containers', '--prefix', '--tail=500'], { allowFailure: true, quiet: true }).stdout;
      files[`describe-${name}.txt`] = kubectl(['describe', 'pod', name, '--namespace', namespace], { allowFailure: true, quiet: true }).stdout;
    }
    const snapshots = {
      'db-processes.txt': `SELECT instance_id, revision, lifecycle, state->'flow' AS flow, state->>'outcome' AS outcome, updated_at FROM processengine.processes ORDER BY updated_at DESC LIMIT 200`,
      'db-operations.txt': `SELECT request_id, instance_id, step_id, operation, status, completion_source, created_at, resolved_at FROM processengine.operations ORDER BY created_at DESC LIMIT 500`,
      'db-host-outbox.txt': `SELECT message_id, request_id, instance_id, status, attempt, claim_version, claimed_by, available_at, published_at FROM processengine.outbox ORDER BY available_at DESC LIMIT 500`,
      'db-warehouse-ledgers.txt': `SELECT checkout_id, status, reserve_effects, release_effects FROM warehouse.reservations ORDER BY created_at DESC LIMIT 200`,
      'db-payment-ledgers.txt': `SELECT checkout_id, status, authorize_effects, confirm_effects, cancel_effects FROM payment.authorizations ORDER BY created_at DESC LIMIT 200`,
      'db-service-inboxes.txt': `SELECT 'warehouse' AS service, process_id, operation, request_id, suppressed, completed_at FROM warehouse_service.operation_ledger UNION ALL SELECT 'payment', process_id, operation, request_id, suppressed, completed_at FROM payment_service.operation_ledger ORDER BY completed_at DESC LIMIT 500`,
    };
    for (const [name, sql] of Object.entries(snapshots)) {
      files[name] = kubectl(['exec', '--namespace', namespace, `statefulset/${release}-postgres`, '--',
        'psql', '-U', 'processengine', '-d', 'processengine', '-P', 'pager=off', '-c', sql],
      { allowFailure: true, quiet: true }).stdout;
    }
  }
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(directory, name), `${value ?? ''}\n`);
  console.log(`Evidence: ${directory}`);
  return directory;
}

async function safeCollectEvidence(label, extra = {}) {
  try { return await collectEvidence(label, extra); }
  catch (error) {
    console.error(`Evidence collection failed for ${label}:`, error);
    return undefined;
  }
}

async function down() {
  await doctor({ requireImages: false });
  const existing = namespaceObject();
  if (!existing) return;
  assertOwnedNamespace(existing);
  await collectEvidence('before-down');
  helm(['uninstall', release, '--namespace', namespace, '--wait', '--timeout', '3m'], { allowFailure: true });
  kubectl(['delete', 'namespace', namespace, '--wait=true', '--timeout=3m']);
}

const command = process.argv[2];
if (command === 'doctor') await doctor({ requireImages: false });
else if (command === 'deploy') await deploy();
else if (command === 'status') status();
else if (command === 'test') await test();
else if (command === 'resilience') await resilience();
else if (command === 'collect') await collectEvidence('manual');
else if (command === 'down') await down();
else throw new TypeError('Usage: node scripts/k8s.mjs <doctor|deploy|status|test|resilience|collect|down>');
