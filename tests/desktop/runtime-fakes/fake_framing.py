"""Strict JSON-RPC frame parser for the Python graph fake (Contract README "传输与消息边界", scenarios C-01 / C-10).

Bundle member of the test graph runtime; copied from the OD-281 cross-language experiment (docs/design/runtime-contract-crosslang/framing.py) unchanged in behaviour.

Bytes are accumulated until LF; the size limit is enforced on the unfinished buffer before any parse; BOM, invalid
UTF-8, duplicate keys, batches (top-level arrays), NaN/Infinity, non-object params, excessive depth and container
member counts are rejected before dispatch. Standard library only.
"""
import json


class FrameError(Exception):
    def __init__(self, rpc_code, message, close=False):
        super().__init__(message)
        self.rpc_code = rpc_code
        self.close = close


class _Pairs:
    """object_pairs_hook that rejects duplicate keys."""

    def __call__(self, pairs):
        seen = set()
        out = {}
        for key, value in pairs:
            if key in seen:
                raise FrameError(-32700, 'duplicate key ' + key)
            seen.add(key)
            out[key] = value
        return out


def _reject_nonfinite(value):
    raise FrameError(-32700, 'NaN or Infinity is not JSON')


def check_shape(value, limits):
    """Depth and per-container member limits, checked before schema validation."""
    def walk(v, depth):
        if depth > limits['depth']:
            raise FrameError(-32600, 'depth exceeds %d' % limits['depth'])
        if isinstance(v, dict):
            if len(v) > limits['members']:
                raise FrameError(-32600, 'object exceeds %d members' % limits['members'])
            for x in v.values():
                walk(x, depth + 1)
        elif isinstance(v, list):
            if len(v) > limits['members']:
                raise FrameError(-32600, 'array exceeds %d members' % limits['members'])
            for x in v:
                walk(x, depth + 1)
    walk(value, 1)


def parse_frame(raw, limits):
    """raw: one line without the LF, as bytes. Returns the message object or raises FrameError."""
    if len(raw) + 1 > limits['frameBytes']:
        raise FrameError(-32600, 'frame exceeds %d bytes' % limits['frameBytes'], close=True)
    if raw.startswith(b'\xef\xbb\xbf'):
        raise FrameError(-32700, 'BOM is not allowed')
    try:
        text = raw.decode('utf-8', errors='strict')
    except UnicodeDecodeError as exc:
        raise FrameError(-32700, 'invalid UTF-8: %s' % exc.reason)
    if '\n' in text or '\r' in text:
        raise FrameError(-32700, 'unescaped newline inside a frame')
    try:
        value = json.loads(text, object_pairs_hook=_Pairs(), parse_constant=_reject_nonfinite)
    except FrameError:
        raise
    except ValueError as exc:
        raise FrameError(-32700, 'not JSON: %s' % exc)
    if isinstance(value, list):
        raise FrameError(-32600, 'batch or top-level array is not accepted')
    if not isinstance(value, dict):
        raise FrameError(-32600, 'frame is not a JSON object')
    check_shape(value, limits)
    if value.get('jsonrpc') != '2.0':
        raise FrameError(-32600, 'jsonrpc must be "2.0"')
    if 'method' in value:
        if not isinstance(value['method'], str):
            raise FrameError(-32600, 'method must be a string')
        if 'params' in value and not isinstance(value['params'], dict):
            raise FrameError(-32600, 'params must be an object')
        if 'id' in value and not isinstance(value['id'], str):
            raise FrameError(-32600, 'request id must be a string')
    else:
        if ('result' in value) == ('error' in value):
            raise FrameError(-32600, 'a response carries exactly one of result or error')
        if 'id' not in value:
            raise FrameError(-32600, 'response without id')
    return value


class LineReader:
    """Accumulates bytes to LF with the frame limit applied to the unfinished buffer (no oversized allocation first)."""

    def __init__(self, limits):
        self.limits = limits
        self.buffer = bytearray()
        self.overflow = False

    def feed(self, chunk):
        """Yields (raw_line or None, FrameError or None) per complete line; an overflow yields one close error."""
        out = []
        for byte in chunk:
            if self.overflow:
                if byte == 0x0A:
                    self.overflow = False
                continue
            if byte == 0x0A:
                out.append((bytes(self.buffer), None))
                self.buffer = bytearray()
                continue
            self.buffer.append(byte)
            if len(self.buffer) + 1 > self.limits['frameBytes']:
                out.append((None, FrameError(-32600, 'frame exceeds %d bytes before its LF arrived' % self.limits['frameBytes'], close=True)))
                self.buffer = bytearray()
                self.overflow = True
        return out
