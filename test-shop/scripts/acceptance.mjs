import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const TERMINAL = new Set(['COMPLETED', 'FAULTED']);

export function parseOptions(argv = process.argv.slice(2)) {
  return {
    baseUrl: argument(argv, '--base-url', 'http://127.0.0.1:3000'),
    warehouseUrl: argument(argv, '--warehouse-url', 'http://127.0.0.1:3001'),
    paymentUrl: argument(argv, '--payment-url', 'http://127.0.0.1:3002'),
    timeoutMs: positive(argument(argv, '--timeout-ms', '180000'), '--timeout-ms'),
    requestTimeoutMs: positive(argument(argv, '--request-timeout-ms', '10000'), '--request-timeout-ms'),
    scenario: argument(argv, '--scenario', 'all'),
  };
}

export async function runBusinessAcceptance(options) {
  const client = createClient(options);
  await Promise.all([
    client.ready('shop-host', options.baseUrl),
    client.ready('shop-warehouse', options.warehouseUrl),
    client.ready('shop-payment', options.paymentUrl),
  ]);
  await client.expectStatus(`${options.warehouseUrl}/debug/fixtures/reset`, { method: 'POST' }, 200);
  await client.expectStatus(`${options.paymentUrl}/debug/fixtures/reset`, { method: 'POST' }, 200);
  await assertHttpContracts(client);
  const flows = await loadFlowDefinitions();

  const scenarios = scenarioDefinitions();
  const selected = options.scenario === 'all'
    ? scenarios
    : scenarios.filter((scenario) => scenario.name === options.scenario);
  if (selected.length === 0) throw new TypeError(`Unknown scenario: ${options.scenario}`);

  const results = [];
  for (const scenario of selected) results.push(await runScenario(client, scenario, flows));
  console.log(JSON.stringify({ gate: 'business-acceptance', status: 'PASS', scenarios: results }));
  return results;
}

export function createClient(options) {
  async function request(url, init = {}) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(options.requestTimeoutMs) });
    const text = await response.text();
    let body;
    try { body = text.length === 0 ? undefined : JSON.parse(text); }
    catch { throw new Error(`${init.method ?? 'GET'} ${url} returned non-JSON (${response.status})`); }
    return { response, body };
  }

  async function expectStatus(url, init, status) {
    const result = await request(url, init);
    if (result.response.status !== status) {
      throw new Error(`${init.method ?? 'GET'} ${url}: expected ${status}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
    }
    return result.body;
  }

  async function ready(name, url) {
    const deadline = Date.now() + options.timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await request(`${url}/health/ready`);
        if (last.response.status === 200) return;
      } catch (error) { last = error; }
      await pause(250);
    }
    throw new Error(`${name} did not become ready: ${JSON.stringify(last)}`);
  }

  async function start(input, idempotencyKey) {
    const result = await request(`${options.baseUrl}/api/checkouts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input),
    });
    if (![200, 202].includes(result.response.status)) {
      throw new Error(`checkout start failed (${result.response.status}): ${JSON.stringify(result.body)}`);
    }
    if (typeof result.body?.processId !== 'string' || result.body.processId.length === 0) {
      throw new Error(`checkout start did not return processId: ${JSON.stringify(result.body)}`);
    }
    return result.body;
  }

  async function get(checkoutId) {
    return expectStatus(`${options.baseUrl}/api/checkouts/${encodeURIComponent(checkoutId)}`, {}, 200);
  }

  async function raw(checkoutId) {
    return expectStatus(`${options.baseUrl}/debug/processes/${encodeURIComponent(checkoutId)}`, {}, 200);
  }

  async function waitFor(checkoutId, predicate = (view) => TERMINAL.has(view.processStatus)) {
    const deadline = Date.now() + options.timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await get(checkoutId);
        if (predicate(last)) return last;
      } catch (error) { last = error; }
      await pause(150);
    }
    throw new Error(`checkout ${checkoutId} did not reach expected state: ${JSON.stringify(last)}`);
  }

  return { options, request, expectStatus, ready, start, get, raw, waitFor };
}

