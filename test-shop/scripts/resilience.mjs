import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, assertScenarioLedgers, parseOptions } from './acceptance.mjs';

const options = parseOptions();
const client = createClient(options);
const context = 'docker-desktop';
const namespace = 'processengine-test-shop';
const release = 'test-shop';
const shop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chart = path.join(shop, 'deploy/helm/test-shop');

await Promise.all([
  client.ready('shop-host', options.baseUrl),
  client.ready('shop-warehouse', options.warehouseUrl),
  client.ready('shop-payment', options.paymentUrl),
]);
assertSafeScope();
assertTwoHosts();
await assertBothHostsServeTraffic();

const results = [];
results.push(await hostInitiatorCrash());
results.push(await outboxPublicationInitiatorCrash());
results.push(await operationWorkerRestart());
results.push(await artifactActivationRollingUpdate());
results.push(await duplicateAndLateCompletion());
results.push(await kafkaOutageRecovery());
results.push(await postgresOutageRecovery());

console.log(JSON.stringify({ gate: 'kubernetes-resilience', status: 'PASS', scenarios: results }));

async function hostInitiatorCrash() {
  const execution = await startDelayed('owner-crash');
  const initiator = execution.started.servedBy;
  if (typeof initiator !== 'string' || !hostPods().includes(initiator)) {
    throw new Error(`Cannot identify initiating shop-host pod: ${initiator}`);
  }
  kubectl(['delete', 'pod', initiator, '--grace-period=0', '--force', '--wait=true', '--timeout=60s']);
  if (hostPods().includes(initiator)) throw new Error(`Initiating pod ${initiator} still exists after deletion`);
  kubectl(['rollout', 'status', `deployment/${release}-shop-host`, '--timeout=180s']);
  const completed = await assertDelayedCompleted(execution);
  if (completed.servedBy === initiator) throw new Error('Final state was served by the deleted initiating host instance');
  return evidence('initiating-instance-crash', execution, completed,
    { deletedPod: initiator, continuedBy: completed.servedBy });
}

async function operationWorkerRestart() {
  const workers = componentPods('shop-payment');
  if (workers.length !== 2) throw new Error(`Expected two shop-payment workers, got ${JSON.stringify(workers)}`);
  const beforeRestarts = Object.fromEntries(workers.map((worker) => [worker, restartCount(worker)]));
  const checkoutId = `worker-restart-${randomUUID()}`;
  await armPaymentControl(checkoutId);
  await client.start(input(checkoutId, 'tok-crash-after-commit'), checkoutId);
  const worker = waitForAnyRestart(beforeRestarts);
  kubectl(['rollout', 'status', `deployment/${release}-shop-payment`, '--timeout=180s']);
  const completed = await client.waitFor(checkoutId);
  assertApproved(completed);
  await assertSuccessLedgers(checkoutId);
  const control = await waitPaymentControl(checkoutId, (value) =>
    value.deliveries >= 2 && Array.isArray(value.worker_ids) && new Set(value.worker_ids).size >= 2);
  return { name: 'operation-worker-crash-after-durable-commit', checkoutId, pod: worker,
    restartsBefore: beforeRestarts[worker], restartsAfter: restartCount(worker), finalRevision: completed.revision,
    commandDeliveries: control.deliveries, serviceInstances: control.worker_ids };
}

async function outboxPublicationInitiatorCrash() {
  scaleStatefulSet('kafka', 0);
  try {
    waitForNoPods('kafka');
    const checkoutId = `outbox-initiator-crash-${randomUUID()}`;
    const started = await client.start(input(checkoutId, 'tok-ok'), checkoutId);
    const initiator = started.servedBy;
    if (typeof initiator !== 'string' || !hostPods().includes(initiator)) {
      throw new Error(`Cannot identify the host that accepted ${checkoutId}: ${initiator}`);
    }
    const waiting = await client.waitFor(checkoutId, (view) => view.processStatus === 'WAITING');
    const persisted = await client.raw(checkoutId);
    const failedAttempt = await waitForOutboxAttempt(checkoutId);
    const durableBeforeCrash = outboxRows(checkoutId);
    if (durableBeforeCrash.length !== 1) {
      throw new Error(`Expected one durable reserve dispatch before crash: ${JSON.stringify(durableBeforeCrash)}`);
    }

    kubectl(['delete', 'pod', initiator, '--grace-period=0', '--force', '--wait=true', '--timeout=60s']);
    if (hostPods().includes(initiator)) throw new Error(`Initiating pod ${initiator} still exists after forced deletion`);

    scaleStatefulSet('kafka', 1);
    kubectl(['rollout', 'status', `statefulset/${release}-kafka`, '--timeout=240s']);
    kubectl(['rollout', 'status', `deployment/${release}-shop-host`, '--timeout=240s']);
    await waitApplicationsReady();
    const completed = await client.waitFor(checkoutId);
    assertApproved(completed);
    await assertSuccessLedgers(checkoutId);
    const drained = outboxRows(checkoutId);
    const stable = drained.find((row) => row.requestId === durableBeforeCrash[0].requestId);
    if (!stable || stable.status !== 'PUBLISHED' || drained.length !== 3
      || drained.some((row) => row.status !== 'PUBLISHED')) {
      throw new Error(`Durable outbox did not survive initiating-host crash: ${JSON.stringify({ durableBeforeCrash, drained })}`);
    }
    return {
      name: 'durable-outbox-initiator-crash', checkoutId, deletedPod: initiator,
      pendingRevision: waiting.revision, persistedRevision: persisted.process.revision,
      finalRevision: completed.revision, failedAttempt, stableRequestId: stable.requestId,
    };
  } finally {
    scaleStatefulSet('kafka', 1);
  }
}

