"""Coding graph-domain fake Runtime on Runtime Contract 0.1.0 ("review a synthetic candidate").

Ported from the OD-281 cross-language graph_fake.py (docs/design/runtime-contract-crosslang/) to the 0.1.0 text:
argv template placeholders instead of lab paths, `retry-later` on BUSY, RC-11 tombstone answers, RC-09 failed and
cancelled result reads, PERMISSION_REVOKED when the Host reports a cited grant revoked, and file-based fault
injection under the instance directory (fault.json) instead of lab files and environment variables. The execution
profile requirement, when the bundle's own manifest.json names one, is checked at initialize; without one the
graph domain runs and execution requests fail. The capability schema digest comes from the bundled
capabilities/<id>.json. Domain state is a JSON file under the instance directory; the writer lock is an exclusive
flock in the same directory (no Git). Test-only injection actions are marked. Never shipped.

Usage: python3 -B graph_fake.py <instanceDir> <contractDigest>
       python3 -B graph_fake.py hold-lock <instanceDir>      (C-11: a second writer holding the domain lock)
fault.json keys: slowHealth (seconds), snapshotLease (seconds; 0 expires every page after the first), indexLost, crashAfterWrite (actionId),
dropResponse (method: processed, answer dropped), ignoreHostAnswer (method: the Host's answer is discarded),
busy (method), rejectProtocol, mutateAfterSnapshot, slowRead (seconds), ignoreAcks, wrongContext,
delayEvents (seconds) with eventGap (seconds): a transaction's events leave after its answer, one at a time (KB-308).
"""
import base64
import fcntl
import hashlib
import json
import os
import queue
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from fake_framing import FrameError, LineReader, parse_frame  # noqa: E402