export async function assertScenarioLedgers(client, checkoutId, expected) {
  const reservation = await optionalRecord(client, `${client.options.warehouseUrl}/debug/reservations/${encodeURIComponent(checkoutId)}`);
  const payment = await optionalRecord(client, `${client.options.paymentUrl}/debug/payments/${encodeURIComponent(checkoutId)}`);
  const warehouseStats = await client.expectStatus(
    `${client.options.warehouseUrl}/debug/operations/${encodeURIComponent(checkoutId)}`,
    {},
    200,
  );
  const paymentStats = await client.expectStatus(
    `${client.options.paymentUrl}/debug/operations/${encodeURIComponent(checkoutId)}`,
    {},
    200,
  );

  assertSubset(reservation, expected.reservation, `${checkoutId} warehouse reservation`);
  assertSubset(payment, expected.payment, `${checkoutId} payment ledger`);
  assertStats(warehouseStats, expected.warehouseOperations, `${checkoutId} warehouse operations`, expected.warehousePublishedResponses);
  assertStats(paymentStats, expected.paymentOperations, `${checkoutId} payment operations`, expected.paymentPublishedResponses);
  return { reservation, payment, warehouseStats, paymentStats };
}

async function runScenario(client, scenario, flows) {
  const checkoutId = `${scenario.name}-${randomUUID()}`;
  const input = {
    checkoutId,
    customerId: 'customer-acceptance',
    items: [{ sku: 'SKU-1', quantity: 2 }],
    paymentToken: 'tok-ok',
    ...scenario.overrides,
  };
  if (scenario.expectDuplicateDuringExecution) {
    await client.expectStatus(
      `${client.options.paymentUrl}/debug/controls/${encodeURIComponent(checkoutId)}/arm`,
      { method: 'POST' },
      200,
    );
  }
  const starts = await Promise.all(
    Array.from({ length: scenario.concurrentStarts ?? 2 }, () => client.start(input, checkoutId)),
  );
  const ids = new Set(starts.map((item) => item.processId));
  if (ids.size !== 1 || !ids.has(checkoutId)) {
    throw new Error(`${scenario.name}: idempotent starts returned ${JSON.stringify([...ids])}`);
  }
  const completed = await client.waitFor(checkoutId);
  if (completed.processStatus !== 'COMPLETED' || completed.outcome !== scenario.outcome) {
    throw new Error(`${scenario.name}: expected COMPLETED/${scenario.outcome}, got ${JSON.stringify(completed)}`);
  }
  assertSubset(completed.response, scenario.terminalResponse ?? null, `${scenario.name} terminal response`);
  assertSubset(completed.error, scenario.terminalError ?? null, `${scenario.name} terminal error`);
  const terminal = await client.raw(checkoutId);
  assertExactTerminalReference(flows, terminal.process, completed, scenario.name);
  let duplicatePublication;
  if (scenario.expectDuplicateDuringExecution) {
    const control = await waitForPaymentControl(client, checkoutId, (value) => value.duplicate_publications >= 1);
    const messageIds = control.duplicate_message_ids;
    const originalMessageId = `${checkoutId}:authorize-payment:completion`;
    if (control.duplicate_publications !== 1
      || !Array.isArray(messageIds)
      || messageIds.length !== 1
      || new Set(messageIds).size !== 1
      || typeof messageIds[0] !== 'string'
      || messageIds[0] === originalMessageId
      || !messageIds[0].startsWith(`${originalMessageId}:new-message-id:`)) {
      throw new Error(`${scenario.name}: duplicate publication oracle is invalid: ${JSON.stringify(control)}`);
    }
    duplicatePublication = { publications: control.duplicate_publications, messageId: messageIds[0], originalMessageId };
    await pause(1000);
    const settled = await client.raw(checkoutId);
    if (settled.process.revision !== completed.revision
      || settled.process.outcome !== completed.outcome
      || !isDeepStrictEqual(settled.process.results, terminal.process.results)) {
      throw new Error(`${scenario.name}: duplicate service completion advanced the terminal process`);
    }
    console.log(JSON.stringify({ scenario: 'service-side-duplicate-completion', checkoutId,
      fixture: input.paymentToken, terminalRevision: settled.process.revision, ...duplicatePublication }));
  }
  const ledgers = await assertScenarioLedgers(client, checkoutId, scenario);

  if (scenario.lateAfterTimeout) {
    const before = await client.raw(checkoutId);
    const injected = await client.expectStatus(
      `${client.options.paymentUrl}/debug/completions/${encodeURIComponent(checkoutId)}/late-success`,
      { method: 'POST' },
      202,
    );
    if (typeof injected.messageId !== 'string' || injected.messageId.length === 0) {
      throw new Error(`${scenario.name}: late completion fixture did not publish a message`);
    }
    await pause(1000);
    const after = await client.raw(checkoutId);
    if (after.process.revision !== before.process.revision
      || after.process.outcome !== before.process.outcome
      || JSON.stringify(after.process.results) !== JSON.stringify(before.process.results)) {
      throw new Error(`${scenario.name}: a valid late SUCCESS after timeout changed terminal state`);
    }
    await assertScenarioLedgers(client, checkoutId, scenario);
    console.log(JSON.stringify({ scenario: 'late-completion-after-timeout', checkoutId,
      beforeRevision: before.process.revision, afterRevision: after.process.revision }));
  }

  if (scenario.replayCompletion) {
    const before = await client.raw(checkoutId);
    const completionReplay = await client.expectStatus(
      `${client.options.paymentUrl}/debug/completions/${encodeURIComponent(checkoutId)}/replay`,
      { method: 'POST' },
      202,
    );
    if (!Number.isSafeInteger(completionReplay.count) || completionReplay.count < 1) {
      throw new Error(`${scenario.name}: completion replay did not publish a stored response`);
    }
    const injectedMessageIds = [];
    for (const mode of ['new-message-id', 'conflict', 'foreign-source', 'foreign-request-id', 'malformed']) {
      const injected = await client.expectStatus(
        `${client.options.paymentUrl}/debug/completions/${encodeURIComponent(checkoutId)}/${mode}`,
        { method: 'POST' },
        202,
      );
      if (typeof injected.messageId !== 'string' || injected.messageId.length === 0) {
        throw new Error(`${scenario.name}: ${mode} fixture did not publish a message`);
      }
      injectedMessageIds.push(injected.messageId);
    }
    const warehouseReplay = await client.expectStatus(
      `${client.options.warehouseUrl}/debug/commands/${encodeURIComponent(checkoutId)}/replay`,
      { method: 'POST' },
      202,
    );
    const paymentReplay = await client.expectStatus(
      `${client.options.paymentUrl}/debug/commands/${encodeURIComponent(checkoutId)}/replay`,
      { method: 'POST' },
      202,
    );
    if (!Number.isSafeInteger(warehouseReplay.count) || warehouseReplay.count < 1
      || !Number.isSafeInteger(paymentReplay.count) || paymentReplay.count < 1) {
      throw new Error(`${scenario.name}: duplicate command fixtures did not republish stored commands`);
    }
    await pause(1000);
    const after = await client.raw(checkoutId);
    const beforeProcess = before.process;
    const afterProcess = after.process;
    if (beforeProcess.revision !== afterProcess.revision
      || beforeProcess.outcome !== afterProcess.outcome
      || JSON.stringify(beforeProcess.results) !== JSON.stringify(afterProcess.results)) {
      throw new Error(`${scenario.name}: duplicate/late completion changed terminal persisted state`);
    }
    await assertScenarioLedgers(client, checkoutId, scenario);
    console.log(JSON.stringify({ scenario: 'completion-and-command-duplicates', checkoutId,
      beforeRevision: beforeProcess.revision, afterRevision: afterProcess.revision,
      variants: ['same-message-id', 'new-message-id', 'conflicting-error', 'foreign-source',
        'foreign-request-id', 'malformed', 'duplicate-command'],
      completionReplayCount: completionReplay.count,
      warehouseCommandReplayCount: warehouseReplay.count,
      paymentCommandReplayCount: paymentReplay.count,
      injectedMessageIds }));
  }
  return {
    name: scenario.name,
    checkoutId,
    processId: completed.processId,
    outcome: completed.outcome,
    revision: completed.revision,
    warehouseOperations: ledgers.warehouseStats.total,
    paymentOperations: ledgers.paymentStats.total,
    ...(duplicatePublication ? { duplicatePublication } : {}),
  };
}

