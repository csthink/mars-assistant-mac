"""Design-only schema source. Generate with Python 3; --check never writes files."""
import json
import sys
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = '0.1.0-draft.5'
SCHEMA_ID = 'urn:csthink:runtime-contract:' + VERSION


def ref(name):
    return {'$ref': '#/definitions/' + name}


def obj(properties, optional=()):
    return {'type': 'object', 'properties': properties,
            'required': [key for key in properties if key not in optional],
            'additionalProperties': False}


def array(items, limit=100):
    return {'type': 'array', 'items': items, 'maxItems': limit}


def nullable(value):
    return {'anyOf': [value, {'type': 'null'}]}


def enum(*values):
    return {'enum': list(values)}


def text(limit=65536):
    return {'type': 'string', 'maxLength': limit}


ID = {'type': 'string', 'minLength': 1, 'maxLength': 256, 'pattern': '^[A-Za-z0-9][A-Za-z0-9:._/-]*$'}
# r3 (C-02): a model identifier read back from a tool's own protocol output is opaque text, not an ID (KB-188 observed
# `claude-opus-5[1m]`); it never names a resource and is only compared by the domain's vendor mapping.
MODEL_TEXT = {'type': 'string', 'minLength': 1, 'maxLength': 256}
# r3 (C-01): a relative path under a registered resource handle; no leading slash, no `.`/`..` segments.
RELATIVE_PATH = {'type': 'string', 'minLength': 1, 'maxLength': 1024,
                 'pattern': '^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9_./-]+$'}
DIGEST = {'type': 'string', 'pattern': '^[0-9a-f]{64}$'}
SEQ = {'type': 'string', 'pattern': '^(0|[1-9][0-9]*)$', 'maxLength': 32}
BOOL = {'type': 'boolean'}
NAT = {'type': 'integer', 'minimum': 0, 'maximum': 9007199254740991}
STAMP = {'type': 'string', 'format': 'date-time'}
D = {}
D['Context'] = obj({'protocolVersion': enum(VERSION), 'contractDigest': DIGEST, 'controlGeneration': SEQ,
                    **{k: ID for k in ('installationId', 'instanceId', 'incarnationId', 'connectionId')}})
D['Protocol'] = obj({'version': ID, 'contractDigest': DIGEST})
D['Capability'] = obj({'id': ID, 'version': ID, 'schemaDigest': DIGEST, 'required': BOOL})
D['GrantRef'] = obj({'id': ID, 'revision': SEQ})
D['ExecutionProfileRef'] = obj({'id': ID, 'version': ID, 'digest': DIGEST})
# r4 (K-01): a profile names its trust model (closed set; the first delivery only has `current-user`), its purpose, the fixed
# program it launches, the native approval policy the adapter applies, the digest of its non-secret configuration and the
# verified capabilities / known limitations of that combination. A restricted purpose is a separate profile identity.
D['ProgramIdentity'] = obj({'launcher': text(1024), 'binaryDigest': DIGEST, 'version': text(256)})
D['ExecutionProfile'] = obj({**D['ExecutionProfileRef']['properties'],
    'trustModel': enum('current-user'),
    'purpose': enum('chat', 'widget-generation', 'coding-implementer', 'review'),
    'programIdentity': ref('ProgramIdentity'),
    'nativeApprovalPolicy': enum('auto-deny', 'expected-range-gate', 'trusted-ui-prompt'),
    'configurationDigest': DIGEST,
    'capabilities': array(ID, 32), 'limitations': array(ID, 32),
    'operations': array(ID, 32), 'maxContextBytes': NAT,
    'maxToolCalls': {'type': 'integer', 'minimum': 1, 'maximum': 20},
    'maxRunSeconds': {'type': 'integer', 'minimum': 1, 'maximum': 600}})
# r4 (K-06): a capability that performs reviews declares where its reviewer profile applies; a Host capability PASS never
# grants review eligibility, the domain (hp) decides that from these fields plus its own checks.
D['ReviewerApplicability'] = obj({'executionPort': enum('embedded', 'standalone', 'any'),
    'purpose': enum('review'), 'trustModel': enum('current-user'), 'profileDigest': DIGEST,
    'configurationRevision': SEQ, 'credentialRevision': SEQ})
