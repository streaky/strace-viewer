"""Run with: python tests/integration/test_server.py /path/to/built/viewer"""
from contextlib import contextmanager
import os
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


def config_environment(root):
    environment = os.environ.copy()
    environment["HOME"] = str(root / "home")
    environment["XDG_CONFIG_HOME"] = str(root / "xdg")
    return environment


@contextmanager
def running_viewer(directory, environment, *options):
    process = subprocess.Popen(
        [str(BINARY), *options, str(TRACE)], cwd=directory, env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        readable, _, _ = select.select([process.stdout], [], [], 30)
        if not readable:
            raise RuntimeError("Viewer did not report its URL")
        line = process.stdout.readline().strip()
        match = re.fullmatch(r"strace-viewer: (http://\S+/\?key=[A-Za-z0-9_-]{12})", line)
        if match is None:
            raise RuntimeError(f"Unexpected startup output: {line!r}")
        yield urlsplit(match[1])
    finally:
        process.terminate()
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()


class ViewerServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if BINARY is None:
            raise RuntimeError("Pass the built viewer executable as the first argument")
        cls.runtime = tempfile.TemporaryDirectory(prefix="strace-viewer-server-")
        cls.addClassCleanup(cls.runtime.cleanup)
        cls.environment = config_environment(Path(cls.runtime.name))
        cls.url = cls.enterClassContext(running_viewer(cls.runtime.name, cls.environment))
        if cls.url.hostname != "127.0.0.1":
            raise AssertionError(f"Expected loopback by default: {cls.url.hostname!r}")
        if not 1024 <= cls.url.port <= 65535:
            raise AssertionError(f"Expected an unprivileged port: {cls.url.port}")
        cls.target = cls.url.path + "?" + cls.url.query
        cls.key = parse_qs(cls.url.query)["key"][0]
        if list(Path(cls.runtime.name).iterdir()):
            raise AssertionError("Default serving must not write an HTML export")


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
            [str(BINARY), str(TRACE), str(output)], cwd=self.runtime.name, env=self.environment,
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(exported.returncode, 0, exported.stdout + exported.stderr)
        self.assertEqual(output.read_bytes(), self.request(self.target)[2])

    def test_invalid_argument_counts_do_not_start_server(self):
        for arguments in [[], [str(TRACE), "output.html", "extra"]]:
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [str(BINARY), *arguments], cwd=self.runtime.name, env=self.environment,
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 1)
                self.assertNotIn("http://", result.stdout)

    def test_configuration_location_and_bind_override(self):
        with tempfile.TemporaryDirectory(prefix="strace-viewer-settings-") as directory:
            root = Path(directory)
            home_config = root / "home/.config/strace-viewer/config.yaml"
            xdg_config = root / "xdg/strace-viewer/config.yaml"
            for config, bind in [(home_config, "127.0.0.2"), (xdg_config, "127.0.0.3")]:
                config.parent.mkdir(parents=True)
                config.write_text(f"server: {{bind: {bind}, port: 0}}\n")
            environment = config_environment(root)
            cases = [
                ("", [], "127.0.0.2"),
                ("relative", [], "127.0.0.2"),
                (str(root / "xdg"), [], "127.0.0.3"),
                (str(root / "xdg"), ["--bind", "0.0.0.0"], "0.0.0.0"),
            ]
            for xdg, options, expected in cases:
                with self.subTest(xdg=xdg, options=options):
                    environment["XDG_CONFIG_HOME"] = xdg
                    with running_viewer(directory, environment, *options) as url:
                        self.assertEqual(url.hostname, expected)
                        host = "127.0.0.1" if expected == "0.0.0.0" else expected
                        connection = http.client.HTTPConnection(host, url.port, timeout=10)
                        try:
                            connection.request("GET", url.path + "?" + url.query)
                            response = connection.getresponse()
                            self.assertEqual(response.status, 200)
                            self.assertIn(b"POST /api/login", response.read())
                        finally:
                            connection.close()

    def test_invalid_config_blocks_serving_but_not_export_or_help(self):
        with tempfile.TemporaryDirectory(prefix="strace-viewer-invalid-config-") as directory:
            root = Path(directory)
            environment = config_environment(root)
            config = root / "xdg/strace-viewer/config.yaml"
            config.parent.mkdir(parents=True)
            config.write_text("server: {port: -1}\n")
            result = subprocess.run(
                [str(BINARY), str(TRACE)], cwd=directory, env=environment,
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn(str(config), result.stdout)
            output = root / "export.html"
            for arguments in [["--help"], [str(TRACE), str(output)]]:
                with self.subTest(arguments=arguments):
                    result = subprocess.run(
                        [str(BINARY), *arguments], cwd=directory, env=environment,
                        capture_output=True, text=True, timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(output.read_bytes(), self.request(self.target)[2])


if __name__ == "__main__":
    unittest.main()