function scenarioDefinitions() {
  return [
    {
      name: 'success', outcome: 'APPROVED', concurrentStarts: 12, replayCompletion: true,
      terminalResponse: { resultCode: 'CONFIRMED' },
      reservation: { status: 'ACTIVE', reserve_effects: 1, release_effects: 0 },
      payment: { status: 'CONFIRMED', authorize_effects: 1, confirm_effects: 1 },
      warehouseOperations: { 'warehouse.reserve': 1 },
      paymentOperations: { 'payment.authorize': 1, 'payment.confirm': 1 },
    },
    {
      name: 'service-duplicate-completion', outcome: 'APPROVED', expectDuplicateDuringExecution: true,
      overrides: { paymentToken: 'tok-duplicate-completion' },
      terminalResponse: { resultCode: 'CONFIRMED' },
      reservation: { status: 'ACTIVE', reserve_effects: 1, release_effects: 0 },
      payment: { status: 'CONFIRMED', authorize_effects: 1, confirm_effects: 1 },
      warehouseOperations: { 'warehouse.reserve': 1 },
      paymentOperations: { 'payment.authorize': 1, 'payment.confirm': 1 },
    },
    {
      name: 'out-of-stock', outcome: 'OUT_OF_STOCK',
      terminalError: { code: 'OUT_OF_STOCK' },
      overrides: { items: [{ sku: 'OUT-OF-STOCK', quantity: 1 }] },
      reservation: null, payment: null,
      warehouseOperations: { 'warehouse.reserve': 1 }, paymentOperations: {},
    },
    {
      name: 'warehouse-error', outcome: 'WAREHOUSE_UNAVAILABLE',
      terminalError: { code: 'WAREHOUSE_UNAVAILABLE' },
      overrides: { items: [{ sku: 'WAREHOUSE-ERROR', quantity: 1 }] },
      reservation: null, payment: null,
      warehouseOperations: { 'warehouse.reserve': 1 }, paymentOperations: {},
    },
    {
      name: 'warehouse-handler-failed', outcome: 'WAREHOUSE_HANDLER_FAILED',
      terminalError: { code: 'HANDLER_FAILED' },
      overrides: { items: [{ sku: 'WAREHOUSE-THROW', quantity: 1 }] },
      reservation: null, payment: null,
      warehouseOperations: { 'warehouse.reserve': 1 }, paymentOperations: {},
    },
    {
      name: 'payment-declined', outcome: 'PAYMENT_DECLINED', overrides: { paymentToken: 'tok-declined' },
      terminalResponse: { resultCode: 'DECLINED' },
      reservation: { status: 'RELEASED', reserve_effects: 1, release_effects: 1 },
      payment: { status: 'DECLINED', authorize_effects: 1, confirm_effects: 0 },
      warehouseOperations: { 'warehouse.reserve': 1, 'warehouse.release': 1 },
      paymentOperations: { 'payment.authorize': 1 },
    },
    {
      name: 'payment-error', outcome: 'PAYMENT_ERROR_COMPENSATED', overrides: { paymentToken: 'tok-payment-error' },
      terminalError: { code: 'PAYMENT_UNAVAILABLE' },
      reservation: { status: 'RELEASED', reserve_effects: 1, release_effects: 1 }, payment: null,
      warehouseOperations: { 'warehouse.reserve': 1, 'warehouse.release': 1 },
      paymentOperations: { 'payment.authorize': 1 },
    },
    {
      name: 'payment-error-stock-compensation-failure', outcome: 'COMPENSATION_FAILED',
      overrides: { paymentToken: 'tok-payment-error-stock-compensation-fail' },
      terminalError: { code: 'COMPENSATION_FAILED' },
      reservation: { status: 'ACTIVE', reserve_effects: 1, release_effects: 0 }, payment: null,
      warehouseOperations: { 'warehouse.reserve': 1, 'warehouse.release': 1 },
      paymentOperations: { 'payment.authorize': 1 },
    },
    {
      name: 'payment-timeout', outcome: 'PAYMENT_ERROR_COMPENSATED', lateAfterTimeout: true,
      overrides: { paymentToken: 'tok-no-response' },
      terminalError: { code: 'PROCESSENGINE_COMPLETION_TIMEOUT' },
      reservation: { status: 'RELEASED', reserve_effects: 1, release_effects: 1 }, payment: null,
      warehouseOperations: { 'warehouse.reserve': 1, 'warehouse.release': 1 },
      paymentOperations: { 'payment.authorize': 1 }, paymentPublishedResponses: 0,
    },
    {
      name: 'confirm-failure', outcome: 'PAYMENT_CONFIRM_FAILED', overrides: { paymentToken: 'tok-confirm-fail' },
      terminalResponse: { resultCode: 'CONFIRM_FAILED' },
      reservation: { status: 'RELEASED', reserve_effects: 1, release_effects: 1 },
      payment: { status: 'CANCELLED', authorize_effects: 1, confirm_effects: 1, cancel_effects: 1 },
      warehouseOperations: { 'warehouse.reserve': 1, 'warehouse.release': 1 },
      paymentOperations: { 'payment.authorize': 1, 'payment.confirm': 1, 'payment.cancel': 1 },
    },
    {
      name: 'confirm-failure-stock-compensation-failure', outcome: 'COMPENSATION_FAILED',
      overrides: { paymentToken: 'tok-confirm-fail-stock-compensation-fail' },
      terminalError: { code: 'COMPENSATION_FAILED' },
      reservation: { status: 'ACTIVE', reserve_effects: 1, release_effects: 0 },
      payment: { status: 'CANCELLED', authorize_effects: 1, confirm_effects: 1, cancel_effects: 1 },
      warehouseOperations: { 'warehouse.reserve': 1, 'warehouse.release': 1 },
      paymentOperations: { 'payment.authorize': 1, 'payment.confirm': 1, 'payment.cancel': 1 },
    },
    {
      name: 'confirm-error', outcome: 'PAYMENT_CONFIRM_ERROR_COMPENSATED', overrides: { paymentToken: 'tok-confirm-error' },
      terminalError: { code: 'PAYMENT_CONFIRM_UNAVAILABLE' },
      reservation: { status: 'RELEASED', reserve_effects: 1, release_effects: 1 },
      payment: { status: 'CANCELLED', authorize_effects: 1, confirm_effects: 0, cancel_effects: 1 },
      warehouseOperations: { 'warehouse.reserve': 1, 'warehouse.release': 1 },
      paymentOperations: { 'payment.authorize': 1, 'payment.confirm': 1, 'payment.cancel': 1 },
    },
    {
      name: 'confirm-error-stock-compensation-failure', outcome: 'COMPENSATION_FAILED',
      overrides: { paymentToken: 'tok-confirm-error-stock-compensation-fail' },
      terminalError: { code: 'COMPENSATION_FAILED' },
      reservation: { status: 'ACTIVE', reserve_effects: 1, release_effects: 0 },
      payment: { status: 'CANCELLED', authorize_effects: 1, confirm_effects: 0, cancel_effects: 1 },
      warehouseOperations: { 'warehouse.reserve': 1, 'warehouse.release': 1 },
      paymentOperations: { 'payment.authorize': 1, 'payment.confirm': 1, 'payment.cancel': 1 },
    },
    {
      name: 'confirm-error-payment-compensation-failure', outcome: 'PAYMENT_COMPENSATION_FAILED',
      overrides: { paymentToken: 'tok-confirm-error-payment-compensation-fail' },
      terminalError: { code: 'PAYMENT_CANCEL_UNAVAILABLE' },
      reservation: { status: 'ACTIVE', reserve_effects: 1, release_effects: 0 },
      payment: { status: 'AUTHORIZED', authorize_effects: 1, confirm_effects: 0, cancel_effects: 0 },
      warehouseOperations: { 'warehouse.reserve': 1 },
      paymentOperations: { 'payment.authorize': 1, 'payment.confirm': 1, 'payment.cancel': 1 },
    },
    {
      name: 'payment-compensation-failure', outcome: 'PAYMENT_COMPENSATION_FAILED', overrides: { paymentToken: 'tok-cancel-error' },
      terminalError: { code: 'PAYMENT_CANCEL_UNAVAILABLE' },
      reservation: { status: 'ACTIVE', reserve_effects: 1, release_effects: 0 },
      payment: { status: 'CONFIRM_FAILED', authorize_effects: 1, confirm_effects: 1, cancel_effects: 0 },
      warehouseOperations: { 'warehouse.reserve': 1 },
      paymentOperations: { 'payment.authorize': 1, 'payment.confirm': 1, 'payment.cancel': 1 },
    },
    {
      name: 'compensation-failure', outcome: 'COMPENSATION_FAILED', overrides: { paymentToken: 'tok-compensation-fail' },
      terminalError: { code: 'COMPENSATION_FAILED' },
      reservation: { status: 'ACTIVE', reserve_effects: 1, release_effects: 0 },
      payment: { status: 'DECLINED', authorize_effects: 1, confirm_effects: 0 },
      warehouseOperations: { 'warehouse.reserve': 1, 'warehouse.release': 1 },
      paymentOperations: { 'payment.authorize': 1 },
    },
  ];
}