D['ProfileRequirement'] = obj({'capabilityId': ID, 'profile': ref('ExecutionProfileRef'),
    'applicability': ref('ReviewerApplicability')}, optional=('applicability',))
# r4 (K-07): `permissionProfileDigest` is the digest of the trusted local execution configuration checked at admission
# (entrypoint, argv template, environment allow-list, dependency list); it is not a process isolation configuration.
D['LaunchAuthorization'] = obj({'authorizationRef': ID, 'bundleDigest': DIGEST,
    'permissionProfileDigest': DIGEST, 'expiresAt': STAMP})
D['ScopeBinding'] = obj({'bindingRef': ID, 'resourceHandle': ID, 'expiresAt': STAMP})
D['Limits'] = obj({k: {'type': 'integer', 'minimum': 1, 'maximum': maximum} for k, maximum in {
    'frameBytes': 1048576, 'depth': 32, 'members': 1000, 'inFlight': 32,
    'bufferBytes': 4194304, 'eventWindow': 128, 'pageObjects': 100,
    'textCharacters': 65536}.items()})
# r5 (RC-02, KB-198): argv entries are a template. The Host expands only the closed placeholder set below (runtime
# root, instance run directory, contract digest, registered resource handle); every other byte is fixed and bound by
# permissionProfileDigest. Expanded values are written to the Host launch record, never into the digest.
ARGV_TEMPLATE = {'type': 'string', 'maxLength': 1024,
                 'pattern': '^(?:[^$]|\\$(?!\\{)|\\$\\{(?:runtimeRoot|instanceDir|contractDigest|resourceHandle)\\})*$'}
D['Manifest'] = obj({'manifestVersion': enum(VERSION), 'runtimeId': ID,
    'publisher': ID, 'version': ID,
    'entrypoint': {'type': 'string', 'minLength': 1, 'maxLength': 256,
                   'pattern': '^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9_./-]+$'},
    'argv': array(ARGV_TEMPLATE, 32), 'platform': enum('darwin-arm64'),
    'minimumOs': enum('26.6.2'), 'protocols': array(ref('Protocol'), 8),
    'capabilities': array(ref('Capability'), 32), 'permissionProfileDigest': DIGEST,
    'executionProfileRequirements': array(ref('ProfileRequirement'), 32),
    'dataFormat': ID, 'dependencies': array(obj({'id': ID, 'version': ID, 'digest': DIGEST}), 32)})
D['Initialize'] = obj({**{k: ID for k in ('installationId', 'instanceId', 'incarnationId', 'connectionId')},
    'bundleDigest': DIGEST, 'protocols': array(ref('Protocol'), 8),
    'capabilities': array(ref('Capability'), 32), 'launchAuthorization': ref('LaunchAuthorization'),
    'executionProfiles': array(ref('ExecutionProfile'), 32),
    'limits': ref('Limits')})
D['Initialized'] = obj({'context': ref('Context'), 'selectedProtocol': ref('Protocol'),
    'capabilities': array(ref('Capability'), 32), 'limits': ref('Limits'),
    'executionProfiles': array(ref('ExecutionProfileRef'), 32),
    'recovery': enum('snapshot-and-operation-query')})
D['Grant'] = obj({'ref': ref('GrantRef'), **{k: ID for k in ('installationId', 'instanceId', 'scopeRef', 'resourceHandle', 'capability', 'operation')}, 'executionRef': nullable(ID),
    'bundleDigest': DIGEST, 'expiresAt': STAMP,
    'status': enum('active', 'revoked', 'expired'), 'purpose': text(2048)})
D['EvidenceRef'] = obj({'authority': enum('host', 'runtime'), 'resourceHandle': ID, 'scopeRef': ID, 'objectRef': ID,
    'revision': ID, 'mediaType': enum('text/plain', 'text/markdown', 'text/html', 'application/json', 'application/octet-stream'),
    'bytes': NAT, 'digest': DIGEST})
for authority in ('host', 'runtime'):
    D[authority.title() + 'EvidenceRef'] = deepcopy(D['EvidenceRef'])
    D[authority.title() + 'EvidenceRef']['properties']['authority'] = enum(authority)
