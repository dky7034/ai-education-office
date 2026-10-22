// Strict synthetic protocol peer: no provider or model calls, no real credentials.
const tid = 'synthetic-thread', turnId = 'synthetic-turn';
const agent = (text = '합성 설문 요약 초안', phase = 'final_answer') => ({ type: 'agentMessage', id: 'answer', text, phase, memoryCitation: null, delivery: null, questions: null });
const turn = (status = 'inProgress', items = [], error = null) => ({ id: turnId, rootTurnId: turnId,
  status, items, itemsView: 'full', error, startedAt: 1, completedAt: null, durationMs: null });
const notice = (send, method, params) => send({ method, params });
export function executionMessage(message, config, send) {
  const mode = config.mode;
  if (message.method === 'account/login/start') {
    if (mode === 'exec-auth-error') send({ id: message.id, error: { code: -1, message: 'synthetic-secret-error' } });
    else send({ id: message.id, result: { type: 'apiKey' } });
  } else if (message.method === 'account/read') {
    send({ id: message.id, result: { account: mode === 'exec-no-auth' ? null : { type: 'apiKey' }, requiresOpenaiAuth: true } });
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: tid, ephemeral: true }, model: mode === 'exec-wrong-model' ? 'different' : message.params.model,
      modelProvider: 'openai', cwd: process.cwd(), approvalPolicy: 'untrusted',
      sandbox: { type: mode === 'exec-bad-policy' ? 'dangerFullAccess' : 'readOnly', networkAccess: false } } });
  } else if (message.method === 'turn/start') {
    if (mode === 'exec-terminal-start') { send({ id: message.id, result: { turn: turn('completed', [agent()]) } }); return; }
    const early = mode === 'exec-early';
    if (mode === 'exec-rpc-timeout') return;
    if (mode === 'exec-crash') process.exit(1);
    const started = () => send({ id: message.id, result: { turn: turn() } });
    if (!early && !['exec-delayed-start', 'exec-buffer-limit'].includes(mode)) started();
    if (mode === 'exec-delayed-start') { setTimeout(started, 100); return; }
    if (mode === 'exec-hang' || mode === 'exec-interrupt-hang' || mode === 'exec-cancel-completes') return;
    const complete = () => {
      if (mode === 'exec-invalid-event') { notice(send, 'turn/completed', { threadId: tid, turn: {} }); return; }
      if (mode === 'exec-approval') { send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'do-not-execute' } }); return; }
      if (mode === 'exec-buffer-limit') {
        for (let n = 0; n < 65; n++) notice(send, 'turn/started', { threadId: tid, turn: turn() });
        return;
      }
      notice(send, 'turn/started', { threadId: tid, turn: turn() });
      // A foreign thread must never contribute output or change state.
      notice(send, 'item/completed', { threadId: 'foreign', turnId: 'foreign', item: agent('foreign-private-marker') });
      if (mode === 'exec-turn-mismatch') { notice(send, 'item/completed', { threadId: tid, turnId: 'wrong', item: agent() }); return; }
      if (mode === 'exec-unsupported') { notice(send, 'item/started', { threadId: tid, turnId, item: { id: 'cmd', type: 'commandExecution' } }); return; }
      if (mode === 'exec-error' || mode === 'exec-retry') {
        notice(send, 'error', { threadId: tid, turnId, error: { message: 'synthetic-secret-error' }, willRetry: mode === 'exec-retry' });
        if (mode === 'exec-error') return;
      }
      const item = agent(mode === 'exec-long-text' ? 'x'.repeat(17000) : undefined,
        mode === 'exec-commentary' ? 'commentary' : 'final_answer');
      if (mode !== 'exec-empty') {
        notice(send, 'item/started', { threadId: tid, turnId, item, startedAtMs: 1 });
        notice(send, 'item/completed', { threadId: tid, turnId, item, completedAtMs: 2 });
        notice(send, 'item/completed', { threadId: tid, turnId, item, completedAtMs: 2 });
        if (mode === 'exec-item-conflict') { notice(send, 'item/completed', { threadId: tid, turnId, item: agent('changed') }); return; }
      }
      const status = mode === 'exec-failed' ? 'failed' : 'completed';
      const params = { threadId: tid, turn: turn(status, mode === 'exec-empty' ? [] : [item], status === 'failed' ? { message: 'synthetic-secret-error' } : null) };
      notice(send, 'turn/completed', params);
      notice(send, 'turn/completed', params);
    };
    if (early || mode === 'exec-buffer-limit') { complete(); if (early) started(); }
    else setTimeout(complete, 30);
  } else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    if (mode !== 'exec-interrupt-hang') notice(send, 'turn/completed', { threadId: tid,
      turn: mode === 'exec-cancel-completes' ? turn('completed', [agent()]) : turn('interrupted') });
  }
}
