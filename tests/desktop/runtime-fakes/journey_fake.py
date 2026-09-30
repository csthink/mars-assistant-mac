"""Test-only Coding journey using the already exercised graph transport. No Git or model calls."""
import base64
import copy
import json
import re
import sys
from pathlib import Path
import graph_fake as g

g.CAPABILITY_ID = 'csthink.test.journey'
g.CAPABILITY_SCHEMA = json.loads((Path(__file__).parent / 'capabilities' / (g.CAPABILITY_ID + '.json')).read_bytes())
g.CAPABILITY = {'id': g.CAPABILITY_ID, 'version': g.PROTOCOL_VERSION, 'schemaDigest': g.sha_json(g.CAPABILITY_SCHEMA), 'required': True}
STATES = ['待接纳', '待定义冻结', '待实施', '待验证', '待变更评审', '待修复', '待发布授权', '待发布', '待核对合并结果', '待关闭', '已关闭']
ACTIONS = [('task.accept', '接纳任务', 0, True), ('definition.freeze', '冻结定义', 1, True), ('task.implement', '开始实施', 2, False), ('task.validate', '执行验证', 3, False), ('change.review', '提交变更评审', 4, False), ('task.repair', '修复评审问题', 5, False), ('publish.authorize', '授权发布', 6, True), ('task.publish', 'Publish', 7, False), ('merge.inspect', '核对合并结果', 8, False), ('task.close', '关闭任务', 9, True), ('budget.raise', '调整评审额度', 4, True)]

HEX40 = re.compile(r'^[0-9a-f]{40}$')
# OD-425: 补充说明 takes the capability document's root definitions entry; fault.json annotate
# shows it ("entry") or announces a digest the document does not hold ("unknown").
ANNOTATE_SCHEMA = g.CAPABILITY_SCHEMA['definitions']['task.annotate']


def spaced(latin, chinese):
    """Result text as a person writes it: a space between a Latin label (Publish) and Chinese (KB-309)."""
    return latin + (' ' if latin[-1:].isascii() and latin[-1:].isalnum() else '') + chinese


def valid_annotation(p):
    def text(v, high): return isinstance(v, str) and 1 <= len(v) <= high
    if set(p) - {'note', 'tags'} or 'note' not in p or not text(p['note'], 200): return False
    tags = p.get('tags', [])
    return isinstance(tags, list) and len(tags) <= 4 and all(text(t, 32) for t in tags)


def valid_definition(d):
    """The definition candidate as the capability schema states it; the domain checks its own input."""
    def text(v, low, high): return isinstance(v, str) and low <= len(v) <= high
    def nullable(v): return v is None or text(v, 0, 256)
    if not isinstance(d, dict) or set(d) - {'commit', 'author', 'notes'} or not {'commit', 'author'} <= set(d): return False
    a, notes = d['author'], d.get('notes', {})
    if not isinstance(d['commit'], str) or not HEX40.match(d['commit']): return False
    if not isinstance(a, dict) or set(a) != {'tool', 'model', 'humanOnly', 'evidenceRefs'}: return False
    if not nullable(a['tool']) or not nullable(a['model']) or type(a['humanOnly']) is not bool: return False
    refs = a['evidenceRefs']
    if not isinstance(refs, list) or not 1 <= len(refs) <= 4: return False
    for r in refs:
        if not isinstance(r, dict) or set(r) != {'commit', 'path'} or not isinstance(r['commit'], str) or not HEX40.match(r['commit']) or not text(r['path'], 1, 1024): return False
    return isinstance(notes, dict) and len(notes) <= 4 and all(text(v, 1, 200) for v in notes.values())