D['View'] = {'oneOf': [
    obj({'kind': enum('list'), 'rows': array(obj({'id': ID, 'title': text(), 'detail': text()}))}),
    obj({'kind': enum('document'), 'content': ref('EvidenceRef')}),
    # r3 (C-06): optional machine-readable node kind, edge semantics and trace section so capabilities do not encode them in labels.
    obj({'kind': enum('graph'), 'nodes': array(obj({'id': ID, 'label': text(), 'stateLabel': text(256), 'kind': ID}, optional=('kind',)), 1000),
         'edges': array(obj({'id': ID, 'source': ID, 'target': ID, 'label': text(256), 'semantics': ID}, optional=('semantics',)), 1000)}),
    obj({'kind': enum('diff'), 'before': ref('EvidenceRef'), 'after': ref('EvidenceRef')}),
    obj({'kind': enum('trace'), 'entries': array(obj({'id': ID, 'occurredAt': STAMP, 'text': text(), 'section': ID}, optional=('section',)))})]}
D['ProjectionObject'] = obj({'scopeRef': ID, 'objectRef': ID, 'revision': ID,
    'title': text(1024), 'stateLabel': text(256), 'capability': ref('Capability'),
    'view': ref('View'), 'evidence': array(ref('EvidenceRef'), 32)})
D['Action'] = obj({'scopeRef': ID, 'actionId': ID, 'objectRef': ID,
    'capability': ref('Capability'), 'label': text(256), 'expectedRevision': ID,
    'candidateRef': nullable(ID), 'payloadSchemaDigest': DIGEST, 'enabled': BOOL,
    'disabledReason': text(2048), 'disabledCode': nullable(ID), 'requiresHumanDecision': BOOL})
# r3 (C-04): a disabled action carries a machine-readable code registered by the capability next to the human text.
D['Action']['allOf'] = [
    {'if': {'properties': {'enabled': {'const': False}}},
     'then': {'properties': {'disabledReason': {'minLength': 1}, 'disabledCode': ID}}},
    {'if': {'properties': {'enabled': {'const': True}}},
     'then': {'properties': {'disabledReason': {'const': ''}, 'disabledCode': {'type': 'null'}}}}]
D['PendingItem'] = obj({'scopeRef': ID, 'itemRef': ID, 'revision': ID,
    'objectRef': ID, 'capability': ref('Capability'), 'title': text(1024),
    'typeId': ID, 'typeLabel': text(256), 'status': enum('pending', 'processed'),
    'pendingSince': STAMP, 'updatedAt': STAMP, 'processedAt': nullable(STAMP),
    'blocking': BOOL, 'actionIds': array(ID, 32), 'evidence': array(ref('EvidenceRef'), 32)})
D['PendingItem']['allOf'] = [{'if': {'properties': {'status': {'const': 'pending'}}},
    'then': {'properties': {'processedAt': {'type': 'null'}}},
    'else': {'properties': {'processedAt': STAMP, 'blocking': {'const': False}}}}]
D['JsonValue'] = {'oneOf': [{'type': 'null'}, BOOL, text(),
    {'type': 'number', 'minimum': -9007199254740991, 'maximum': 9007199254740991},
    array(ref('JsonValue'), 1000), {'type': 'object', 'maxProperties': 1000, 'additionalProperties': ref('JsonValue')}]}
OPKEY = {'operationId': ID, 'idempotencyKey': ID, 'requestDigest': DIGEST}
D['Invoke'] = obj({**OPKEY, 'scopeRef': ID, 'actionId': ID, 'objectRef': ID,
    'expectedRevision': ID, 'candidateRef': nullable(ID), 'grantRefs': array(ref('GrantRef')),
    'payload': {'type': 'object', 'maxProperties': 1000, 'additionalProperties': ref('JsonValue')},
    'decisionRef': nullable(ID)})
D['Operation'] = obj({'operationId': ID, 'scopeRef': ID, 'requestDigest': DIGEST,
    'status': enum('accepted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'),
    'resultRef': nullable(ref('EvidenceRef')), 'executionRef': nullable(ID),
    'reason': text(2048), 'resultCode': nullable(ID), 'revision': ID})
# r3 (C-04): a terminal operation may carry a machine-readable result code registered by the capability; an operation
# that is still accepted or running has none.
D['Operation']['allOf'] = [{'if': {'properties': {'status': {'enum': ['accepted', 'running']}}},
    'then': {'properties': {'resultCode': {'type': 'null'}}}}]
