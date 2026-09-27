"""Read-only fixture views and Host context capture. No external repository or model calls."""
import base64
import copy
import time
import journey_fake as j

g = j.g
class Reader(j.Journey):
    def artifacts(self, state):
        current = state['candidateRevision']
        data = {
            'artifact:document': ('rev:%d' % current, 'text/markdown', ('# 当前候选 %d\n\n' % current + '\n'.join('第 %d 行：固定证据内容。' % i for i in range(180))).encode()),
            'artifact:before': ('rev:1', 'text/plain', '旧版本内容\n旧规则\n'.encode()),
            'artifact:html': ('rev:%d' % current, 'text/html', ('<h1>原型版本 %d</h1><script>window.readerInjected = true</script><img src="https://reader-fixture.invalid/leak"><a href="file:///private/secret">外部路径</a>' % current).encode()),
        }
        return {key: ({'authority': 'runtime', 'resourceHandle': self.scopes[self.scope_ref()]['resourceHandle'] if self.scopes else 'resource:none', 'scopeRef': self.scope_ref(), 'objectRef': key, 'revision': rev, 'mediaType': media, 'bytes': len(body), 'digest': g.sha_bytes(body)}, body) for key, (rev, media, body) in data.items()}

    def projection(self, state):
        objects, actions, pending = super().projection(state)
        artifacts = self.artifacts(state)
        def doc(key, title, view):
            return {'scopeRef': self.scope_ref(), 'objectRef': key, 'revision': 'doc:%d' % state['candidateRevision'], 'title': title, 'stateLabel': '只读候选', 'capability': g.CAPABILITY, 'view': view, 'evidence': []}
        objects += [doc('document:1', '设计文档', {'kind': 'document', 'content': artifacts['artifact:document'][0]}), doc('diff:1', '本次修改', {'kind': 'diff', 'before': artifacts['artifact:before'][0], 'after': artifacts['artifact:document'][0]}), doc('prototype:1', '原型源码', {'kind': 'document', 'content': artifacts['artifact:html'][0]})]
        for obj in objects:
            if obj['objectRef'] == 'trace:1':
                obj['view']['entries'] = [{'id': 'reader:run1', 'occurredAt': state['pendingSince'], 'text': '第一轮：保留的验证记录', 'section': 'run:1'}, {'id': 'reader:run2', 'occurredAt': state['pendingSince'], 'text': '第二轮：当前验证记录', 'section': 'run:2'}] + obj['view']['entries']
        for index, receipt in enumerate(state['captures'].values()):
            if receipt['status'] == 'succeeded':
                for k, pair in enumerate(receipt['snapshots']):
                    ref = pair['snapshot']
                    obj = doc('host-document:%d:%d' % (index, k), 'Host 固定快照', {'kind': 'document', 'content': ref})
                    obj['revision'], obj['stateLabel'] = ref['revision'], '只读历史'
                    objects.append(obj)
        actions.append(self.action(state, 'test.capture', 'candidate:1', '生成合成 Host 快照'))
        return objects, actions, pending

    def m_resource_read(self, p):
        ref = p['evidence']
        if not ref['objectRef'].startswith('artifact:'): return super().m_resource_read(p)
        self.require_ready()
        self.check_grants(p['scopeRef'], p['grantRefs'], 'graph.read')
        fault = self.fault()
        if fault.get('slowRead'): time.sleep(float(fault['slowRead']))
        found = self.artifacts(self.state).get(ref['objectRef'])
        if not found or fault.get('missingArtifact'): raise g.DomainError('NOT_FOUND', '固定产物不可用', absence_proven=True)
        expected, data = found
        if ref != expected: raise g.DomainError('INTEGRITY_MISMATCH', '固定证据身份不匹配')
        chunk = data[p['offset']:p['offset'] + p['length']]
        if fault.get('wrongDigest') and chunk: chunk = b'X' + chunk[1:]
        return {'resourceHandle': ref['resourceHandle'], 'revision': ref['revision'], 'offset': p['offset'] + (1 if fault.get('wrongOffset') else 0), 'dataBase64': base64.b64encode(chunk).decode(), 'eof': p['offset'] + len(chunk) >= len(data), 'digest': ref['digest']}

    def invoke_locked(self, p, digest):
        if p['actionId'] != 'test.capture': return super().invoke_locked(p, digest)
        old = self.dedupe(p['scopeRef'], 'runtime.action.invoke', p['idempotencyKey'], p['operationId'], digest)
        if old: return self.operation_view(old)
        offered = self.action(self.state, 'test.capture', 'candidate:1', '生成合成 Host 快照')
        if p['expectedRevision'] != offered['expectedRevision'] or p['candidateRef'] != offered['candidateRef'] or p['payload'] != {'decision': '继续'}: raise g.DomainError('PRECONDITION_CONFLICT', '捕获输入已变化')
        def mutate(state):
            op = {'operationId': p['operationId'], 'scopeRef': p['scopeRef'], 'requestDigest': digest, 'status': 'accepted', 'revision': 1, 'reason': '捕获已排队', 'resultCode': None, 'executionRef': None, 'actionId': 'context.capture', 'grantRefs': p['grantRefs']}
            state['operations'][op['operationId']] = op
            state['idempotency']['|'.join([p['scopeRef'], 'runtime.action.invoke', p['idempotencyKey']])] = {'digest': digest, 'operationId': op['operationId']}
            return op
        op = self.transaction(mutate)
        self.worker.put(op['operationId'])
        return self.operation_view(op)

    def run_capture(self, op_id):
        op = self.state['operations'][op_id]
        cid = 'op:capture:' + op_id.replace(':', '-')
        params = {'operationId': cid, 'idempotencyKey': 'intent:' + cid, 'scopeRef': op['scopeRef'], 'domainOperationId': op_id, 'sources': [self.evidence_ref(self.state)], 'grantRefs': op['grantRefs']}
        params['requestDigest'] = self.digest_of('host.context.capture', params)
        try:
            receipt = self.host('host.context.capture', params)
            def mutate(state):
                state['captures'][op_id] = copy.deepcopy(receipt)
                target = state['operations'][op_id]
                target.update(status='succeeded' if receipt['status'] == 'succeeded' else 'failed', reason='固定快照已生成')
                target['revision'] += 1
                return target
            self.transaction(mutate)
        except g.DomainError as exc: self.finish(op_id, 'failed', str(exc), exc.code)

g.Runtime = Reader
if __name__ == '__main__': g.main()