async function artifactActivationRollingUpdate() {
  const completedBefore = await startSuccess('pre-upgrade-completed');
  const completedBeforeState = await client.raw(completedBefore.checkoutId);
  const checkoutId = `artifact-activation-${randomUUID()}`;
  await armPaymentControl(checkoutId);
  const started = await client.start(input(checkoutId, 'tok-upgrade-barrier'), checkoutId);
  const pending = await client.waitFor(checkoutId, (view) =>
    view.processStatus === 'WAITING' && view.currentStep === 'authorize-payment');
  await waitPaymentControl(checkoutId, (value) => value.deliveries >= 1);
  const persisted = await client.raw(checkoutId);
  const execution = { checkoutId, started, pending, persisted };
  const oldPods = applicationPodSets();
  try {
    helmUpgrade('2.0.0');
    for (const component of ['shop-host', 'shop-warehouse', 'shop-payment']) {
      kubectl(['rollout', 'status', `deployment/${release}-${component}`, '--timeout=240s']);
    }
    const newPods = assertApplicationPodsReplaced(oldPods);
    assertTwoHosts();
    const stillPending = await client.raw(checkoutId);
    if (stillPending.process.lifecycle !== 'WAITING'
      || stillPending.process.pending?.stepId !== 'authorize-payment'
      || stillPending.process.flow.version !== '1.0.0'
      || stillPending.process.revision !== persisted.process.revision) {
      throw new Error(`Pinned v1 process did not remain at the barrier across the full rollout: ${JSON.stringify(stillPending)}`);
    }
    await releasePaymentControl(checkoutId);
    const completed = await assertDelayedCompleted(execution);
    const rawV1 = await client.raw(execution.checkoutId);
    if (rawV1.process.flow.version !== '1.0.0') throw new Error('Unfinished v1 process was not pinned to immutable v1 artifact');
    const afterCompleted = await client.raw(completedBefore.checkoutId);
    if (JSON.stringify(afterCompleted.process) !== JSON.stringify(completedBeforeState.process)) {
      throw new Error('Already-completed process changed during Helm artifact activation');
    }
    const v2 = await startSuccess('post-upgrade-v2', 'APPROVED_V2');
    const rawV2 = await client.raw(v2.checkoutId);
    if (rawV2.process.flow.version !== '2.0.0' || rawV2.process.outcome !== 'APPROVED_V2') {
      throw new Error('New process did not exhibit the explicit v2 artifact semantics after activation');
    }
    return evidence('immutable-artifact-v1-to-v2-rolling-helm-activation', execution, completed,
      { completedProcess: completedBefore.checkoutId, v2Process: v2.checkoutId, oldPods, newPods,
        v1Outcome: completed.outcome, v2Outcome: rawV2.process.outcome });
  } finally {
    await releasePaymentControl(checkoutId).catch(() => undefined);
    helmUpgrade('1.0.0');
  }
}

async function duplicateAndLateCompletion() {
  const execution = await startSuccess('late-completion');
  const before = await client.raw(execution.checkoutId);
  await client.expectStatus(
    `${options.paymentUrl}/debug/completions/${encodeURIComponent(execution.checkoutId)}/replay`,
    { method: 'POST' },
    202,
  );
  await pause(1500);
  const after = await client.raw(execution.checkoutId);
  if (after.process.revision !== before.process.revision
    || after.process.outcome !== before.process.outcome
    || JSON.stringify(after.process.results) !== JSON.stringify(before.process.results)) {
    throw new Error('Duplicate/late completion changed persisted terminal process state');
  }
  await assertSuccessLedgers(execution.checkoutId);
  return { name: 'duplicate-late-completion', checkoutId: execution.checkoutId, revision: after.process.revision };
}

