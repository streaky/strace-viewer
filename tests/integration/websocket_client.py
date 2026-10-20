"""Small synchronous text client for the viewer's wire-contract tests."""
import base64
import hashlib
import json
import os
import socket
import struct


class WebSocket:
    def __init__(self, url, key):
        self.socket = socket.create_connection((url.hostname, url.port), timeout=5)
        self.reader = self.socket.makefile('rb')
        nonce = base64.b64encode(os.urandom(16)).decode('ascii')
        self.socket.sendall((
            f'GET /events/{key} HTTP/1.1\r\nHost: {url.netloc}\r\n'
            'Upgrade: websocket\r\nConnection: Upgrade\r\n'
            f'Sec-WebSocket-Key: {nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n'
        ).encode('ascii'))
        status = self.reader.readline()
        headers = {}
        while line := self.reader.readline().strip():
            name, value = line.decode('ascii').split(':', 1)
            headers[name.lower()] = value.strip()
        expected = base64.b64encode(hashlib.sha1((nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode('ascii')).digest()).decode('ascii')
        if not status.startswith(b'HTTP/1.1 101 ') or headers.get('sec-websocket-accept') != expected:
            self.close()
            raise AssertionError(f'WebSocket upgrade rejected: {status!r}')

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def close(self):
        self.reader.close()
        self.socket.close()

    def send(self, value):
        payload = json.dumps(value).encode('utf-8')
        length = len(payload)
        header = bytes([0x81, 0x80 | length]) if length < 126 else bytes([0x81, 0xfe]) + struct.pack('!H', length)
        mask = os.urandom(4)
        self.socket.sendall(header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))

    def receive(self):
        header = self.reader.read(2)
        if len(header) != 2 or header[0] != 0x81 or header[1] & 0x80:
            raise AssertionError(f'Expected an unfragmented server text frame: {header!r}')
        length = header[1] & 0x7f
        if length == 126:
            length = struct.unpack('!H', self.reader.read(2))[0]
        elif length == 127:
            length = struct.unpack('!Q', self.reader.read(8))[0]
        return json.loads(self.reader.read(length))

    def exchange(self, value):
        self.send(value)
        return self.receive()