D['DecisionRecord'] = obj({'decisionRef': ID, 'scopeRef': ID,
    'domainOperationId': ID, 'method': enum('runtime.action.invoke'), 'requestDigest': DIGEST,
    'actionId': ID, 'objectRef': ID, 'candidateRef': nullable(ID), 'expectedRevision': ID,
    'evidence': array(ref('EvidenceRef'), 32), 'actorRef': ID,
    'source': enum('host-trusted-ui'), 'recordedAt': STAMP,
    'status': enum('valid', 'revoked')})
D['ContextCapture'] = obj({**OPKEY, 'scopeRef': ID, 'domainOperationId': ID,
    'sources': array(ref('RuntimeEvidenceRef'), 32), 'grantRefs': array(ref('GrantRef'))})
D['ContextCaptureReceipt'] = obj({'operationId': ID, 'scopeRef': ID, 'domainOperationId': ID,
    'requestDigest': DIGEST, 'status': enum('accepted', 'running', 'succeeded', 'failed', 'unknown'),
    'snapshots': array(obj({'source': ref('RuntimeEvidenceRef'), 'snapshot': ref('HostEvidenceRef')}), 32),
    'reason': text(2048)})
D['ContextCaptureReceipt']['allOf'] = [{'if': {'properties': {'status': {'enum': ['accepted', 'running', 'failed', 'unknown']}}},
    'then': {'properties': {'snapshots': {'maxItems': 0}}}}]
D['ProtectedReference'] = obj({'scopeRef': ID, 'objectRef': ID,
    'revision': ID, 'reason': text(2048)})
D['UpgradeTarget'] = obj({'sourceBundleDigest': DIGEST, 'targetBundleDigest': DIGEST,
    'sourceDataFormat': ID, 'targetDataFormat': ID})
D['UpgradePrepare'] = obj({**OPKEY, **D['UpgradeTarget']['properties']})
# r5 (RC-01, KB-197): `releasedDomainRevision` is the domain revision persisted together with a successful release; the
# Host compares it with the current revision read in recovery mode before any restore, so any write after the release
# (including one made by the standalone CLI) forbids a rollback. Absent or null before release; required once released.
D['UpgradeState'] = obj({'operationId': ID, 'requestDigest': DIGEST,
    **D['UpgradeTarget']['properties'], 'status': enum('prepared', 'blocked', 'released', 'unknown'),
    'barrierRef': nullable(ID), 'domainRevision': ID, 'preparedGeneration': SEQ,
    'protectedReferences': array(ref('ProtectedReference')), 'reason': text(2048),
    'releasedDomainRevision': nullable(ID)}, optional=('releasedDomainRevision',))
D['UpgradeState']['allOf'] = [{'if': {'properties': {'status': {'const': 'prepared'}}},
    'then': {'properties': {'barrierRef': ID, 'protectedReferences': {'maxItems': 0}}}},
    {'if': {'properties': {'status': {'const': 'blocked'}}},
     'then': {'properties': {'barrierRef': {'type': 'null'}}}},
    {'if': {'properties': {'status': {'const': 'released'}}},
     'then': {'required': ['releasedDomainRevision'], 'properties': {'releasedDomainRevision': ID}}}]
# r3 (C-02): the model actually bound by the tool, read back from its own protocol output; `model` stays the requested value.
D['ActualBinding'] = obj({'model': MODEL_TEXT,
    'source': enum('protocol-init', 'protocol-result', 'adapter-report'),
    'observedModels': array(MODEL_TEXT, 8)})
# r3 (C-10): what the Host actually observed and enforced after the fact; limits are stop conditions, not prior isolation.
D['ExecutionAccounting'] = obj({'toolCalls': NAT, 'runSeconds': NAT, 'outputBytes': NAT,
    'waited': BOOL, 'pidGoneAfterExit': BOOL})
# r4 (K-03/K-05): process identity is pid + start time + executable image; a pid alone never identifies a process.
D['ProcessIdentity'] = obj({'pid': NAT, 'startTime': STAMP, 'image': text(1024)})
D['ProcessExit'] = obj({'code': nullable({'type': 'integer', 'minimum': 0, 'maximum': 255}),
    'signal': nullable(text(32)), 'pipesClosed': BOOL})