class Journey(g.Runtime):
    def __init__(self, *args):
        super().__init__(*args)
        self.state.setdefault('phase', 0)
        self.state.setdefault('reviews', 0)
        self.state.setdefault('reviewLimit', 1)
        self.state.setdefault('journeyHistory', [])
        self.state.setdefault('processed', {})
        self.state.setdefault('processedRows', [])
        self.state.setdefault('evidenceHistory', {})
        self.state.setdefault('phaseSince', self.state['pendingSince'])
        self.state['text'] = '<script>window.journeyInjected = true</script>\n这是本地合成任务依据，不触及真实仓库。'

    # The product's own access entry (仓库治理接入, OD-416) grants the Contract methods a scope request uses rather than
    # the test operation graph.read the fixtures grant through the Host API; the journey takes either set, so the
    # V-14 acceptance client can reach it through the product's four access steps.
    CONTRACT_OPERATIONS = {'runtime.snapshot.open', 'runtime.resource.read', 'runtime.action.invoke'}

    def m_scope_authorize(self, p):
        result = super().m_scope_authorize(p)
        s = self.scope(p['scopeRef'], need_active=False)
        if not s['active'] and self.CONTRACT_OPERATIONS <= set(s['operations']):
            s['active'] = True
            result['state'] = 'active'
        return result

    def check_grants(self, scope_ref, refs, operation):
        try:
            return super().check_grants(scope_ref, refs, operation)
        except g.DomainError as exc:
            if operation != 'graph.read' or not str(exc).startswith('no active grant carries'):
                raise
            for contract in sorted(self.CONTRACT_OPERATIONS):
                try:
                    return super().check_grants(scope_ref, refs, contract)
                except g.DomainError:
                    continue
            raise

    def projection(self, state):
        scope, phase = self.scope_ref(), state['phase']
        rev = 'rev:%d' % state['revision']
        evidence = self.evidence_ref(state)
        project = {'scopeRef': scope, 'objectRef': 'project:1', 'revision': rev, 'title': '当前阶段：任务开发', 'stateLabel': '当前阶段', 'capability': g.CAPABILITY, 'view': {'kind': 'list', 'rows': [{'id': 'candidate:1', 'title': '合成编码任务', 'detail': STATES[phase]}]}, 'evidence': []}
        task = {'scopeRef': scope, 'objectRef': 'candidate:1', 'revision': rev, 'title': '合成编码任务', 'stateLabel': STATES[phase], 'capability': g.CAPABILITY, 'view': {'kind': 'graph', 'nodes': [{'id': 'stage:%d' % i, 'label': label, 'stateLabel': 'done' if i < phase else 'current' if i == phase else 'pending', 'kind': 'node'} for i, label in enumerate(STATES)], 'edges': [{'id': 'edge:%d' % i, 'source': 'stage:%d' % i, 'target': 'stage:%d' % (i+1), 'label': '继续', 'semantics': 'advance'} for i in range(10)]}, 'evidence': [evidence]}
        quota = {'scopeRef': scope, 'objectRef': 'quota:1', 'revision': rev, 'title': '评审额度', 'stateLabel': '%d/%d' % (state['reviews'], state['reviewLimit']), 'capability': g.CAPABILITY, 'view': {'kind': 'list', 'rows': [{'id': 'quota', 'title': '已使用/额度', 'detail': '%d/%d' % (state['reviews'], state['reviewLimit'])}]}, 'evidence': []}
        trace = {'scopeRef': scope, 'objectRef': 'trace:1', 'revision': rev, 'title': '任务运行记录', 'stateLabel': STATES[phase], 'capability': g.CAPABILITY, 'view': {'kind': 'trace', 'entries': [{'id': 'log:%d' % i, 'occurredAt': row['at'], 'text': row['label'], 'section': 'attempt:1'} for i, row in enumerate(state['journeyHistory'])]}, 'evidence': []}
        actions, pending = [], copy.deepcopy(state['processedRows'])
        for aid, label, expected, human in ACTIONS:
            exhausted = aid == 'change.review' and state['reviews'] >= state['reviewLimit']
            enabled = phase == expected and not exhausted
            if aid == 'budget.raise': enabled = phase == 4 and state['reviews'] >= state['reviewLimit']
            actions.append(self.action(state, aid, 'candidate:1', label, human=human, candidate=self.candidate_ref(state), enabled=enabled, code=None if enabled else 'CAPACITY_EXHAUSTED' if exhausted else 'PRECONDITION_CONFLICT', reason='' if enabled else '评审额度已用完' if exhausted else '当前阶段不能执行该操作'))
            if human and enabled:
                attempt = sum(1 for row in state['processedRows'] if row['typeId'] == aid)
                pending.append({'scopeRef': scope, 'itemRef': 'pending:' + aid + ':' + str(attempt), 'revision': rev, 'objectRef': 'candidate:1', 'capability': g.CAPABILITY, 'title': label, 'typeId': aid, 'typeLabel': label, 'status': 'pending', 'pendingSince': state['phaseSince'], 'updatedAt': state['phaseSince'], 'processedAt': None, 'blocking': True, 'actionIds': [aid], 'evidence': [evidence]})
        # Injection is a distinct test-only action; it never appears in a production bundle.
        actions.append(self.action(state, 'test.revise', 'candidate:1', '更新合成候选'))
        annotate = self.fault().get('annotate')
        if annotate:
            action = self.action(state, 'task.annotate', 'candidate:1', '补充说明')
            action['payloadSchemaDigest'] = g.sha_json(ANNOTATE_SCHEMA if annotate == 'entry' else {'type': 'object', 'title': '不在能力文档中的结构'})
            actions.append(action)
        return [project, task, quota, trace], actions, pending

    def m_resource_read(self, p):
        if self.fault().get('missingEvidence'): raise g.DomainError('NOT_FOUND', '固定依据原件不可用', absence_proven=True)
        historical = self.state['evidenceHistory'].get(p['evidence']['digest'])
        if not historical: return super().m_resource_read(p)
        self.require_ready()
        self.check_grants(p['scopeRef'], p['grantRefs'], 'graph.read')
        ref = p['evidence']
        if ref != historical['ref'] or ref['scopeRef'] != p['scopeRef']: raise g.DomainError('PERMISSION_DENIED', 'historical evidence does not belong to this scope')
        data = historical['text'].encode('utf-8')
        if len(data) != ref['bytes'] or g.sha_bytes(data) != ref['digest']: raise g.DomainError('INTEGRITY_MISMATCH', 'historical bytes changed')
        chunk = data[p['offset']:p['offset'] + p['length']]
        return {'resourceHandle': ref['resourceHandle'], 'revision': ref['revision'], 'offset': p['offset'], 'dataBase64': base64.b64encode(chunk).decode(), 'eof': p['offset'] + len(chunk) >= len(data), 'digest': ref['digest']}

    def invoke_locked(self, p, digest):
        old = self.dedupe(p['scopeRef'], 'runtime.action.invoke', p['idempotencyKey'], p['operationId'], digest)
        if old: return self.operation_view(old)
        _, actions, _ = self.projection(self.state)
        action = next((a for a in actions if a['actionId'] == p['actionId'] and a['objectRef'] == p['objectRef']), None)
        if not action or not action['enabled'] or any(action[k] != p[k] for k in ['expectedRevision', 'candidateRef']): raise g.DomainError('PRECONDITION_CONFLICT', '候选或额度不再适用', 'resync')
        payload = p['payload']
        if p['actionId'] == 'task.annotate':
            if not valid_annotation(payload): raise g.DomainError('PRECONDITION_CONFLICT', '说明无效')
        elif set(payload) - {'decision', 'limit', 'definition'} or payload.get('decision') not in ['继续', '拒绝'] or ('limit' in payload and (type(payload['limit']) is not int or not 1 <= payload['limit'] <= 5)): raise g.DomainError('PRECONDITION_CONFLICT', '输入无效')
        if 'definition' in payload and not valid_definition(payload['definition']): raise g.DomainError('PRECONDITION_CONFLICT', '定义候选无效')
        if action['requiresHumanDecision']:
            if not p['decisionRef']: raise g.DomainError('PERMISSION_DENIED', '需要可信决定', 'review')
            dec = self.host('host.decision.get', {'scopeRef': p['scopeRef'], 'decisionRef': p['decisionRef']})
            if dec['status'] != 'valid' or dec['domainOperationId'] != p['operationId'] or any(dec[k] != p[k] for k in ['actionId', 'objectRef', 'candidateRef', 'expectedRevision', 'requestDigest']) or self.evidence_ref(self.state) not in dec['evidence']: raise g.DomainError('PERMISSION_DENIED', '决定不匹配当前依据', 'review')
        def mutate(state):
            aid = p['actionId']
            phase_before = state['phase']
            pending_before = next((i for i in self.projection(state)[2] if i['status'] == 'pending' and aid in i['actionIds']), None)
            op = {'operationId': p['operationId'], 'scopeRef': p['scopeRef'], 'requestDigest': digest, 'status': 'succeeded', 'reason': spaced(action['label'], '已生效'), 'revision': 1, 'resultCode': None, 'executionRef': None, 'actionId': aid}
            state['operations'][op['operationId']] = op
            state['idempotency']['|'.join([p['scopeRef'], 'runtime.action.invoke', p['idempotencyKey']])] = {'digest': digest, 'operationId': op['operationId']}
            if aid == 'task.annotate':
                state.setdefault('annotations', []).append(copy.deepcopy(payload))
                op['reason'] = '补充说明已记录：%s（标签 %d 个）' % (payload['note'], len(payload.get('tags', [])))
            elif payload['decision'] == '拒绝':
                op.update(status='failed', reason='人工拒绝本候选，任务未推进', resultCode='ACCEPT_ABORTED' if aid == 'task.accept' else 'HUMAN_REJECTED')
            elif aid == 'test.revise': state['candidateRevision'] += 1
            elif aid == 'definition.freeze' and 'definition' in payload:
                d = payload['definition']
                state.setdefault('definitions', []).append(copy.deepcopy(d))
                state['phase'] += 1
                state['processed'][aid] = g.now()
                author = d['author']
                op['reason'] = '冻结定义已生效：定义候选 %s，依据 %d 条，工具 %s，模型 %s，说明 %d 条' % (
                    d['commit'][:7], len(author['evidenceRefs']), '空值' if author['tool'] is None else author['tool'],
                    '空值' if author['model'] is None else author['model'], len(d.get('notes', {})))
            elif aid == 'budget.raise':
                if payload.get('limit', 0) <= state['reviewLimit']: op.update(status='failed', reason='新额度必须增加', resultCode='CAPACITY_EXHAUSTED')
                else: state['reviewLimit'] = payload['limit']
            elif aid == 'task.repair': state['phase'] = 3
            elif aid == 'change.review':
                state['reviews'] += 1
                state['phase'] = 5 if state['reviews'] == 1 else 6
            else:
                state['phase'] += 1
                if action['requiresHumanDecision']: state['processed'][aid] = g.now()
            if op['status'] == 'succeeded' and aid in ['publish.authorize', 'task.publish', 'merge.inspect', 'task.close']:
                op['resultCode'] = {'publish.authorize': 'PUBLISH_AUTHORIZED', 'task.publish': 'PUBLISHED', 'merge.inspect': 'MERGE_CONFIRMED', 'task.close': 'CLOSED'}[aid]
            at = g.now()
            if pending_before:
                historical = copy.deepcopy(pending_before)
                historical.update(status='processed', revision='processed:' + str(len(state['processedRows'])), processedAt=at, updatedAt=at, blocking=False, actionIds=[])
                state['processedRows'].append(historical)
                for ref in historical['evidence']:
                    state['evidenceHistory'][ref['digest']] = {'ref': ref, 'text': self.candidate_bytes(state).decode('utf-8')}
            if phase_before != state['phase'] or pending_before: state['phaseSince'] = at
            state['journeyHistory'].append({'at': at, 'label': op['reason']})
            return op
        return self.operation_view(self.transaction(mutate, crash_after_write=self.fault().get('crashAfterWrite') == p['actionId']))

g.Runtime = Journey
if __name__ == '__main__': g.main()