async function loadFlowDefinitions() {
  const definitions = await Promise.all(['v1', 'v2'].map(async (name) =>
    JSON.parse(await readFile(new URL(`../flows/shop.checkout.${name}.json`, import.meta.url), 'utf8'))));
  return new Map(definitions.map((definition) => [`${definition.id}@${definition.version}`, definition]));
}

function assertExactTerminalReference(flows, process, projected, scenarioName) {
  const flow = flows.get(`${process.flow?.id}@${process.flow?.version}`);
  if (!flow) throw new Error(`${scenarioName}: persisted process references an unknown flow artifact`);
  const end = flow.steps?.[process.currentStep];
  if (end?.type !== 'end' || end.outcome !== process.outcome) {
    throw new Error(`${scenarioName}: terminal step/outcome does not match persisted state: ${JSON.stringify({
      currentStep: process.currentStep, processOutcome: process.outcome, end,
    })}`);
  }

  let expectedResponse = null;
  let expectedError = null;
  if (end.input !== undefined) {
    const result = process.results?.[end.input.step];
    if (!result) throw new Error(`${scenarioName}: terminal reference points to a missing result ${end.input.step}`);
    if (end.input.resultType === 'response') {
      if (result.status !== 'SUCCESS' || result.error !== null) {
        throw new Error(`${scenarioName}: terminal response reference does not point to a canonical SUCCESS result`);
      }
      expectedResponse = result.response;
    } else if (end.input.resultType === 'error') {
      if (result.status !== 'ERROR' || result.response !== null) {
        throw new Error(`${scenarioName}: terminal error reference does not point to a canonical ERROR result`);
      }
      expectedError = result.error;
    } else {
      throw new Error(`${scenarioName}: terminal resultType is invalid: ${String(end.input.resultType)}`);
    }
  }

  if (!isDeepStrictEqual(process.response, expectedResponse)
    || !isDeepStrictEqual(process.error, expectedError)
    || !isDeepStrictEqual(projected.response, process.response)
    || !isDeepStrictEqual(projected.error, process.error)
    || projected.outcome !== process.outcome
    || projected.revision !== process.revision) {
    throw new Error(`${scenarioName}: terminal projection does not exactly match the persisted end reference: ${JSON.stringify({
      expectedResponse, expectedError, persistedResponse: process.response, persistedError: process.error,
      projectedResponse: projected.response, projectedError: projected.error,
    })}`);
  }
}

