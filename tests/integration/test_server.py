"""Run with: python tests/integration/test_server.py /path/to/built/viewer"""
import http.client
from pathlib import Path
import re
import select
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit


BINARY = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else None
PROJECT = Path(__file__).resolve().parents[2]
TRACE = PROJECT / "tests/fixtures/http.trace"


class ViewerServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if BINARY is None:
            raise RuntimeError("Pass the built viewer executable as the first argument")
        cls.runtime = tempfile.TemporaryDirectory(prefix="strace-viewer-server-")
        cls.addClassCleanup(cls.runtime.cleanup)
        cls.server = subprocess.Popen(
            [str(BINARY), str(TRACE)], cwd=cls.runtime.name,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        cls.addClassCleanup(cls.stop_server)
        readable, _, _ = select.select([cls.server.stdout], [], [], 30)
        if not readable:
            raise RuntimeError("Viewer did not report its URL")
        line = cls.server.stdout.readline().strip()
        match = re.fullmatch(r"strace-viewer: (http://127\.0\.0\.1:\d+/\?key=[A-Za-z0-9_-]{12})", line)
        if match is None:
            raise RuntimeError(f"Unexpected startup output: {line!r}")
        cls.url = urlsplit(match[1])
        if not 1024 <= cls.url.port <= 65535:
            raise AssertionError(f"Expected an unprivileged port: {cls.url.port}")
        cls.target = cls.url.path + "?" + cls.url.query
        cls.key = parse_qs(cls.url.query)["key"][0]
        if list(Path(cls.runtime.name).iterdir()):
            raise AssertionError("Default serving must not write an HTML export")

    @classmethod
    def stop_server(cls):
        cls.server.terminate()
        try:
            cls.server.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            cls.server.kill()
            cls.server.communicate()

    @classmethod
    def request(cls, target, method="GET"):
        connection = http.client.HTTPConnection(cls.url.hostname, cls.url.port, timeout=10)
        try:
            connection.request(method, target)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_authorized_page_and_head_metadata(self):
        status, headers, body = self.request(self.target)
        self.assertEqual(status, 200)
        self.assertTrue(headers["content-type"].startswith("text/html"))
        self.assertIn(b"POST /api/login", body)
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(headers["referrer-policy"], "no-referrer")
        status, head_headers, head_body = self.request(self.target, "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(head_body, b"")
        self.assertEqual(int(head_headers["content-length"]), len(body))
        self.assertEqual(head_headers["content-type"], headers["content-type"])

    def test_missing_wrong_keys_and_unregistered_paths(self):
        for target, expected in [("/", 403), ("/?key=wrong", 403), ("/openapi.json?key=" + self.key, 404)]:
            with self.subTest(target=target):
                status, _, body = self.request(target)
                self.assertEqual(status, expected)
                self.assertNotIn(b"POST /api/login", body)
        self.assertEqual(self.request("/", "HEAD")[0], 403)

    def test_explicit_html_export_matches_served_page(self):
        output = Path(self.runtime.name) / "export.html"
        exported = subprocess.run(
            [str(BINARY), str(TRACE), str(output)], cwd=self.runtime.name,
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(exported.returncode, 0, exported.stdout + exported.stderr)
        self.assertEqual(output.read_bytes(), self.request(self.target)[2])

    def test_invalid_argument_counts_do_not_start_server(self):
        for arguments in [[], [str(TRACE), "output.html", "extra"]]:
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [str(BINARY), *arguments], cwd=self.runtime.name,
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 1)
                self.assertNotIn("http://", result.stdout)


if __name__ == "__main__":
    unittest.main()