async function kafkaOutageRecovery() {
  scaleStatefulSet('kafka', 0);
  try {
    waitForNoPods('kafka');
    const checkoutId = `kafka-recovery-${randomUUID()}`;
    const started = await client.start(input(checkoutId, 'tok-ok'), checkoutId);
    const pending = await client.waitFor(checkoutId, (view) => view.processStatus === 'WAITING');
    const failedAttempt = await waitForOutboxAttempt(checkoutId);
    scaleStatefulSet('kafka', 1);
    kubectl(['rollout', 'status', `statefulset/${release}-kafka`, '--timeout=240s']);
    await waitApplicationsReady();
    const completed = await client.waitFor(checkoutId);
    assertApproved(completed);
    await assertSuccessLedgers(checkoutId);
    const drained = outboxRows(checkoutId);
    if (drained.length !== 3 || drained.some((row) => row.status !== 'PUBLISHED')) {
      throw new Error(`Kafka recovery did not drain stable outbox records: ${JSON.stringify(drained)}`);
    }
    return { name: 'kafka-outage-recovery', checkoutId, pendingRevision: pending.revision, finalRevision: completed.revision,
      startedBy: started.servedBy, failedAttempt, drained };
  } finally {
    scaleStatefulSet('kafka', 1);
  }
}

async function postgresOutageRecovery() {
  const execution = await startDelayed('postgres-recovery');
  const restartSnapshot = deploymentRestartCounts();
  scaleStatefulSet('postgres', 0);
  try {
    waitForNoPods('postgres');
    await pause(20_000);
    scaleStatefulSet('postgres', 1);
    kubectl(['rollout', 'status', `statefulset/${release}-postgres`, '--timeout=240s']);
    const recoveredPending = await client.waitFor(execution.checkoutId, (view) => view.processStatus === 'WAITING');
    if (recoveredPending.revision !== execution.persisted.process.revision) {
      throw new Error('Process advanced while PostgreSQL was unavailable');
    }
    const completed = await assertDelayedCompleted(execution);
    const afterRestarts = deploymentRestartCounts();
    if (JSON.stringify(afterRestarts) !== JSON.stringify(restartSnapshot)) {
      throw new Error(`Applications restarted during automatic PostgreSQL recovery: ${JSON.stringify({ restartSnapshot, afterRestarts })}`);
    }
    return evidence('postgres-outage-automatic-recovery', execution, completed,
      { restartSnapshot, afterRestarts, heldUnavailableMs: 20_000, enteredBeforeOutage: execution.control });
  } finally {
    scaleStatefulSet('postgres', 1);
  }
}

async function startDelayed(prefix) {
  const checkoutId = `${prefix}-${randomUUID()}`;
  await armPaymentControl(checkoutId);
  const started = await client.start(input(checkoutId, 'tok-delayed'), checkoutId);
  const pending = await client.waitFor(checkoutId, (view) =>
    view.processStatus === 'WAITING' && view.currentStep === 'authorize-payment');
  const persisted = await client.raw(checkoutId);
  if (persisted.process.lifecycle !== 'WAITING'
    || persisted.process.pending?.stepId !== 'authorize-payment'
    || !persisted.process.results['reserve-stock']) {
    throw new Error(`${prefix}: durable WAITING state is incomplete: ${JSON.stringify(persisted)}`);
  }
  const control = await waitPaymentControl(checkoutId, (value) => value.deliveries >= 1);
  return { checkoutId, started, pending, persisted, control };
}

async function assertDelayedCompleted(execution) {
  const completed = await client.waitFor(execution.checkoutId);
  assertApproved(completed);
  if (completed.revision <= execution.persisted.process.revision) throw new Error('Persisted process revision did not advance');
  const raw = await client.raw(execution.checkoutId);
  for (const step of ['reserve-stock', 'authorize-payment', 'confirm-payment']) {
    if (raw.process.results[step]?.status !== 'SUCCESS') throw new Error(`${step} was not durably completed`);
  }
  await assertSuccessLedgers(execution.checkoutId);
  return completed;
}