D['RequestIdentity'] = obj({'operationId': ID, 'requestDigest': DIGEST, 'profileDigest': DIGEST})
# r4 (K-03/K-04): `reserved` is the persisted reservation with an exclusive physical record whose target has not been
# released; the request identity, supervisor identity, approval decisions, exit facts and observation completeness are
# separate facts from "ran", "exited" and "accepted by the domain".
D['PhysicalExecution'] = obj({'executionRef': ID, 'scopeRef': ID,
    'state': enum('queued', 'reserved', 'running', 'stopping', 'stopped', 'completed', 'failed', 'unknown'),
    'connectionRef': ID, 'configurationRevision': SEQ, 'model': ID,
    'requestIdentity': ref('RequestIdentity'),
    'supervisor': nullable(ref('ProcessIdentity')),
    'approvalDecisionRefs': array(ID, 32),
    'actualBinding': nullable(ref('ActualBinding')),
    'stopReason': nullable(enum('cancelled', 'timeout', 'tool-call-budget', 'output-limit', 'signal')),
    'accounting': nullable(ref('ExecutionAccounting')),
    'exit': nullable(ref('ProcessExit')),
    'observationCompleteness': enum('complete', 'partial', 'unknown'),
    'resultRef': nullable(ref('EvidenceRef')), 'reason': text(2048)})
# r3 (C-07): a stopped execution names why the Host stopped it; a completed one has no stop reason.
# r4 (K-03/K-04): nothing has been observed from a target before release; a completed execution carries exit facts;
# an unknown execution cannot claim complete observation.
D['PhysicalExecution']['allOf'] = [
    {'if': {'properties': {'state': {'const': 'stopped'}}},
     'then': {'properties': {'stopReason': {'type': 'string'}}}},
    {'if': {'properties': {'state': {'enum': ['queued', 'reserved', 'running', 'completed']}}},
     'then': {'properties': {'stopReason': {'type': 'null'}}}},
    {'if': {'properties': {'state': {'enum': ['queued', 'reserved']}}},
     'then': {'properties': {'actualBinding': {'type': 'null'}, 'accounting': {'type': 'null'}, 'exit': {'type': 'null'}}}},
    {'if': {'properties': {'state': {'const': 'completed'}}},
     'then': {'properties': {'exit': {'type': 'object'}}}},
    {'if': {'properties': {'state': {'const': 'unknown'}}},
     'then': {'properties': {'observationCompleteness': {'enum': ['partial', 'unknown']}}}}]
# r4 (K-05): the shared, non-secret physical observation record under the Git common directory
# `harness/executions/<executionRequestId>/`; the supervisor started by the execution port is its only writer from
# exclusive creation to exit, everyone else reads. It never holds task state, human gates, credentials, prompts or output.
D['ExecutionRecord'] = obj({'recordVersion': enum('1'), 'seq': SEQ,
    'executionRequestId': ID, 'executionId': ID,
    'intentDigest': DIGEST, 'profileDigest': DIGEST,
    'executionPort': enum('embedded', 'standalone'),
    'bootId': ID, 'uid': NAT,
    'supervisor': ref('ProcessIdentity'), 'target': nullable(ref('ProcessIdentity')),
    'processGroup': nullable(NAT), 'children': array(ref('ProcessIdentity'), 64),
    'nativeSession': nullable(obj({'sessionRef': ID, 'turnRef': nullable(ID)})),
    'released': BOOL, 'observedAt': STAMP, 'cancelRequestedAt': nullable(STAMP),
    'exit': nullable(ref('ProcessExit')), 'observationErrors': array(text(2048), 32),
    'result': nullable(obj({'digest': DIGEST, 'locator': ID}))})
D['ExecutionRecord']['allOf'] = [
    {'if': {'properties': {'target': {'type': 'null'}}},
     'then': {'properties': {'released': {'const': False}, 'exit': {'type': 'null'}}}}]
D['SnapshotPage'] = obj({'scopeRef': ID, 'snapshotId': ID, 'revision': ID,
    'streamId': ID, 'epoch': ID, 'throughSeq': SEQ, 'expiresAt': STAMP,
    'objects': array(ref('ProjectionObject')), 'actions': array(ref('Action')),
    'pendingItems': array(ref('PendingItem')),
    'nextPageToken': nullable(ID)})
EVENT_BASE = {'subscriptionId': ID, 'eventId': ID, 'scopeRef': ID, 'streamId': ID,
              'epoch': ID, 'seq': SEQ, 'domainRevision': ID, 'causationId': nullable(ID)}