async function waitForPaymentControl(client, checkoutId, predicate) {
  const deadline = Date.now() + client.options.timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await client.expectStatus(
        `${client.options.paymentUrl}/debug/controls/${encodeURIComponent(checkoutId)}`,
        {},
        200,
      );
      if (predicate(last)) return last;
    } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`Payment control ${checkoutId} did not reach its acceptance oracle: ${JSON.stringify(last)}`);
}

async function optionalRecord(client, url) {
  const result = await client.request(url);
  if (result.response.status === 404) return null;
  if (result.response.status !== 200) throw new Error(`${url}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

function assertSubset(actual, expected, label) {
  if (expected === null) {
    if (actual !== null) throw new Error(`${label}: expected no record, got ${JSON.stringify(actual)}`);
    return;
  }
  if (actual === null || Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertStats(actual, expectedOperations, label, expectedPublished) {
  const expectedTotal = Object.values(expectedOperations).reduce((sum, value) => sum + value, 0);
  const published = expectedPublished ?? expectedTotal;
  if (actual.total !== expectedTotal || actual.publishedResponses !== published) {
    throw new Error(`${label}: expected total=${expectedTotal}, published=${published}, got ${JSON.stringify(actual)}`);
  }
  const actualOperations = Object.fromEntries(Object.entries(actual.operations).filter(([, count]) => count !== 0));
  if (JSON.stringify(sorted(actualOperations)) !== JSON.stringify(sorted(expectedOperations))) {
    throw new Error(`${label}: expected ${JSON.stringify(expectedOperations)}, got ${JSON.stringify(actual.operations)}`);
  }
  if (!Array.isArray(actual.requestIds) || new Set(actual.requestIds).size !== expectedTotal) {
    throw new Error(`${label}: request IDs are missing or duplicated: ${JSON.stringify(actual.requestIds)}`);
  }
}

async function assertHttpContracts(client) {
  const checkoutId = `http-contract-${randomUUID()}`;
  const valid = { checkoutId, customerId: 'customer-http-contract', items: [{ sku: 'SKU-1', quantity: 1 }], paymentToken: 'tok-ok' };
  const missingKey = await client.request(`${client.options.baseUrl}/api/checkouts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid),
  });
  if (missingKey.response.status !== 400) throw new Error(`Missing idempotency key must return 400, got ${missingKey.response.status}`);
  const invalid = await client.request(`${client.options.baseUrl}/api/checkouts`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `${checkoutId}-invalid` }, body: '{}',
  });
  if (invalid.response.status !== 400) throw new Error(`Invalid checkout must return 400, got ${invalid.response.status}`);
  await client.start(valid, checkoutId);
  const conflict = await client.request(`${client.options.baseUrl}/api/checkouts`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': checkoutId },
    body: JSON.stringify({ ...valid, paymentToken: 'tok-declined' }),
  });
  if (conflict.response.status !== 409) throw new Error(`Idempotency conflict must return 409, got ${conflict.response.status}`);
  const completed = await client.waitFor(checkoutId);
  if (completed.outcome !== 'APPROVED') throw new Error('HTTP contract fixture did not complete');
  await assertScenarioLedgers(client, checkoutId, {
    reservation: { status: 'ACTIVE', reserve_effects: 1, release_effects: 0 },
    payment: { status: 'CONFIRMED', authorize_effects: 1, confirm_effects: 1 },
    warehouseOperations: { 'warehouse.reserve': 1 },
    paymentOperations: { 'payment.authorize': 1, 'payment.confirm': 1 },
  });
}

function sorted(value) { return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))); }
function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function positive(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}
function argument(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new TypeError(`${name} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBusinessAcceptance(parseOptions());
}