async function startSuccess(prefix, expectedOutcome = 'APPROVED') {
  const checkoutId = `${prefix}-${randomUUID()}`;
  const starts = await Promise.all(Array.from({ length: 24 }, () => client.start(input(checkoutId, 'tok-ok'), checkoutId)));
  if (new Set(starts.map((item) => item.processId)).size !== 1) throw new Error('Multi-host concurrent starts created multiple process IDs');
  const completed = await client.waitFor(checkoutId);
  assertApproved(completed, expectedOutcome);
  await assertSuccessLedgers(checkoutId);
  return { checkoutId, completed };
}

async function assertSuccessLedgers(checkoutId) {
  return assertScenarioLedgers(client, checkoutId, {
    reservation: { status: 'ACTIVE', reserve_effects: 1, release_effects: 0 },
    payment: { status: 'CONFIRMED', authorize_effects: 1, confirm_effects: 1 },
    warehouseOperations: { 'warehouse.reserve': 1 },
    paymentOperations: { 'payment.authorize': 1, 'payment.confirm': 1 },
  });
}

function assertApproved(view, expectedOutcome = 'APPROVED') {
  if (view.processStatus !== 'COMPLETED' || view.outcome !== expectedOutcome || view.response?.resultCode !== 'CONFIRMED') {
    throw new Error(`Expected durable ${expectedOutcome} result, got ${JSON.stringify(view)}`);
  }
}

async function armPaymentControl(checkoutId) {
  await client.expectStatus(
    `${options.paymentUrl}/debug/controls/${encodeURIComponent(checkoutId)}/arm`,
    { method: 'POST' },
    200,
  );
}

async function releasePaymentControl(checkoutId) {
  await client.expectStatus(
    `${options.paymentUrl}/debug/controls/${encodeURIComponent(checkoutId)}/release`,
    { method: 'POST' },
    200,
  );
}

async function waitPaymentControl(checkoutId, predicate) {
  const deadline = Date.now() + options.timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await client.expectStatus(
        `${options.paymentUrl}/debug/controls/${encodeURIComponent(checkoutId)}`,
        {},
        200,
      );
      if (predicate(last)) return last;
    } catch (error) { last = error; }
    await pause(200);
  }
  throw new Error(`Payment control ${checkoutId} did not reach its oracle: ${JSON.stringify(last)}`);
}

function applicationPodSets() {
  return Object.fromEntries(['shop-host', 'shop-warehouse', 'shop-payment']
    .map((component) => [component, componentPods(component)]));
}

function assertApplicationPodsReplaced(before) {
  const after = applicationPodSets();
  for (const component of ['shop-host', 'shop-warehouse', 'shop-payment']) {
    const oldSet = new Set(before[component] ?? []);
    const current = after[component] ?? [];
    const retained = current.filter((pod) => oldSet.has(pod));
    if (oldSet.size !== 2 || current.length !== 2 || retained.length > 0) {
      throw new Error(`Rolling activation did not replace both ${component} pods: ${JSON.stringify({ before: [...oldSet], after: current, retained })}`);
    }
  }
  return after;
}

async function waitApplicationsReady() {
  await Promise.all([
    client.ready('shop-host', options.baseUrl),
    client.ready('shop-warehouse', options.warehouseUrl),
    client.ready('shop-payment', options.paymentUrl),
  ]);
}

function assertSafeScope() {
  const current = raw('kubectl', ['config', 'current-context']);
  if (current !== context) throw new Error(`Refusing resilience mutation in context ${current}`);
  const namespaceObject = JSON.parse(raw('kubectl', ['--context', context, 'get', 'namespace', namespace, '-o', 'json']));
  const labels = namespaceObject.metadata?.labels ?? {};
  if (labels['processengine.io/owner'] !== 'test-shop' || labels['processengine.io/environment'] !== 'docker-desktop') {
    throw new Error('Refusing resilience mutation in an unowned namespace');
  }
}

function assertTwoHosts() {
  const pods = hostPods();
  if (pods.length !== 2) throw new Error(`Expected exactly two shop-host pods, got ${JSON.stringify(pods)}`);
}

