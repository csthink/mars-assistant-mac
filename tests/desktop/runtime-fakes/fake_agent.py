"""Fake agent process, the target program of the test execution port (feature-t29 S-05; derived from the OD-281
cross-language fake_agent.py): stands in for a print-mode agent. Reads the prompt from stdin and emits
stream-json-like frames on stdout. Never shipped; only the integration test registers the port that runs it.

Usage: fake_agent.py <vector>
Vectors: valid (init, one Write, result, exit 0); hang (init, then never exits; the Host cancels or times out);
         fail (init, then exit 1 without a result frame); slow (init, sleeps 2 s, result).
"""
import json
import sys
import time
import uuid
from pathlib import Path

VECTOR = sys.argv[1] if len(sys.argv) > 1 else 'valid'
SESSION = str(uuid.uuid4())
CWD = Path.cwd()
MODEL = 'synthetic-model-1'


def emit(frame):
    sys.stdout.write(json.dumps(frame) + '\n')
    sys.stdout.flush()


def assistant(content):
    return {'type': 'assistant', 'message': {'id': 'msg_fake', 'type': 'message', 'role': 'assistant', 'model': MODEL, 'content': content, 'stop_reason': None, 'usage': {'input_tokens': 1, 'output_tokens': 1}},
            'parent_tool_use_id': None, 'uuid': str(uuid.uuid4()), 'session_id': SESSION}


def main():
    prompt = sys.stdin.readline()
    assert prompt.startswith('test prompt'), 'prompt not delivered on stdin'
    emit({'type': 'system', 'subtype': 'init', 'cwd': str(CWD), 'session_id': SESSION, 'tools': ['Write'], 'mcp_servers': [], 'model': MODEL, 'permissionMode': 'acceptEdits', 'claude_code_version': 'fake', 'uuid': str(uuid.uuid4())})
    if VECTOR == 'hang':
        while True:
            time.sleep(3600)
    if VECTOR == 'fail':
        sys.exit(1)
    if VECTOR == 'slow':
        time.sleep(2)
    tid = 'toolu_write'
    emit(assistant([{'type': 'tool_use', 'id': tid, 'name': 'Write', 'input': {'file_path': str(CWD / 'candidate.md'), 'content': 'candidate\n'}}]))
    (CWD / 'candidate.md').write_text('candidate by the fake agent\n')
    emit({'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': tid, 'content': 'File written'}]}, 'parent_tool_use_id': None, 'uuid': str(uuid.uuid4()), 'session_id': SESSION})
    emit(assistant([{'type': 'text', 'text': 'Done.'}]))
    emit({'type': 'result', 'subtype': 'success', 'is_error': False, 'num_turns': 2, 'result': 'Done.', 'stop_reason': 'end_turn', 'total_cost_usd': 0.0, 'modelUsage': {MODEL: {'inputTokens': 1, 'outputTokens': 1, 'costUSD': 0.0}},
          'permission_denials': [], 'uuid': str(uuid.uuid4()), 'session_id': SESSION})


if __name__ == '__main__':
    main()
