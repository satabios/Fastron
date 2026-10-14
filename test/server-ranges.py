"""Offline checks for the versioned HTTP model source."""
import importlib.util
import io
import pathlib
import tempfile
import types
import unittest
from email.message import Message

spec = importlib.util.spec_from_file_location(
    "fastron_server", pathlib.Path(__file__).parents[1] / "source" / "server.py"
)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class Handler(server._HTTPRequestHandler):
    def __init__(self, provider, method="GET", headers=None):
        self.server = types.SimpleNamespace(content=provider)
        self.command = method
        self.headers = Message()
        for key, value in (headers or {}).items():
            self.headers[key] = value
        self.wfile = io.BytesIO()
        self.response_headers = {}

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.response_headers[key] = value

    def end_headers(self):
        pass

    def _write(self, status, content_type, content, **kwargs):
        self.status = status


class RangeTests(unittest.TestCase):
    def test_file_ranges_are_versioned_and_reject_changed_files(self):
        with tempfile.TemporaryDirectory() as folder:
            file = pathlib.Path(folder) / "model.onnx"
            file.write_bytes(bytes(range(32)))
            provider = server._ContentProvider(None, str(file), str(file), None)
            head = Handler(provider, "HEAD")
            head._serve_data("model.onnx")
            self.assertEqual(head.status, 200)
            self.assertEqual(head.response_headers["Content-Length"], "32")
            self.assertEqual(head.wfile.getvalue(), b"")
            etag = head.response_headers["ETag"]
            read = Handler(provider, headers={"Range": "bytes=4-11", "If-Match": etag})
            read._serve_data("model.onnx")
            self.assertEqual(read.status, 206)
            self.assertEqual(read.response_headers["ETag"], etag)
            self.assertEqual(read.response_headers["Content-Range"], "bytes 4-11/32")
            self.assertEqual(read.wfile.getvalue(), bytes(range(4, 12)))
            file.write_bytes(b"changed")
            stale = Handler(provider, headers={"Range": "bytes=0-3", "If-Match": etag})
            stale._serve_data("model.onnx")
            self.assertEqual(stale.status, 412)
            self.assertEqual(stale.wfile.getvalue(), b"")
            self.assertIsNone(provider.resolve("../outside.onnx"))

    def test_memory_ranges_share_an_immutable_version(self):
        data = bytearray(b"1234")
        provider = server._ContentProvider(data, "model.onnx", "model.onnx", None)
        first = Handler(provider, headers={"Range": "bytes=0-1"})
        first._serve_data("model.onnx")
        data[:] = b"5678"
        second = Handler(provider, headers={"Range": "bytes=2-3"})
        second._serve_data("model.onnx")
        self.assertEqual(
            first.response_headers["ETag"], second.response_headers["ETag"]
        )
        self.assertEqual(first.wfile.getvalue() + second.wfile.getvalue(), b"1234")

    def test_invalid_range_and_worker_asset_types(self):
        provider = server._ContentProvider(b"1234", "model.onnx", "model.onnx", None)
        invalid = Handler(provider, headers={"Range": "bytes=4-8"})
        invalid._serve_data("model.onnx")
        self.assertEqual(invalid.status, 416)
        self.assertEqual(invalid.response_headers["Content-Range"], "bytes */4")
        self.assertEqual(
            server._HTTPRequestHandler.mime_types[".mjs"], "text/javascript"
        )
        self.assertEqual(
            server._HTTPRequestHandler.mime_types[".wasm"], "application/wasm"
        )


if __name__ == "__main__":
    unittest.main()