D['Event'] = {'oneOf': [obj({**EVENT_BASE, 'kind': enum(kind), 'payload': payload})
    for kind, payload in {
        'object.upsert': ref('ProjectionObject'), 'object.remove': obj({'objectRef': ID}),
        'action.upsert': ref('Action'), 'action.remove': obj({'actionId': ID}),
        'pending.upsert': ref('PendingItem'), 'pending.remove': obj({'itemRef': ID}),
        'operation.changed': ref('Operation')}.items()] + [
        obj({'kind': enum('stream.caughtUp'), 'subscriptionId': ID, 'scopeRef': ID,
             'streamId': ID, 'epoch': ID, 'throughSeq': SEQ})]}
D['ResourceRead'] = obj({'scopeRef': ID, 'evidence': ref('EvidenceRef'),
    'grantRefs': array(ref('GrantRef')), 'offset': NAT,
    'length': {'type': 'integer', 'minimum': 1, 'maximum': 262144}})
D['ResourceChunk'] = obj({'resourceHandle': ID, 'revision': ID, 'offset': NAT,
    'dataBase64': {'type': 'string', 'maxLength': 349528, 'pattern': '^[A-Za-z0-9+/]*={0,2}$'},
    'eof': BOOL, 'digest': DIGEST})
# r3 (C-01): the domain names the node, the role and the target working tree explicitly (KB-128/KB-184); contextRefs stay data.
D['TargetBinding'] = obj({'resourceHandle': ID, 'relativePath': RELATIVE_PATH})
# r4 (K-02): the request binds the complete profile digest, agent, model, model vendor, route vendor, credential reference
# and configuration revision; the Host rejects when the actual program differs and never corrects the selection from the
# tool's returned text. `profileDigest`, `model` and `configurationRevision` must equal the top-level request fields.
D['ExecutionBinding'] = obj({'profileDigest': DIGEST, 'agent': ID, 'model': ID, 'modelVendor': ID,
    'routeVendor': nullable(ID), 'credentialRef': ID, 'configurationRevision': SEQ})
# r4 (K-02): each constraint names who enforces it and what that enforcement guarantees. The closed set has no
# operating-system enforcement value; a constraint enforced by the agent itself is only declared.
D['ExecutionConstraint'] = obj({'kind': enum('resource', 'tool', 'network', 'path', 'budget'),
    'value': text(1024), 'enforcer': enum('host', 'runtime', 'agent'),
    'guarantee': enum('interface-enforced', 'agent-declared')})
D['ExecutionConstraint']['allOf'] = [{'if': {'properties': {'enforcer': {'const': 'agent'}}},
    'then': {'properties': {'guarantee': {'const': 'agent-declared'}}}}]
D['ExecutionStart'] = obj({**OPKEY, 'scopeRef': ID, 'profileId': ID,
    'profileDigest': DIGEST, 'domainOperationId': ID, 'domainNodeRef': ID, 'roleIntent': ID,
    'resourceHandle': ID, 'targetBinding': nullable(ref('TargetBinding')),
    'connectionRef': ID, 'configurationRevision': SEQ, 'model': ID,
    'executionBinding': ref('ExecutionBinding'), 'constraints': array(ref('ExecutionConstraint'), 32),
    'contextRefs': array(ref('HostEvidenceRef'), 32), 'grantRefs': array(ref('GrantRef')),
    'decisionRef': nullable(ID), 'budget': obj({'maxToolCalls': {'type': 'integer', 'minimum': 1, 'maximum': 20},
    'maxRunSeconds': {'type': 'integer', 'minimum': 1, 'maximum': 600},
    'maxOutputBytes': {'type': 'integer', 'minimum': 1, 'maximum': 16777216},
    'cleanupSeconds': {'type': 'integer', 'minimum': 1, 'maximum': 60}}, optional=('maxOutputBytes', 'cleanupSeconds'))})
ERROR_CODES = ['UNSUPPORTED_VERSION', 'UNSUPPORTED_CAPABILITY', 'PERMISSION_DENIED',
    'PERMISSION_REVOKED', 'PRECONDITION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'WRITER_CONFLICT',
    'RESOURCE_LIMIT', 'BUSY', 'RESYNC_REQUIRED', 'NOT_FOUND', 'RESULT_UNKNOWN',
    'EXECUTION_FAILED', 'CANCELLED', 'INTEGRITY_MISMATCH', 'INVALID_SOURCE']