PROTOCOL_VERSION = '0.1.0-draft.5'
LIMITS = {'frameBytes': 1048576, 'depth': 32, 'members': 1000, 'inFlight': 32, 'bufferBytes': 4194304, 'eventWindow': 128, 'pageObjects': 100, 'textCharacters': 65536}
EVENT_WINDOW_BYTES = 4194304
CAPABILITY_ID = 'csthink.test.graph'
# Kept equal (after canonicalization) with GRAPH_SCHEMA in graph-contract.ts; the bundled schema member is the shipped copy.
CAPABILITY_SCHEMA = {'type': 'object', 'properties': {'choice': {'type': 'string', 'minLength': 1, 'maxLength': 64}, 'arguments': {'type': 'object'}}, 'required': ['choice'], 'additionalProperties': False}
OPTIONAL_PROFILE_IDS = ['coding-implementer/claude-print-restricted', 'review/codex-native-readonly']
ACTIONS = ['candidate.review', 'candidate.revise', 'execution.request', 'context.capture', 'context.readback', 'text.roundtrip', 'inject.events', 'epoch.rotate', 'ops.tombstone', 'emit.badframe', 'stderr.flood', 'wait.capture']
TEST_ONLY_ACTIONS = {'inject.events', 'emit.badframe', 'stderr.flood', 'wait.capture'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha_json(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


CAPABILITY = {'id': CAPABILITY_ID, 'version': PROTOCOL_VERSION, 'schemaDigest': sha_json(CAPABILITY_SCHEMA), 'required': True}


class DomainError(Exception):
    def __init__(self, code, message, recovery='none', absence_proven=False):
        super().__init__(message)
        self.code, self.recovery, self.absence_proven = code, recovery, absence_proven


def hold_lock(instance_dir):
    """C-11: hold the domain writer lock until stdin closes, so that a new incarnation meets a second writer."""
    directory = Path(instance_dir) / 'graph-runtime'
    directory.mkdir(parents=True, exist_ok=True)
    lock = (directory / 'writer.lock').open('a+')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    sys.stdout.write('held\n')
    sys.stdout.flush()
    sys.stdin.read()
    lock.close()


class Runtime:
    def __init__(self, instance_dir, contract_digest):
        self.instance_dir = Path(instance_dir).resolve()
        self.contract_digest = contract_digest
        self.fault_path = self.instance_dir / 'fault.json'
        manifest = json.loads((HERE / 'manifest.json').read_bytes())
        requirement = next((r for r in manifest.get('executionProfileRequirements', []) if r['capabilityId'] == CAPABILITY_ID), None)
        self.required_profile = requirement['profile'] if requirement else None
        self.out_lock = threading.Lock()
        self.state_lock = threading.RLock()
        self.pending = {}
        self.serial = 0
        self.context = None
        self.bundle_digest = None
        self.ready = False
        self.profiles = {}
        self.limits = LIMITS
        self.scopes = {}
        self.bindings = {}
        self.snapshots = {}
        self.subscriptions = {}
        self.subscription_serial = 0
        self.held = []
        self.releasing = False
        self.in_flight = 0
        self.max_in_flight = 0
        self.lock = None
        self.dir = self.instance_dir / 'graph-runtime'
        self.dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.dir / 'state.json'
        self.state = json.loads(self.state_path.read_bytes()) if self.state_path.exists() else {
            'generation': 0, 'revision': 0, 'candidateRevision': 1, 'reviewed': False, 'reviewedAt': None, 'pendingSince': now(), 'text': '', 'counter': 0, 'executions': {},
            'operations': {}, 'idempotency': {}, 'tombstones': {}, 'captures': {}, 'stream': {'streamId': 'stream:graph', 'epoch': 'epoch:1', 'seq': 0}, 'events': []}
        self.log = (self.dir / 'runtime.log').open('a')
        self.worker = queue.Queue()
        threading.Thread(target=self.worker_loop, daemon=True).start()

    # ---------------------------------------------------------------- injection
    def fault(self):
        try:
            return json.loads(self.fault_path.read_bytes())
        except Exception:  # noqa: BLE001
            return {}

    # ---------------------------------------------------------------- IO
    def emit(self, value):
        with self.out_lock:
            sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
            sys.stdout.flush()

    def emit_raw(self, data):
        with self.out_lock:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()

    def note(self, *parts):
        self.log.write(' '.join(str(p) for p in parts) + '\n')
        self.log.flush()

    def host(self, method, params, timeout=20.0):
        with self.out_lock:
            self.serial += 1
            rid = 'r:%d' % self.serial
            q = queue.Queue()
            self.pending[rid] = q
        self.emit({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': {'context': self.context, **params}})
        # C-03 (runtime side): the Host's answer to this method is discarded as if it never arrived.
        if self.fault().get('ignoreHostAnswer') == method:
            timeout = min(timeout, 1.5)
            try:
                q.get(timeout=timeout)
            except queue.Empty:
                pass
            self.pending.pop(rid, None)
            raise DomainError('RESULT_UNKNOWN', 'host %s: answer lost; query by operationId' % method, 'query')
        try:
            reply = q.get(timeout=timeout)
        except queue.Empty:
            self.pending.pop(rid, None)
            raise DomainError('RESULT_UNKNOWN', 'host %s: no answer within %.0fs (lost response); query by operationId' % (method, timeout), 'query')
        self.pending.pop(rid, None)
        if 'error' in reply:
            data = reply['error'].get('data') or {}
            raise DomainError(data.get('code', 'HOST_ERROR'), 'host %s: %s' % (method, reply['error'].get('message')), data.get('recovery', 'none'))
        return reply['result']

    def error(self, mid, code, message, scope=None, op=None, recovery='none', rpc=-32000, absence=False):
        err = {'code': rpc, 'message': message[:2048]}
        if rpc == -32000:
            err['data'] = {'code': code, 'scopeRef': scope, 'operationId': op, 'recovery': recovery, 'absenceProven': absence}
        self.emit({'jsonrpc': '2.0', 'id': mid, 'error': err})

    def reply(self, mid, result):
        self.emit({'jsonrpc': '2.0', 'id': mid, 'result': {'context': self.context, **result} if self.context else result})

    def persist(self):
        tmp = self.state_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=1))
        os.replace(tmp, self.state_path)

    # ---------------------------------------------------------------- dispatch
    def handle(self, message):
        mid, method, params = message.get('id'), message['method'], message.get('params') or {}
        drop = self.fault().get('dropResponse') == method
        try:
            if method == 'runtime.initialize':
                result = self.initialize(params)
                if not drop:
                    self.reply(mid, result)
                return
            if not isinstance(params.get('context'), dict) or params['context'] != self.context:
                return self.error(mid, 'PERMISSION_DENIED', 'context does not match this connection binding (connection or control generation)', recovery='reconnect')
            fn = getattr(self, 'm_' + method.replace('runtime.', '').replace('.', '_'), None)
            if fn is None:
                return self.error(mid, None, 'method not found: ' + method, rpc=-32601)
            result = fn(params)
            if result is not None and not drop:
                self.reply(mid, result)
        except DomainError as exc:
            if not drop:
                self.error(mid, exc.code, str(exc), params.get('scopeRef'), params.get('operationId'), exc.recovery, absence=exc.absence_proven)
        except Exception as exc:  # noqa: BLE001
            self.note('EXCEPTION', method, traceback.format_exc())
            if not drop:
                self.error(mid, 'PRECONDITION_CONFLICT', '%s: %s' % (type(exc).__name__, exc), params.get('scopeRef'), params.get('operationId'))
        finally:
            with self.state_lock:
                self.in_flight -= 1

    def require_ready(self):
        if not self.ready:
            raise DomainError('PRECONDITION_CONFLICT', 'runtime not ready')

    def scope(self, ref, need_active=True):
        s = self.scopes.get(ref)
        if not s:
            raise DomainError('NOT_FOUND', 'unknown scope ' + str(ref), absence_proven=True)
        if need_active and not s['active']:
            raise DomainError('PERMISSION_DENIED', 'scope inactive: authorize first', 'reauthorize')
        return s

    def scope_ref(self):
        return next(iter(self.scopes)) if self.scopes else 'scope:none'

    # ---------------------------------------------------------------- lifecycle
    def initialize(self, p):
        f = self.fault()
        selected = next((x for x in p['protocols'] if x['version'] == PROTOCOL_VERSION and x['contractDigest'] == self.contract_digest), None)
        if not selected or f.get('rejectProtocol'):
            raise DomainError('UNSUPPORTED_VERSION', 'no exactly matching protocol identity (version and contractDigest)')
        if not any(c['id'] == CAPABILITY['id'] and c['version'] == CAPABILITY['version'] and c['schemaDigest'] == CAPABILITY['schemaDigest'] for c in p['capabilities']):
            raise DomainError('UNSUPPORTED_CAPABILITY', 'required capability not offered with the exact schema digest')
        offered = {x['id']: x for x in p['executionProfiles']}
        required = self.required_profile
        # A bundle without an execution profile requirement runs the graph domain without executions
        # (a Host without an execution port, such as the product before its embedded port): every
        # execution.request then fails with UNSUPPORTED_CAPABILITY instead of refusing the Runtime.
        if required is not None:
            if required['id'] in offered and offered[required['id']]['digest'] != required['digest']:
                raise DomainError('UNSUPPORTED_CAPABILITY', 'profile %s offered with another digest; same id different digest is incompatible' % required['id'])
            if required['id'] not in offered:
                raise DomainError('UNSUPPORTED_CAPABILITY', 'required execution profile missing: ' + required['id'])
        # Optional profiles: the product's two Agent profiles are selected when offered, so one bundle
        # can request Implementer and Reviewer executions (feature-t30 S-02); the required one stays first.
        optional = {pid: offered[pid] for pid in OPTIONAL_PROFILE_IDS if pid in offered and (required is None or pid != required['id'])}
        lock = (self.dir / 'writer.lock').open('a+')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            raise DomainError('WRITER_CONFLICT', 'another writer holds the domain writer lock', 'reconnect')
        self.lock = lock
        # Negotiated profiles by id; the bundle's required one (when any) is the default of execution.request.
        self.profiles = ({required['id']: offered[required['id']]} if required is not None else {})
        self.profiles.update(optional)
        self.limits = {k: min(v, LIMITS[k]) for k, v in p['limits'].items()}
        self.bundle_digest = p['bundleDigest']
        with self.state_lock:
            self.state['generation'] += 1
            self.persist()
        self.context = {'protocolVersion': PROTOCOL_VERSION, 'contractDigest': self.contract_digest, 'installationId': p['installationId'], 'instanceId': p['instanceId'],
                        'incarnationId': p['incarnationId'], 'connectionId': p['connectionId'], 'controlGeneration': str(self.state['generation'])}
        if f.get('wrongContext'):
            self.context = {**self.context, 'connectionId': 'connection:forged'}
        # C-02: only the required capability is negotiated; an unknown optional capability offered by the Host is left out of the intersection.
        return {'context': self.context, 'selectedProtocol': selected, 'capabilities': [CAPABILITY], 'limits': self.limits,
                'executionProfiles': [{'id': x['id'], 'version': x['version'], 'digest': x['digest']} for x in self.profiles.values()], 'recovery': 'snapshot-and-operation-query'}

    def m_ready(self, p):
        self.ready = True
        return {'ready': True}

    def m_health(self, p):
        f = self.fault()
        if f.get('slowHealth'):  # C-10 injection: hold each health handler so that in-flight requests accumulate
            time.sleep(float(f['slowHealth']))
        return {'health': 'ready' if self.ready else 'degraded', 'reason': ''}

    def m_scope_open(self, p):
        self.require_ready()
        b = p['binding']
        if b['bindingRef'] in self.bindings:
            ref = self.bindings[b['bindingRef']]
            if self.scopes[ref]['resourceHandle'] != b['resourceHandle']:
                raise DomainError('PRECONDITION_CONFLICT', 'binding already maps to a different resource identity')
            return {'scopeRef': ref, 'bindingRef': b['bindingRef'], 'state': 'inactive'}
        same = next((ref for ref, s in self.scopes.items() if s['resourceHandle'] == b['resourceHandle']), None)
        if same:
            self.bindings[b['bindingRef']] = same
            return {'scopeRef': same, 'bindingRef': b['bindingRef'], 'state': 'inactive'}
        if self.scopes:
            raise DomainError('RESOURCE_LIMIT', 'this fake binds one resource per instance')
        ref = 'scope:graph-1'
        self.bindings[b['bindingRef']] = ref
        self.scopes[ref] = {'bindingRef': b['bindingRef'], 'resourceHandle': b['resourceHandle'], 'grants': [], 'operations': [], 'active': False}
        return {'scopeRef': ref, 'bindingRef': b['bindingRef'], 'state': 'inactive'}

    def m_scope_authorize(self, p):
        self.require_ready()
        s = self.scope(p['scopeRef'], need_active=False)
        grants = self.host('host.grants.get', {'grantRefs': p['grantRefs']})['grants'] if p['grantRefs'] else []
        usable = [g for g in grants if g['status'] == 'active' and g['scopeRef'] == p['scopeRef'] and g['resourceHandle'] == s['resourceHandle'] and g['expiresAt'] > now() and g['capability'] == CAPABILITY['id']]
        s['grants'] = [g['ref'] for g in usable]
        s['operations'] = sorted({g['operation'] for g in usable})
        s['active'] = 'graph.read' in s['operations']
        return {'scopeRef': p['scopeRef'], 'state': 'active' if s['active'] else 'inactive'}

    def check_grants(self, scope_ref, refs, operation):
        s = self.scope(scope_ref)
        held = {(g['id'], g['revision']) for g in s['grants']}
        # C-08: revocation blocks new access immediately; the Host is asked for the current grant state on every access, the cached set is not trusted alone
        current = self.host('host.grants.get', {'grantRefs': refs})['grants'] if refs else []
        by_id = {g['ref']['id']: g for g in current}
        for ref in refs:
            known = by_id.get(ref['id'])
            if known and (known['status'] != 'active' or known['expiresAt'] <= now()):
                raise DomainError('PERMISSION_REVOKED', 'grant %s is %s at the Host' % (ref['id'], known['status'] if known['status'] != 'active' else 'expired'), 'reauthorize')
            if (ref['id'], ref['revision']) not in held:
                raise DomainError('PERMISSION_DENIED', 'grantRefs are not part of the authorized set (stale or foreign)', 'reauthorize')
        live = [g for g in current if g['status'] == 'active' and g['expiresAt'] > now() and g['scopeRef'] == scope_ref]
        if len(live) != len(refs):
            raise DomainError('PERMISSION_DENIED', 'a grant of the request is not live for this scope at the Host', 'reauthorize')
        if operation not in {g['operation'] for g in live}:
            raise DomainError('PERMISSION_DENIED', 'no active grant carries ' + operation, 'reauthorize')

    # ---------------------------------------------------------------- projection
    def candidate_ref(self, state):
        return 'candidate:1.r%d' % state['candidateRevision']

    def evidence_ref(self, state):
        data = self.candidate_bytes(state)
        return {'authority': 'runtime', 'resourceHandle': self.scopes[self.scope_ref()]['resourceHandle'] if self.scopes else 'resource:none', 'scopeRef': self.scope_ref(), 'objectRef': 'candidate:1',
                'revision': 'rev:%d' % state['candidateRevision'], 'mediaType': 'text/markdown', 'bytes': len(data), 'digest': sha_bytes(data)}

    def candidate_bytes(self, state):
        return ('# candidate revision %d\n\n%s\n' % (state['candidateRevision'], state['text'])).encode('utf-8')

    def action(self, state, aid, obj, label, human=False, candidate=None, enabled=True, code=None, reason=''):
        return {'scopeRef': self.scope_ref(), 'actionId': aid, 'objectRef': obj, 'capability': CAPABILITY, 'label': label, 'expectedRevision': 'rev:%d' % state['revision'],
                'candidateRef': candidate, 'payloadSchemaDigest': CAPABILITY['schemaDigest'], 'enabled': enabled, 'disabledReason': reason, 'disabledCode': code, 'requiresHumanDecision': human}

    def projection(self, state):
        scope = self.scope_ref()
        rev = 'rev:%d' % state['revision']
        project = {'scopeRef': scope, 'objectRef': 'project:1', 'revision': rev, 'title': 'Synthetic project', 'stateLabel': 'ops:%d' % len(state['operations']), 'capability': CAPABILITY,
                   'view': {'kind': 'list', 'rows': [{'id': 'text', 'title': 'round-trip text', 'detail': state['text'][:65536]}, {'id': 'counter', 'title': 'flood counter', 'detail': str(state['counter'])},
                                                     {'id': 'executions', 'title': 'executions', 'detail': str(len(state['executions']))}]}, 'evidence': []}
        stage = 'accepted' if state['reviewed'] else 'review'
        candidate = {'scopeRef': scope, 'objectRef': 'candidate:1', 'revision': 'rev:%d' % state['candidateRevision'], 'title': 'Synthetic candidate', 'stateLabel': stage, 'capability': CAPABILITY,
                     'view': {'kind': 'graph', 'nodes': [{'id': 'draft', 'label': 'Draft', 'stateLabel': 'done', 'kind': 'stage'}, {'id': 'review', 'label': 'Review', 'stateLabel': 'done' if state['reviewed'] else 'active', 'kind': 'gate'},
                                                         {'id': 'accepted', 'label': 'Accepted', 'stateLabel': 'done' if state['reviewed'] else 'pending', 'kind': 'stage'}],
                              'edges': [{'id': 'e1', 'source': 'draft', 'target': 'review', 'label': 'submit', 'semantics': 'advance'}, {'id': 'e2', 'source': 'review', 'target': 'accepted', 'label': 'approve', 'semantics': 'gate'}]},
                     'evidence': [self.evidence_ref(state)]}
        actions = [self.action(state, 'candidate.review', 'candidate:1', 'Review the candidate (human decision)', human=True, candidate=self.candidate_ref(state), enabled=not state['reviewed'],
                               code=None if not state['reviewed'] else 'ALREADY_REVIEWED', reason='' if not state['reviewed'] else 'candidate already reviewed'),
                   self.action(state, 'candidate.revise', 'candidate:1', 'Revise the candidate'), self.action(state, 'context.capture', 'candidate:1', 'Capture the candidate into Host context'),
                   self.action(state, 'context.readback', 'candidate:1', 'Read the captured Host snapshot back'),
                   self.action(state, 'wait.capture', 'candidate:1', 'Capture while the Host holds (test-only)'), self.action(state, 'execution.request', 'project:1', 'Request an execution'),
                   self.action(state, 'text.roundtrip', 'project:1', 'Store round-trip text'), self.action(state, 'inject.events', 'project:1', 'Inject crafted events (test-only)'),
                   self.action(state, 'epoch.rotate', 'project:1', 'Rotate the projection epoch'), self.action(state, 'ops.tombstone', 'project:1', 'Tombstone an old operation'),
                   self.action(state, 'emit.badframe', 'project:1', 'Emit an invalid frame (test-only)'), self.action(state, 'stderr.flood', 'project:1', 'Flood stderr (test-only)')]
        pending = [{'scopeRef': scope, 'itemRef': 'pending:review', 'revision': 'rev:%d' % state['candidateRevision'], 'objectRef': 'candidate:1', 'capability': CAPABILITY, 'title': 'Review the synthetic candidate',
                    'typeId': 'candidate-review', 'typeLabel': 'Candidate review', 'status': 'processed' if state['reviewed'] else 'pending', 'pendingSince': state['pendingSince'],
                    'updatedAt': state['reviewedAt'] or state['pendingSince'], 'processedAt': state['reviewedAt'], 'blocking': not state['reviewed'], 'actionIds': [] if state['reviewed'] else ['candidate.review'],
                    'evidence': [self.evidence_ref(state)]}]
        return [project, candidate], actions, pending

    def operation_view(self, op):
        return {'operationId': op['operationId'], 'scopeRef': op['scopeRef'], 'requestDigest': op['requestDigest'], 'status': op['status'], 'resultRef': None,
                'executionRef': op.get('executionRef'), 'reason': op.get('reason', '')[:2048], 'resultCode': op.get('resultCode'), 'revision': 'op-rev:%d' % op['revision']}

    # ---------------------------------------------------------------- transactions and events
    def transaction(self, mutate, crash_after_write=False):
        with self.state_lock:
            state = self.state
            before_objects, before_actions, before_pending = self.projection(state)
            before_ops = json.loads(json.dumps(state['operations']))
            result = mutate(state)
            state['revision'] += 1
            after_objects, after_actions, after_pending = self.projection(state)
            base = {'scopeRef': self.scope_ref(), 'streamId': state['stream']['streamId'], 'epoch': state['stream']['epoch'], 'causationId': None}
            events = []
            bo = {o['objectRef']: o for o in before_objects}
            for o in after_objects:
                if canonical(bo.get(o['objectRef'])) != canonical(o):
                    events.append({**base, 'kind': 'object.upsert', 'payload': o})
            ba = {a['actionId'] + '@' + a['objectRef']: a for a in before_actions}
            for a in after_actions:
                if canonical(ba.get(a['actionId'] + '@' + a['objectRef'])) != canonical(a):
                    events.append({**base, 'kind': 'action.upsert', 'payload': a})
            bp = {i['itemRef']: i for i in before_pending}
            for i in after_pending:
                if canonical(bp.get(i['itemRef'])) != canonical(i):
                    events.append({**base, 'kind': 'pending.upsert', 'payload': i})
            for oid, op in state['operations'].items():
                if canonical(before_ops.get(oid)) != canonical(op):
                    events.append({**base, 'kind': 'operation.changed', 'payload': self.operation_view(op)})
            for ev in events:
                state['stream']['seq'] += 1
                ev['seq'] = str(state['stream']['seq'])
                ev['eventId'] = 'event:%s:%s' % (state['stream']['epoch'].split(':')[1], ev['seq'])
                ev['domainRevision'] = 'rev:%d' % state['revision']
                state['events'].append(ev)
            state['events'] = state['events'][-2000:]
            self.persist()
            if crash_after_write:
                self.note('CRASH_AFTER_WRITE injected')
                os._exit(3)
            self.publish(events)
            return result

    def publish(self, events):
        # KB-308 (test-only): like hp, the answer can leave before the projection events of the same change, which then
        # follow one at a time. Held events keep their order and later transactions queue behind them.
        f = self.fault()
        if not f.get('delayEvents') and not self.held:
            for sid in list(self.subscriptions):
                self.deliver(sid, events)
            return
        with self.state_lock:
            self.held.extend(events)
            if self.releasing:
                return
            self.releasing = True
        threading.Thread(target=self.release, args=(float(f.get('delayEvents') or 0), float(f.get('eventGap') or 0)), daemon=True).start()

    def release(self, delay, gap):
        # Clearing delayEvents in fault.json releases what is held at once.
        deadline = time.monotonic() + delay
        while time.monotonic() < deadline and self.fault().get('delayEvents'):
            time.sleep(0.05)
        while True:
            with self.state_lock:
                if not self.held:
                    self.releasing = False
                    return
                ev = self.held.pop(0)
            for sid, sub in list(self.subscriptions.items()):
                # A subscription opened meanwhile has replayed the event from the log already.
                if int(ev['seq']) > int(sub['sent']):
                    self.deliver(sid, [ev])
            if self.fault().get('delayEvents'):
                time.sleep(gap)

    def deliver(self, sid, events):
        sub = self.subscriptions.get(sid)
        if not sub:
            return
        with sub['lock']:
            sub['queue'].extend(events)
            self.drain(sub, sid)

    def drain(self, sub, sid):
        # C-10: at most eventWindow unacknowledged frames (and EVENT_WINDOW_BYTES) in flight; the rest waits for an ack.
        while sub['queue']:
            unacked = int(sub['sent']) - int(sub['acked'])
            if unacked >= self.limits['eventWindow'] or sub['unackedBytes'] >= EVENT_WINDOW_BYTES:
                sub['paused'] = True
                return
            ev = sub['queue'].pop(0)
            frame = {'jsonrpc': '2.0', 'method': 'runtime.event', 'params': {'context': self.context, 'event': {'subscriptionId': sid, **ev}}}
            data = json.dumps(frame, ensure_ascii=False, separators=(',', ':'))
            sub['sent'] = int(ev['seq'])
            sub['unackedBytes'] += len(data) + 1
            sub['paused'] = False
            self.emit(frame)

    def emit_event_raw(self, sid, ev):
        self.emit({'jsonrpc': '2.0', 'method': 'runtime.event', 'params': {'context': self.context, 'event': {'subscriptionId': sid, **ev}}})

    # ---------------------------------------------------------------- snapshot, subscription, ack
    def page_size(self):
        return min(self.limits['pageObjects'], 3)

    def m_snapshot_open(self, p):
        self.require_ready()
        self.scope(p['scopeRef'])
        with self.state_lock:
            objects, actions, pend = self.projection(self.state)
            items = [('objects', o) for o in objects] + [('actions', a) for a in actions] + [('pendingItems', i) for i in pend]
            sid = 'snapshot:%d' % (len(self.snapshots) + 1)
            configured = self.fault().get('snapshotLease')
            lease = 60.0 if configured is None else float(configured)
            self.snapshots[sid] = {'scopeRef': p['scopeRef'], 'items': items, 'revision': 'rev:%d' % self.state['revision'], 'throughSeq': str(self.state['stream']['seq']), 'epoch': self.state['stream']['epoch'],
                                   'expires': time.time() + lease, 'expiresAt': datetime.fromtimestamp(time.time() + lease, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
        return self.page(sid, 0)

    def page(self, sid, index):
        snap = self.snapshots[sid]
        # The first page is part of snapshot.open; the lease governs every later page (C-05 uses a zero lease, so
        # expiry never depends on how fast the Host asks for the next page).
        if index > 0 and time.time() >= snap['expires']:
            raise DomainError('RESYNC_REQUIRED', 'snapshot lease expired', 'resync')
        size = self.page_size()
        chunk = snap['items'][index * size:(index + 1) * size]
        page = {'objects': [], 'actions': [], 'pendingItems': []}
        for kind, item in chunk:
            page[kind].append(item)
        more = (index + 1) * size < len(snap['items'])
        if not more and self.fault().get('mutateAfterSnapshot'):
            # C-05: a domain write lands after the last page and before the subscription; it must arrive through replay.
            threading.Timer(0.02, lambda: self.transaction(lambda state: state.__setitem__('counter', state['counter'] + 1))).start()
        return {'scopeRef': snap['scopeRef'], 'snapshotId': sid, 'revision': snap['revision'], 'streamId': self.state['stream']['streamId'], 'epoch': snap['epoch'], 'throughSeq': snap['throughSeq'],
                'expiresAt': snap['expiresAt'], **page, 'nextPageToken': ('page:%s:%d' % (sid.split(':')[1], index + 1)) if more else None}

    def m_snapshot_next(self, p):
        self.require_ready()
        self.scope(p['scopeRef'])
        if p['snapshotId'] not in self.snapshots:
            raise DomainError('RESYNC_REQUIRED', 'unknown snapshot', 'resync')
        parts = p['pageToken'].split(':')
        if len(parts) != 3 or 'snapshot:' + parts[1] != p['snapshotId']:
            raise DomainError('PRECONDITION_CONFLICT', 'page token does not belong to this snapshot')
        return self.page(p['snapshotId'], int(parts[2]))

    def m_events_subscribe(self, p):
        self.require_ready()
        self.scope(p['scopeRef'])
        with self.state_lock:
            stream = self.state['stream']
            if p['streamId'] != stream['streamId'] or p['epoch'] != stream['epoch']:
                raise DomainError('RESYNC_REQUIRED', 'stream identity or epoch changed; take a full snapshot', 'resync')
            after = int(p['afterSeq'])
            if after > stream['seq']:
                raise DomainError('PRECONDITION_CONFLICT', 'afterSeq is beyond the stream')
            if self.state['events'] and int(self.state['events'][0]['seq']) > after + 1:
                raise DomainError('RESYNC_REQUIRED', 'replay log no longer covers afterSeq', 'resync')
            replaced = None
            for old in [k for k, v in self.subscriptions.items() if v['scopeRef'] == p['scopeRef']]:
                replaced = old
                self.subscriptions.pop(old)
            self.subscription_serial += 1
            sid = 'subscription:%d' % self.subscription_serial
            replay = [e for e in self.state['events'] if int(e['seq']) > after]
            self.subscriptions[sid] = {'scopeRef': p['scopeRef'], 'acked': after, 'sent': after, 'unackedBytes': 0, 'queue': [], 'lock': threading.RLock(), 'paused': False}
            through = stream['seq']
        threading.Thread(target=self.replay, args=(sid, replay, through), daemon=True).start()
        return {'subscriptionId': sid, 'replacedSubscriptionId': replaced}

    def replay(self, sid, events, through):
        time.sleep(0.03)
        sub = self.subscriptions.get(sid)
        if not sub:
            return
        with sub['lock']:
            sub['queue'] = events + sub['queue']
            self.drain(sub, sid)
            if not sub['queue']:
                self.emit_event_raw(sid, {'kind': 'stream.caughtUp', 'scopeRef': self.scope_ref(), 'streamId': self.state['stream']['streamId'], 'epoch': self.state['stream']['epoch'], 'throughSeq': str(through)})
            else:
                sub['caughtUpPending'] = str(through)

    def m_events_ack(self, p):
        sub = self.subscriptions.get(p['subscriptionId'])
        if not sub:
            raise DomainError('RESYNC_REQUIRED', 'unknown or replaced subscription', 'resync')
        seq = int(p['seq'])
        if seq > int(self.state['stream']['seq']):
            raise DomainError('PRECONDITION_CONFLICT', 'cannot acknowledge an undelivered sequence')
        if self.fault().get('ignoreAcks'):
            # C-10: acknowledgements are answered but not applied, so the unacknowledged window fills and delivery pauses.
            return {'acknowledgedSeq': str(sub['acked'])}
        with sub['lock']:
            if seq > sub['acked']:
                sub['acked'] = seq
                sub['unackedBytes'] = 0 if sub['acked'] >= sub['sent'] else sub['unackedBytes']
            self.drain(sub, p['subscriptionId'])
            if not sub['queue'] and sub.get('caughtUpPending') is not None:
                through = sub.pop('caughtUpPending')
                self.emit_event_raw(p['subscriptionId'], {'kind': 'stream.caughtUp', 'scopeRef': self.scope_ref(), 'streamId': self.state['stream']['streamId'], 'epoch': self.state['stream']['epoch'], 'throughSeq': through})
        return {'acknowledgedSeq': str(sub['acked'])}

    # ---------------------------------------------------------------- resources and operations
    def m_resource_read(self, p):
        self.require_ready()
        self.check_grants(p['scopeRef'], p['grantRefs'], 'graph.read')
        slow = self.fault().get('slowRead')
        if slow:
            time.sleep(float(slow))
        ref = p['evidence']
        if ref['authority'] != 'runtime' or ref['scopeRef'] != p['scopeRef']:
            raise DomainError('PERMISSION_DENIED', 'runtime.resource.read accepts runtime-authority evidence of this scope only')
        if ref['objectRef'].startswith('execution-result:'):
            final = self.state['executions'].get(ref['objectRef'].split(':', 1)[1])
            if not final:
                raise DomainError('NOT_FOUND', 'no such execution result', absence_proven=True)
            if final['state'] == 'stopped':
                raise DomainError('CANCELLED', 'the execution was cancelled; its record and events are kept, there is no result to read')
            if final['state'] == 'failed':
                raise DomainError('EXECUTION_FAILED', 'the execution failed: ' + final.get('reason', ''))
            if final['state'] == 'unknown':
                raise DomainError('RESULT_UNKNOWN', 'the execution outcome is unknown', 'query')
            data = (final.get('resultText') or '').encode('utf-8')
        elif ref['objectRef'] == 'candidate:1':
            data = self.candidate_bytes(self.state)
        else:
            raise DomainError('NOT_FOUND', 'unknown evidence object', absence_proven=True)
        if len(data) != ref['bytes'] or sha_bytes(data) != ref['digest']:
            raise DomainError('INTEGRITY_MISMATCH', 'evidence identity does not match the current bytes')
        chunk = data[p['offset']:p['offset'] + p['length']]
        return {'resourceHandle': ref['resourceHandle'], 'revision': ref['revision'], 'offset': p['offset'], 'dataBase64': base64.b64encode(chunk).decode(), 'eof': p['offset'] + len(chunk) >= len(data), 'digest': ref['digest']}

    def digest_of(self, method, p):
        body = {k: v for k, v in p.items() if k not in ('context', 'requestDigest')}
        return sha_json({'method': method, **body})

    def m_operation_get(self, p):
        self.require_ready()
        self.scope(p['scopeRef'])
        op = self.state['operations'].get(p['operationId'])
        if op:
            return self.operation_view(op)
        if p['operationId'] in self.state['tombstones']:
            raise DomainError('RESULT_UNKNOWN', 'operation result retired to a tombstone; identity and digest are kept, the result is not', 'query')
        if self.fault().get('indexLost'):
            raise DomainError('RESULT_UNKNOWN', 'operation index incomplete: absence cannot be proven', 'query')
        raise DomainError('NOT_FOUND', 'operation never accepted by this runtime', 'query', absence_proven=True)

    def dedupe(self, scope, method, key, op_id, digest):
        k = '|'.join([scope, method, key])
        e = self.state['idempotency'].get(k)
        if e:
            if e['digest'] != digest or e['operationId'] != op_id:
                raise DomainError('IDEMPOTENCY_CONFLICT', 'same idempotency key with a different request digest or operation', 'review')
            op = self.state['operations'].get(op_id)
            if op:
                return op
            # RC-11: the same key and digest after the result was retired answers unknown, never a new operation.
            return {'operationId': op_id, 'scopeRef': scope, 'requestDigest': digest, 'status': 'unknown', 'reason': 'tombstone: result retired, identity kept', 'revision': 1, 'resultCode': None}
        if self.state['operations'].get(op_id) or op_id in self.state['tombstones']:
            raise DomainError('IDEMPOTENCY_CONFLICT', 'operationId reused with another key', 'review')
        return None

    def m_action_invoke(self, p):
        self.require_ready()
        self.scope(p['scopeRef'])
        self.check_grants(p['scopeRef'], p['grantRefs'], 'graph.read')
        digest = self.digest_of('runtime.action.invoke', p)
        if digest != p['requestDigest']:
            raise DomainError('PRECONDITION_CONFLICT', 'requestDigest mismatch')
        with self.state_lock:
            return self.invoke_locked(p, digest)

    def invoke_locked(self, p, digest):
        # dedupe and the transaction run under one lock so that concurrent entries of the same intent produce one operation (C-08)
        existing = self.dedupe(p['scopeRef'], 'runtime.action.invoke', p['idempotencyKey'], p['operationId'], digest)
        if existing:
            return self.operation_view(existing)
        objects, actions, _ = self.projection(self.state)
        offered = next((a for a in actions if a['actionId'] == p['actionId'] and a['objectRef'] == p['objectRef']), None)
        if not offered:
            raise DomainError('PRECONDITION_CONFLICT', 'action not offered for this object', 'resync')
        if not offered['enabled']:
            raise DomainError('PRECONDITION_CONFLICT', 'action disabled: ' + offered['disabledCode'], 'resync')
        if offered['expectedRevision'] != p['expectedRevision']:
            raise DomainError('PRECONDITION_CONFLICT', 'stale expectedRevision', 'resync')
        if (offered['candidateRef'] or None) != (p.get('candidateRef') or None):
            raise DomainError('PRECONDITION_CONFLICT', 'candidate changed since the request was prepared', 'resync')
        payload = p['payload']
        if not isinstance(payload.get('choice'), str) or not 1 <= len(payload['choice']) <= 64 or set(payload) - {'choice', 'arguments'}:
            raise DomainError('PRECONDITION_CONFLICT', 'payload violates the capability schema')
        args = payload.get('arguments') or {}
        if offered['requiresHumanDecision']:
            if not p.get('decisionRef'):
                raise DomainError('PERMISSION_DENIED', 'human decision required', 'review')
            dec = self.host('host.decision.get', {'scopeRef': p['scopeRef'], 'decisionRef': p['decisionRef']})
            for k in ('actionId', 'objectRef', 'candidateRef', 'expectedRevision', 'requestDigest'):
                if dec[k] != p[k]:
                    raise DomainError('PERMISSION_DENIED', 'decision does not bind ' + k, 'review')
            if dec['domainOperationId'] != p['operationId'] or dec['status'] != 'valid':
                raise DomainError('PERMISSION_DENIED', 'decision invalid for this operation', 'review')
        crash = self.fault().get('crashAfterWrite') == p['actionId']

        def mutate(state):
            op = {'operationId': p['operationId'], 'scopeRef': p['scopeRef'], 'requestDigest': digest, 'status': 'succeeded', 'revision': 1, 'reason': '', 'resultCode': None, 'executionRef': None,
                  'actionId': p['actionId'], 'args': args, 'grantRefs': p['grantRefs'], 'decisionRef': p.get('decisionRef')}
            state['operations'][op['operationId']] = op
            state['idempotency']['|'.join([p['scopeRef'], 'runtime.action.invoke', p['idempotencyKey']])] = {'digest': digest, 'operationId': op['operationId']}
            aid = p['actionId']
            if aid == 'candidate.review':
                state['reviewed'], state['reviewedAt'] = True, now()
                op['reason'] = 'candidate reviewed'
            elif aid == 'candidate.revise':
                state['candidateRevision'] += 1
                state['text'] = args.get('text', state['text'])
                op['reason'] = 'candidate revised to r%d' % state['candidateRevision']
            elif aid == 'text.roundtrip':
                state['text'] = args.get('text', '')
                # C-01: the domain reports its own canonical digest of the arguments so the Host can compare cross-language canonicalization
                op['reason'] = 'arguments-digest:' + sha_json(args)
            elif aid == 'epoch.rotate':
                # The subscriptions stay: the events of this very transaction already carry the new epoch, and a
                # Host that receives an event of another epoch must take a full snapshot (Contract "快照、事件与竞争").
                n = int(state['stream']['epoch'].split(':')[1]) + 1
                state['stream'] = {'streamId': state['stream']['streamId'], 'epoch': 'epoch:%d' % n, 'seq': 0}
                state['events'] = []
                for sub in self.subscriptions.values():
                    sub['acked'], sub['sent'], sub['unackedBytes'] = 0, 0, 0
                op['reason'] = 'epoch rotated'
            elif aid == 'ops.tombstone':
                target = args.get('operationId')
                old = state['operations'].pop(target, None)
                if old is None:
                    op['status'], op['resultCode'], op['reason'] = 'failed', 'NOT_FOUND', 'no such operation to tombstone'
                else:
                    state['tombstones'][target] = {'requestDigest': old['requestDigest'], 'retiredAt': now()}
                    op['reason'] = 'tombstoned ' + target
            elif aid == 'inject.events':
                if args.get('vector', '').startswith('flood'):
                    state['counter'] += 1
                op['reason'] = 'inject ' + args.get('vector', '')
            elif aid in ('execution.request', 'context.capture', 'wait.capture', 'context.readback'):
                op['status'] = 'accepted'
                op['reason'] = 'queued'
            else:
                op['reason'] = 'test-only side channel: ' + aid
            return op
        op = self.transaction(mutate, crash_after_write=crash)
        aid = p['actionId']
        if aid in ('execution.request', 'context.capture', 'wait.capture', 'context.readback'):
            self.worker.put(op['operationId'])
        elif aid == 'inject.events':
            self.inject(args.get('vector', ''), args)
        elif aid == 'emit.badframe':
            threading.Timer(0.05, self.bad_frame, args=(args.get('kind', 'bom'),)).start()
        elif aid == 'stderr.flood':
            threading.Timer(0.05, self.stderr_flood).start()
        return self.operation_view(op)

    # ---------------------------------------------------------------- test-only injections
    def inject(self, vector, args=None):
        args = args or {}
        sids = list(self.subscriptions)
        if vector.startswith('flood:'):
            n = int(vector.split(':')[1])
            for _ in range(n):
                self.transaction(lambda state: state.__setitem__('counter', state['counter'] + 1))
            return
        if not sids:
            return
        sid = sids[-1]
        events = self.state['events']
        last = events[-1] if events else None
        if vector == 'duplicate' and last:
            self.emit_event_raw(sid, last)
        elif vector == 'tamper' and last:
            forged = json.loads(json.dumps(last))
            field = {'object.upsert': 'title', 'action.upsert': 'label', 'pending.upsert': 'title', 'operation.changed': 'reason'}[forged['kind']]
            forged['payload'] = {**forged['payload'], field: 'forged same-seq payload'}
            self.emit_event_raw(sid, forged)
        elif vector == 'gap' and last:
            skipped = json.loads(json.dumps(last))
            skipped['seq'] = str(int(last['seq']) + 2)
            skipped['eventId'] = 'event:gap:' + skipped['seq']
            self.emit_event_raw(sid, skipped)
        elif vector == 'old-subscription' and last:
            self.emit_event_raw(args.get('sid', 'subscription:0'), last)
        elif vector == 'old-context' and last:
            stale = {**self.context, 'connectionId': 'connection:stale', 'controlGeneration': '0'}
            self.emit({'jsonrpc': '2.0', 'method': 'runtime.event', 'params': {'context': stale, 'event': {'subscriptionId': sid, **last}}})
        elif vector == 'old-epoch' and last:
            old = json.loads(json.dumps(last))
            old['epoch'] = 'epoch:0'
            self.emit_event_raw(sid, old)

    def bad_frame(self, kind):
        frames = {'bom': b'\xef\xbb\xbf{"jsonrpc":"2.0","method":"runtime.event","params":{}}\n', 'utf8': b'{"jsonrpc":"2.0","method":"runtime.event","params":{"x":"\xff\xfe"}}\n',
                  'dupkey': b'{"jsonrpc":"2.0","jsonrpc":"2.0","method":"runtime.event","params":{}}\n', 'array': b'[{"jsonrpc":"2.0","method":"runtime.event"}]\n',
                  'nan': b'{"jsonrpc":"2.0","method":"runtime.event","params":{"n":NaN}}\n', 'nonobject-params': b'{"jsonrpc":"2.0","method":"runtime.event","params":[1]}\n',
                  'depth': b'{"jsonrpc":"2.0","method":"runtime.event","params":' + b'{"a":' * 40 + b'1' + b'}' * 40 + b'}\n',
                  'oversize': b'{"jsonrpc":"2.0","method":"runtime.event","params":{"pad":"' + b'x' * (self.limits['frameBytes'] + 1024) + b'"}}\n',
                  'never-newline': b'{"jsonrpc":"2.0","method":"runtime.event","params":{"pad":"' + b'y' * (self.limits['frameBytes'] + 65536)}
        self.emit_raw(frames[kind])

    def stderr_flood(self):
        chunk = b'stderr flood ' * 8192
        for _ in range(64):
            sys.stderr.buffer.write(chunk)
        sys.stderr.buffer.flush()

    # ---------------------------------------------------------------- cancel, lifecycle
    def m_operation_cancel(self, p):
        self.require_ready()
        self.scope(p['scopeRef'])
        digest = self.digest_of('runtime.operation.cancel', p)
        if digest != p['requestDigest']:
            raise DomainError('PRECONDITION_CONFLICT', 'requestDigest mismatch')
        existing = self.dedupe(p['scopeRef'], 'runtime.operation.cancel', p['idempotencyKey'], p['operationId'], digest)
        if existing:
            return self.operation_view(existing)
        target = self.state['operations'].get(p['targetOperationId'])
        if not target:
            raise DomainError('NOT_FOUND', 'target operation unknown', 'query', absence_proven=True)

        def mutate(state):
            op = {'operationId': p['operationId'], 'scopeRef': p['scopeRef'], 'requestDigest': digest, 'status': 'succeeded', 'revision': 1, 'reason': '', 'resultCode': None, 'executionRef': None, 'actionId': 'cancel'}
            state['operations'][op['operationId']] = op
            state['idempotency']['|'.join([p['scopeRef'], 'runtime.operation.cancel', p['idempotencyKey']])] = {'digest': digest, 'operationId': op['operationId']}
            t = state['operations'][p['targetOperationId']]
            if t['status'] in ('succeeded', 'failed', 'cancelled', 'unknown'):
                op['reason'] = 'target already terminal: ' + t['status']
            else:
                t['cancelRequested'] = True
                t['revision'] += 1
                op['reason'] = 'cancel accepted; physical stop and domain result are reported separately'
            return op
        op = self.transaction(mutate)
        target = self.state['operations'][p['targetOperationId']]
        if target.get('cancelRequested') and target.get('executionRef'):
            try:
                cancel_id = 'op:hostcancel:' + p['operationId'].replace(':', '-')
                params = {'operationId': cancel_id, 'idempotencyKey': 'intent:' + cancel_id, 'scopeRef': p['scopeRef'], 'executionRef': target['executionRef']}
                params['requestDigest'] = self.digest_of('host.execution.cancel', params)
                self.host('host.execution.cancel', params)
            except DomainError as exc:
                self.note('host cancel', exc)
        return self.operation_view(op)

    def lifecycle_op(self, p, method):
        digest = self.digest_of(method, p)
        if digest != p['requestDigest']:
            raise DomainError('PRECONDITION_CONFLICT', 'requestDigest mismatch')
        existing = self.dedupe('instance', method, p['idempotencyKey'], p['operationId'], digest)
        if existing:
            return self.operation_view(existing)

        def mutate(state):
            op = {'operationId': p['operationId'], 'scopeRef': 'instance', 'requestDigest': digest, 'status': 'succeeded', 'revision': 1, 'reason': p['reason'][:2048], 'resultCode': None, 'executionRef': None, 'actionId': method}
            state['operations'][op['operationId']] = op
            state['idempotency']['|'.join(['instance', method, p['idempotencyKey']])] = {'digest': digest, 'operationId': op['operationId']}
            return op
        return self.operation_view(self.transaction(mutate))

    def m_quiesce(self, p):
        return self.lifecycle_op(p, 'runtime.quiesce')

    def m_shutdown(self, p):
        r = self.lifecycle_op(p, 'runtime.shutdown')
        threading.Timer(0.3, lambda: os._exit(0)).start()
        return r

    # ---------------------------------------------------------------- worker: executions and captures through the Host
    def worker_loop(self):
        while True:
            op_id = self.worker.get()
            try:
                op = self.state['operations'][op_id]
                if op['actionId'] == 'execution.request':
                    self.run_execution(op_id)
                elif op['actionId'] == 'context.readback':
                    self.run_readback(op_id)
                else:
                    self.run_capture(op_id)
            except Exception:  # noqa: BLE001
                self.note('WORKER EXCEPTION', traceback.format_exc())

    def finish(self, op_id, status, reason, code=None):
        def mutate(state):
            op = state['operations'][op_id]
            op['status'], op['reason'], op['resultCode'] = status, reason[:2048], code
            op['revision'] += 1
            return op
        self.transaction(mutate)

    def run_readback(self, op_id):
        # the domain reads a Host snapshot of its own scope back through host.resource.read and compares the bytes with its source
        op = self.state['operations'][op_id]
        receipts = [r for r in self.state['captures'].values() if r['status'] == 'succeeded' and r['snapshots']]
        if not receipts:
            return self.finish(op_id, 'failed', 'no succeeded capture to read back', 'NOT_FOUND')
        snapshot = receipts[-1]['snapshots'][0]['snapshot']
        try:
            chunks, offset = [], 0
            while True:
                r = self.host('host.resource.read', {'scopeRef': op['scopeRef'], 'evidence': snapshot, 'grantRefs': op['grantRefs'], 'offset': offset, 'length': 4096})
                data = base64.b64decode(r['dataBase64'])
                chunks.append(data)
                offset += len(data)
                if r['eof'] or not data:
                    break
            data = b''.join(chunks)
            ok = len(data) == snapshot['bytes'] and sha_bytes(data) == snapshot['digest']
            self.finish(op_id, 'succeeded' if ok else 'failed', 'readback %d bytes, digest %s' % (len(data), 'matches' if ok else 'differs'), None if ok else 'INTEGRITY_MISMATCH')
        except DomainError as exc:
            self.finish(op_id, 'failed', str(exc), exc.code)

    def run_capture(self, op_id):
        op = self.state['operations'][op_id]
        scope = op['scopeRef']
        cap_id = 'op:capture:' + op_id.replace(':', '-')
        params = {'operationId': cap_id, 'idempotencyKey': 'intent:' + cap_id, 'scopeRef': scope, 'domainOperationId': op_id, 'sources': [self.evidence_ref(self.state)], 'grantRefs': op['grantRefs']}
        params['requestDigest'] = self.digest_of('host.context.capture', params)
        try:
            try:
                receipt = self.host('host.context.capture', params)
            except DomainError as exc:
                if exc.code != 'RESULT_UNKNOWN':
                    raise
                # C-03: the capture answer was lost; the same operationId is queried, never re-created with a new key
                receipt = self.host('host.context.get', {'scopeRef': scope, 'operationId': cap_id})
            with self.state_lock:
                self.state['captures'][op_id] = receipt
            self.finish(op_id, 'succeeded' if receipt['status'] == 'succeeded' else 'failed', 'capture %s: %d snapshot(s)' % (receipt['status'], len(receipt['snapshots'])))
        except DomainError as exc:
            self.finish(op_id, 'failed', str(exc), exc.code)

    def run_execution(self, op_id):
        op = self.state['operations'][op_id]
        args = op['args']
        scope = op['scopeRef']
        s = self.scopes[scope]
        # args.profileId selects one of the negotiated profiles (default: the bundle's required one); args.binding
        # overrides the model connection fields for the product's Agent profiles (feature-t30 S-02); args.contextFromCapture
        # passes the snapshots of the latest succeeded capture as contextRefs; args.waitSeconds (default 60, at most 900)
        # is how long the domain polls host.execution.get for a terminal state (real Agent runs outlast a fixture).
        wanted = args.get('profileId')
        if wanted is not None:
            profile = self.profiles.get(wanted)
            if profile is None:
                raise DomainError('UNSUPPORTED_CAPABILITY', 'execution profile %s was not negotiated' % wanted)
        else:
            if self.required_profile is None or self.required_profile['id'] not in self.profiles:
                raise DomainError('UNSUPPORTED_CAPABILITY', 'no execution profile negotiated: the bundle requires none and the Host offers no execution port')
            profile = self.profiles[self.required_profile['id']]
        n = len(self.state['executions']) + 1
        over = args.get('binding') or {}
        binding = {'profileDigest': profile['digest'], 'agent': over.get('agent', 'agent:fake-agent'), 'model': over.get('model', 'installation-default'), 'modelVendor': over.get('modelVendor', 'vendor:synthetic'), 'routeVendor': None, 'credentialRef': over.get('credentialRef', 'credential:none'), 'configurationRevision': over.get('configurationRevision', '1')}
        context_refs = []
        if args.get('contextFromCapture'):
            receipts = [r for r in self.state['captures'].values() if r['status'] == 'succeeded' and r['snapshots']]
            if not receipts:
                raise DomainError('NOT_FOUND', 'no succeeded capture to pass as context', absence_proven=True)
            context_refs = [item['snapshot'] for item in receipts[-1]['snapshots']]
        req = {'operationId': 'op:exec:%d' % n, 'idempotencyKey': 'intent:exec:%d' % n, 'scopeRef': scope, 'profileId': profile['id'], 'profileDigest': profile['digest'], 'domainOperationId': op_id,
               'domainNodeRef': over.get('domainNodeRef', 'node:review'), 'roleIntent': over.get('roleIntent', 'role:implementer'), 'resourceHandle': s['resourceHandle'], 'targetBinding': over.get('targetBinding'), 'connectionRef': over.get('connectionRef', 'model-connection:fake'), 'configurationRevision': over.get('configurationRevision', '1'),
               'model': over.get('model', 'installation-default'), 'executionBinding': binding, 'constraints': [{'kind': 'budget', 'value': 'maxToolCalls=%d' % profile['maxToolCalls'], 'enforcer': 'host', 'guarantee': 'interface-enforced'}],
               'contextRefs': context_refs, 'grantRefs': args.get('grantRefs', op['grantRefs']), 'decisionRef': None,
               'budget': {'maxToolCalls': min(profile['maxToolCalls'], int(args.get('maxToolCalls', profile['maxToolCalls']))), 'maxRunSeconds': min(profile['maxRunSeconds'], int(args.get('maxRunSeconds', 20))), 'maxOutputBytes': int(args.get('maxOutputBytes', 1048576)), 'cleanupSeconds': int(args.get('cleanupSeconds', 5))}}
        req['requestDigest'] = self.digest_of('host.execution.start', req)
        record = {'domainOperationId': op_id, 'state': None, 'reason': '', 'resultText': None, 'executionRef': None, 'stopReason': None, 'accounting': None}
        try:
            if args.get('preflight'):
                pre = {k: req[k] for k in ('scopeRef', 'profileId', 'profileDigest', 'connectionRef', 'configurationRevision', 'executionBinding', 'constraints')}
                self.host('host.execution.preflight', pre)
            try:
                started = self.host('host.execution.start', req)
            except DomainError as exc:
                if exc.code != 'RESULT_UNKNOWN':
                    raise
                # C-03: the start answer was lost; the operation is queried by its id, no second physical execution is created
                started = self.host('host.operation.get', {'scopeRef': scope, 'operationId': req['operationId']})
            record['executionRef'] = started.get('executionRef')

            def running(state):
                o = state['operations'][op_id]
                o['executionRef'], o['status'] = record['executionRef'], 'running'
                o['revision'] += 1
                return o
            self.transaction(running)
            final = None
            deadline = time.time() + min(900.0, max(1.0, float(args.get('waitSeconds', 60))))
            while time.time() < deadline:
                phys = self.host('host.execution.get', {'scopeRef': scope, 'executionRef': record['executionRef']})
                if phys['state'] in ('completed', 'failed', 'stopped', 'unknown'):
                    final = phys
                    break
                time.sleep(0.1)
            if final is None:
                raise DomainError('RESULT_UNKNOWN', 'execution did not reach a terminal state in time', 'query')
            record.update({'state': final['state'], 'reason': final.get('reason', ''), 'stopReason': final.get('stopReason'), 'accounting': final.get('accounting'), 'resultText': 'result of %s: %s' % (op_id, final['state'])})
            if final['state'] == 'completed' and args.get('readResult'):
                ref, data = final['resultRef'], b''
                while len(data) < ref['bytes']:
                    part = self.host('host.resource.read', {'scopeRef': scope, 'evidence': ref,
                        'grantRefs': op['grantRefs'], 'offset': len(data), 'length': 127})
                    chunk = base64.b64decode(part['dataBase64'], validate=True)
                    if (part['resourceHandle'] != ref['resourceHandle'] or part['revision'] != ref['revision'] or
                        part['digest'] != ref['digest'] or part['offset'] != len(data) or not chunk or
                        len(chunk) > 127 or part['eof'] != (len(data) + len(chunk) == ref['bytes'])):
                        raise DomainError('INTEGRITY_MISMATCH', 'invalid Host result chunk')
                    data += chunk
                if len(data) != ref['bytes'] or sha_bytes(data) != ref['digest']:
                    raise DomainError('INTEGRITY_MISMATCH', 'Host result bytes differ')
                record['resultReadback'] = {'evidence': ref, 'dataBase64': base64.b64encode(data).decode('ascii')}
            status = {'completed': 'succeeded', 'stopped': 'cancelled', 'failed': 'failed', 'unknown': 'unknown'}[final['state']]
            with self.state_lock:
                self.state['executions'][op_id] = record
            self.finish(op_id, status, final.get('reason', '') or final['state'])
        except DomainError as exc:
            record['state'] = 'failed'
            record['reason'] = str(exc)
            with self.state_lock:
                self.state['executions'][op_id] = record
            self.finish(op_id, 'failed', str(exc), exc.code)


def main():
    if sys.argv[1:2] == ['hold-lock']:
        return hold_lock(sys.argv[2])
    rt = Runtime(sys.argv[1], sys.argv[2])
    reader = LineReader(LIMITS)
    stdin = sys.stdin.buffer
    while True:
        chunk = stdin.read1(65536) if hasattr(stdin, 'read1') else stdin.read(65536)
        if not chunk:
            break
        for raw, err in reader.feed(chunk):
            if err is None:
                try:
                    message = parse_frame(raw, LIMITS)
                except FrameError as exc:
                    err = exc
            if err is not None:
                mid = None
                if raw is not None:
                    try:
                        mid = json.loads(raw.decode('utf-8', 'replace')).get('id') if raw.strip().startswith(b'{') else None
                        mid = mid if isinstance(mid, str) else None
                    except Exception:  # noqa: BLE001
                        mid = None
                rt.emit({'jsonrpc': '2.0', 'id': mid, 'error': {'code': err.rpc_code, 'message': 'frame rejected before dispatch: ' + str(err)}})
                if err.close:
                    rt.note('closing the connection after an oversized frame; scopes stay stale and pending operations are kept')
                    os._exit(2)
                continue
            if 'method' in message:
                with rt.state_lock:
                    busy = rt.fault().get('busy') == message['method']
                    if rt.in_flight >= rt.limits['inFlight'] or busy:
                        # RC-07: a request that was not accepted answers BUSY with retry-later; the sender retries the same key and digest.
                        rt.error(message.get('id'), 'BUSY', 'in-flight request limit %d reached; not accepted' % rt.limits['inFlight'], recovery='retry-later')
                        continue
                    rt.in_flight += 1
                    rt.max_in_flight = max(rt.max_in_flight, rt.in_flight)
                    if rt.max_in_flight >= 2:
                        (rt.dir / 'max-in-flight.txt').write_text(str(rt.max_in_flight))
                threading.Thread(target=rt.handle, args=(message,), daemon=True).start()
            else:
                q = rt.pending.get(message.get('id'))
                if q:
                    q.put(message)


if __name__ == '__main__':
    main()