async function assertBothHostsServeTraffic() {
  const expected = new Set(hostPods());
  const observed = new Set();
  for (let index = 0; index < 100 && observed.size < expected.size; index += 1) {
    const response = await fetch(`${options.baseUrl}/api/checkouts/missing-${index}`, {
      headers: { connection: 'close' }, signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    const body = await response.json();
    if (typeof body.servedBy === 'string') observed.add(body.servedBy);
  }
  const missing = [...expected].filter((pod) => !observed.has(pod));
  const unexpected = [...observed].filter((pod) => !expected.has(pod));
  if (expected.size !== 2 || missing.length > 0 || unexpected.length > 0) {
    throw new Error(`Service traffic did not reach both host replicas: ${JSON.stringify({ expected: [...expected], observed: [...observed], missing, unexpected })}`);
  }
  console.log(JSON.stringify({ scenario: 'multi-host-inventory', readyPods: [...expected], observedViaService: [...observed] }));
}

function hostPods() { return componentPods('shop-host'); }
function componentPods(component) {
  const value = JSON.parse(raw('kubectl', [
    '--context', context, '--namespace', namespace, 'get', 'pods',
    '-l', `app.kubernetes.io/component=${component}`, '-o', 'json',
  ]));
  return (value.items ?? []).filter((pod) => pod.metadata?.deletionTimestamp === undefined).map((pod) => pod.metadata.name).sort();
}

function scaleStatefulSet(component, replicas) {
  kubectl(['scale', `statefulset/${release}-${component}`, `--replicas=${replicas}`]);
}

function restartCount(pod) {
  const value = JSON.parse(raw('kubectl', ['--context', context, '--namespace', namespace, 'get', 'pod', pod, '-o', 'json']));
  return (value.status?.containerStatuses ?? []).reduce((sum, status) => sum + (status.restartCount ?? 0), 0);
}

function waitForAnyRestart(before) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    for (const [pod, count] of Object.entries(before)) {
      try { if (restartCount(pod) > count) return pod; }
      catch { /* Deployment replacement is also an observable worker restart. */ }
    }
    sleep(250);
  }
  throw new Error('No shop-payment worker restarted after crash-after-commit fixture');
}

function outboxRows(checkoutId) {
  const sql = `SELECT status || '|' || attempt::text || '|' || request_id FROM processengine.outbox WHERE instance_id='${checkoutId}' ORDER BY request_id`;
  const output = raw('kubectl', ['--context', context, '--namespace', namespace, 'exec', `statefulset/${release}-postgres`, '--',
    'psql', '-U', 'processengine', '-d', 'processengine', '-Atc', sql]);
  return output.split('\n').filter(Boolean).map((line) => {
    const [status, attempt, requestId] = line.split('|');
    return { status, attempt: Number(attempt), requestId };
  });
}

async function waitForOutboxAttempt(checkoutId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const row = outboxRows(checkoutId)[0];
    // Claiming changes PENDING -> CLAIMED and increments attempt. Durable proof of
    // a failed publish followed by rescheduling is either of:
    //   * status PENDING with attempt >= 1 (row was rescheduled after a failed
    //     publish and is awaiting its next claim), or
    //   * attempt >= 2 (the record was claimed, its publish did not succeed, it was
    //     rescheduled/lease-reclaimed and claimed again) — a re-claim never happens
    //     for a first, still-in-flight attempt, so this excludes a mere in-flight
    //     claim while remaining robust to sampling the narrow PENDING sub-window,
    //     which under a down broker lasts ~1s between multi-second publish blocks.
    if (row && ((row.status === 'PENDING' && row.attempt >= 1) || row.attempt >= 2)) return row;
    await pause(500);
  }
  throw new Error(`No failed durable outbox attempt was observed for ${checkoutId}`);
}

function deploymentRestartCounts() {
  const result = {};
  for (const component of ['shop-host', 'shop-warehouse', 'shop-payment']) {
    for (const pod of componentPods(component)) result[pod] = restartCount(pod);
  }
  return result;
}

function waitForNoPods(component) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (componentPods(component).length === 0) return;
    sleep(250);
  }
  throw new Error(`${component} pod was not removed`);
}

function kubectl(args) { raw('kubectl', ['--context', context, '--namespace', namespace, ...args], false); }
function helmUpgrade(activeVersion) {
  const version = raw('helm', ['version', '--short']);
  const match = /^v?(\d+)/u.exec(version);
  if (!match?.[1]) throw new Error(`Cannot determine Helm major version from ${version}`);
  const wait = Number(match[1]) >= 4 ? '--wait=legacy' : '--wait';
  raw('helm', ['--kube-context', context, 'upgrade', release, chart, '--namespace', namespace,
    '--reuse-values', '--set-string', `flow.activeVersion=${activeVersion}`, wait, '--wait-for-jobs', '--timeout', '10m'], false);
}
function raw(program, args, capture = true) {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  return (result.stdout ?? '').trim();
}

function input(checkoutId, paymentToken) {
  return { checkoutId, customerId: 'customer-resilience', items: [{ sku: 'SKU-1', quantity: 1 }], paymentToken };
}
function evidence(name, execution, completed, extra = {}) {
  return { name, checkoutId: execution.checkoutId, pendingRevision: execution.persisted.process.revision, finalRevision: completed.revision, ...extra };
}
function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