D['ErrorData'] = obj({'code': enum(*ERROR_CODES), 'scopeRef': nullable(ID),
    # r5 (RC-10): `retry-later` is only for BUSY / RESOURCE_LIMIT on a request that was not accepted; the initiator retries
    # the same key and digest under its backpressure rule and never treats it as approval of a side effect.
    'operationId': nullable(ID), 'recovery': enum('none', 'resync', 'query', 'reauthorize', 'review', 'reconnect', 'retry-later'),
    'absenceProven': BOOL})
D['ErrorData']['allOf'] = [
    {'if': {'properties': {'code': {'const': 'NOT_FOUND'}}},
     'then': {'properties': {'absenceProven': {'const': True}}},
     'else': {'properties': {'absenceProven': {'const': False}}}}]
D['RpcError'] = obj({'code': enum(-32700, -32600, -32601, -32602, -32603, -32000),
                     'message': text(2048), 'data': ref('ErrorData')}, optional=('data',))
D['RpcError']['allOf'] = [{'if': {'properties': {'code': {'const': -32000}}},
                         'then': {'required': ['data']}}]

METHODS = {}


def method(name, direction, params, result, contextual=True):
    stem = ''.join(part.title() for part in name.split('.'))
    def wrap(value):
        if isinstance(value, str):
            value = D[value]
        value = deepcopy(value)
        if contextual:
            value['properties'] = {'context': ref('Context'), **value['properties']}
            value['required'] = ['context', *value['required']]
        return value
    D[stem + 'Params'] = wrap(params)
    D[stem + 'Result'] = result if isinstance(result, dict) and '$ref' in result else wrap(result)
    METHODS[name] = {'direction': direction, 'params': stem + 'Params', 'result': stem + 'Result'}


method('runtime.initialize', 'host-to-runtime', 'Initialize', 'Initialized', False)
method('runtime.ready', 'host-to-runtime', obj({}), obj({'ready': {'const': True}}))
method('runtime.health', 'host-to-runtime', obj({}), obj({'health': enum('ready', 'degraded'), 'reason': text(2048)}))
method('runtime.scope.open', 'host-to-runtime', obj({'binding': ref('ScopeBinding')}),
       obj({'scopeRef': ID, 'bindingRef': ID, 'state': enum('inactive')}))
method('runtime.scope.authorize', 'host-to-runtime', obj({'scopeRef': ID, 'grantRefs': array(ref('GrantRef'))}),
       obj({'scopeRef': ID, 'state': enum('active', 'inactive')}))
method('runtime.snapshot.open', 'host-to-runtime', obj({'scopeRef': ID}), 'SnapshotPage')
method('runtime.snapshot.next', 'host-to-runtime', obj({'scopeRef': ID, 'snapshotId': ID, 'pageToken': ID}), 'SnapshotPage')
# r3 (C-03): one active subscription per connection and scope; a new one replaces and names the old one (KB-185).
method('runtime.events.subscribe', 'host-to-runtime', obj({'scopeRef': ID, 'snapshotId': ID, 'streamId': ID, 'epoch': ID, 'afterSeq': SEQ}), obj({'subscriptionId': ID, 'replacedSubscriptionId': nullable(ID)}))
method('runtime.events.ack', 'host-to-runtime', obj({'subscriptionId': ID, 'streamId': ID, 'epoch': ID, 'seq': SEQ}), obj({'acknowledgedSeq': SEQ}))
method('runtime.action.invoke', 'host-to-runtime', 'Invoke', 'Operation')
method('runtime.operation.get', 'host-to-runtime', obj({'scopeRef': ID, 'operationId': ID}), 'Operation')
method('runtime.operation.cancel', 'host-to-runtime', obj({**OPKEY, 'scopeRef': ID, 'targetOperationId': ID}), 'Operation')
for name in ('runtime.quiesce', 'runtime.shutdown'):
    method(name, 'host-to-runtime', obj({**OPKEY, 'reason': text(2048)}), 'Operation')
method('runtime.upgrade.prepare', 'host-to-runtime', 'UpgradePrepare', 'UpgradeState')
method('runtime.upgrade.get', 'host-to-runtime', obj({'operationId': ID}), 'UpgradeState')
method('runtime.upgrade.release', 'host-to-runtime', obj({**OPKEY, 'prepareOperationId': ID,
    'barrierRef': ID, 'disposition': enum('activated', 'restored'),
    'runningBundleDigest': DIGEST, 'dataFormat': ID}), 'Operation')
method('host.grants.get', 'runtime-to-host', obj({'grantRefs': array(ref('GrantRef'))}), obj({'grants': array(ref('Grant'))}))
method('host.decision.get', 'runtime-to-host', obj({'scopeRef': ID, 'decisionRef': ID}), 'DecisionRecord')
method('host.context.capture', 'runtime-to-host', 'ContextCapture', 'ContextCaptureReceipt')
method('host.context.get', 'runtime-to-host', obj({'scopeRef': ID, 'operationId': ID}), 'ContextCaptureReceipt')
method('host.resource.read', 'runtime-to-host', 'ResourceRead', 'ResourceChunk')
method('runtime.resource.read', 'host-to-runtime', 'ResourceRead', 'ResourceChunk')
# r4 (K-04): preflight is a static and protocol capability check without any model call; it creates no operation, no
# execution and no review eligibility, so it carries no operation identity. `host.execution.start` is the persistent
# reservation: accepted + executionRef means reserved, the target is released only after the Host recorded real identity.
method('host.execution.preflight', 'runtime-to-host',
       obj({'scopeRef': ID, 'profileId': ID, 'profileDigest': DIGEST, 'connectionRef': ID,
            'configurationRevision': SEQ, 'executionBinding': ref('ExecutionBinding'),
            'constraints': array(ref('ExecutionConstraint'), 32)}),
       obj({'status': enum('supported', 'unsupported'), 'profileDigest': DIGEST,
            'checks': array(obj({'id': ID, 'passed': BOOL, 'detail': text(2048)}), 64), 'reason': text(2048)}))
method('host.execution.start', 'runtime-to-host', 'ExecutionStart', 'Operation')
method('host.operation.get', 'runtime-to-host', obj({'scopeRef': ID, 'operationId': ID}), 'Operation')
method('host.execution.get', 'runtime-to-host', obj({'scopeRef': ID, 'executionRef': ID}), 'PhysicalExecution')
method('host.execution.cancel', 'runtime-to-host', obj({**OPKEY, 'scopeRef': ID, 'executionRef': ID}), 'Operation')
D['Request'] = {'oneOf': [obj({'jsonrpc': {'const': '2.0'},
    'id': {'type': 'string', 'pattern': ('^h:' if data['direction'] == 'host-to-runtime' else '^r:'), 'maxLength': 256},
    'method': {'const': name}, 'params': ref(data['params'])}) for name, data in METHODS.items()]}
D['Notification'] = obj({'jsonrpc': {'const': '2.0'}, 'method': {'const': 'runtime.event'},
    'params': obj({'context': ref('Context'), 'event': ref('Event')})})
D['Success'] = obj({'jsonrpc': {'const': '2.0'}, 'id': {'type': 'string', 'pattern': '^[hr]:', 'maxLength': 256},
                    'result': {'type': 'object'}})
D['Failure'] = obj({'jsonrpc': {'const': '2.0'},
    'id': nullable({'type': 'string', 'pattern': '^[hr]:', 'maxLength': 256}), 'error': ref('RpcError')})
schema = {'$schema': 'http://json-schema.org/draft-07/schema#', '$id': SCHEMA_ID,
    '$comment': 'Generated by schema-source.py. DRAFT. Do not edit this file manually.',
    'oneOf': [ref(name) for name in ('Request', 'Notification', 'Success', 'Failure')], 'definitions': D}
outputs = {'schema.json': schema, 'methods.json': {'generatedBy': 'schema-source.py', 'version': VERSION, 'methods': METHODS}}
for name, content in outputs.items():
    expected = json.dumps(content, ensure_ascii=False, indent=2) + '\n'
    path = ROOT / name
    if '--check' in sys.argv:
        if not path.exists() or path.read_text() != expected:
            raise SystemExit('STOP: generated file differs: ' + name)
    else:
        path.write_text(expected)
print('Schema generation matches.' if '--check' in sys.argv else 'Generated schema.json and methods.json.')
