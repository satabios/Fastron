""" Python Server implementation """

import errno
import gzip
import html
import http.server
import importlib
import importlib.metadata
import json
import logging
import os
import random
import re
import socket
import socketserver
import threading
import time
import urllib.parse
import webbrowser

try:
    __version__ = importlib.metadata.version("fastron")
except importlib.metadata.PackageNotFoundError:
    __version__ = "0.0.0"

logger = logging.getLogger(__name__)

# Static asset cache: path -> bytes. Populated on first request, reused thereafter.
_static_cache = {}
_static_cache_lock = threading.Lock()

# MIME types that benefit from gzip compression.
_GZIP_TYPES = {
    "text/html", "text/javascript", "text/css",
    "application/json", "image/svg+xml"
}

# Static assets are immutable for the lifetime of the server process.
_CACHE_CONTROL_STATIC = "public, max-age=3600"

class _ContentProvider:
    def __init__(self, data, path, file, name):
        self.data = data if data is not None else bytearray()
        self.identifier = os.path.basename(file) if file else ""
        self.name = name
        self.dir = "."
        self.base = ""
        if path:
            self.dir = os.path.dirname(path) if os.path.dirname(path) else "."
            self.base = os.path.basename(path)

    def resolve(self, path):
        if path == self.base and self.data is not None and len(self.data) > 0:
            return ("memory", self.data)
        base_dir = os.path.realpath(self.dir)
        filename = os.path.realpath(os.path.join(base_dir, path))
        try:
            inside = os.path.commonpath([base_dir, filename]) == base_dir
        except ValueError:
            inside = False
        if inside:
            if os.path.exists(filename) and not os.path.isdir(filename):
                return ("file", filename)
        return None

class _HTTPRequestHandler(http.server.BaseHTTPRequestHandler):
    mime_types = {
        ".html": "text/html",
        ".js":   "text/javascript",
        ".css":  "text/css",
        ".png":  "image/png",
        ".gif":  "image/gif",
        ".jpg":  "image/jpeg",
        ".ico":  "image/x-icon",
        ".json": "application/json",
        ".pb": "application/octet-stream",
        ".ttf": "font/truetype",
        ".otf": "font/opentype",
        ".eot": "application/vnd.ms-fontobject",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml"
    }
    def do_HEAD(self):
        self.do_GET()
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        path = "/index.html" if path == "/" else path
        status_code = 404
        content = None
        content_type = None
        gzipped = False
        is_static = False
        if path.startswith("/data/"):
            path = urllib.parse.unquote(path[len("/data/"):])
            self._serve_data(path)
            return
        else:
            base_dir = os.path.dirname(os.path.realpath(__file__))
            filename = os.path.normpath(os.path.realpath(base_dir + path))
            extension = os.path.splitext(filename)[1]
            if os.path.commonpath([base_dir, filename]) == base_dir and \
                os.path.exists(filename) and not os.path.isdir(filename) and \
                extension in self.mime_types:
                content_type = self.mime_types[extension]
                if path == "/index.html":
                    # index.html has dynamic meta injection —
                    # never cache on disk or in memory.
                    with open(filename, "rb") as file:
                        content = file.read()
                else:
                    # Static assets are immutable per server session — cache in memory.
                    with _static_cache_lock:
                        content = _static_cache.get(filename)
                    if content is None:
                        with open(filename, "rb") as file:
                            content = file.read()
                        with _static_cache_lock:
                            _static_cache[filename] = content
                    is_static = True
                if path == "/index.html":
                    content = content.decode("utf-8")
                    meta = [
                        '<meta name="type" content="Python">',
                        '<meta name="version" content="' + __version__ + '">'
                    ]
                    base = self.server.content.base
                    if base:
                        location = "/data/" + urllib.parse.quote(base, safe="")
                        escaped = html.escape(location, quote=True)
                        meta.append(f'<meta name="file" content="{escaped}">')
                    name = self.server.content.name
                    if name:
                        escaped = html.escape(str(name), quote=True)
                        meta.append(f'<meta name="name" content="{escaped}">')
                    identifier = self.server.content.identifier
                    if identifier:
                        escaped = html.escape(str(identifier), quote=True)
                        meta.append(f'<meta name="identifier" content="{escaped}">')
                    meta = "\n".join(meta)
                    regex = r'<meta name="version" content=".*">'
                    content = re.sub(regex, lambda _: meta, content)
                    content = content.encode("utf-8")
                # Compress text assets when client supports it and content is large.
                accept_encoding = self.headers.get("Accept-Encoding", "")
                gzip_ok = (
                    "gzip" in accept_encoding
                    and content_type in _GZIP_TYPES
                    and len(content) > 1024
                )
                if gzip_ok:
                    content = gzip.compress(content, compresslevel=6)
                    gzipped = True
                status_code = 200
        self._write(
            status_code, content_type, content,
            gzipped=gzipped, is_static=is_static,
        )

    def _serve_data(self, path):
        resource = self.server.content.resolve(path)
        if resource is None:
            self._write(404, None, None)
            return
        kind, value = resource
        total = len(value) if kind == "memory" else os.path.getsize(value)
        start = 0
        end = total - 1
        status_code = 200
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            valid = (
                match is not None
                and (match.group(1) or match.group(2))
                and total > 0
            )
            if valid:
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = int(last) if last else total - 1
                else:
                    suffix = int(last)
                    valid = suffix > 0
                    start = max(0, total - suffix)
                    end = total - 1
                end = min(end, total - 1)
                valid = valid and start < total and start <= end
            if not valid:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{total}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status_code = 206
        length = max(0, end - start + 1)
        self.send_response(status_code)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status_code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()
        if self.command == "HEAD" or length == 0:
            return
        try:
            if kind == "memory":
                self.wfile.write(value[start:end + 1])
            else:
                with open(value, "rb") as file:
                    file.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = file.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
    def log_message(self, format, *args):
        logger.debug(" ".join(args))
    def _write(
        self, status_code, content_type, content,
        gzipped=False, is_static=False,
    ):
        self.send_response(status_code)
        if content is not None:
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            if gzipped:
                self.send_header("Content-Encoding", "gzip")
            if is_static:
                self.send_header("Cache-Control", _CACHE_CONTROL_STATIC)
        self.end_headers()
        if self.command != "HEAD":
            if status_code == 404 and content is None:
                self.wfile.write(str(status_code).encode("utf-8"))
            elif (status_code in (200, 404)) and content is not None:
                self.wfile.write(content)

class _ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class _HTTPServerThread(threading.Thread):
    def __init__(self, content, address):
        threading.Thread.__init__(self)
        self.daemon = True
        self.address = address
        self.url = "http://" + address[0] + ":" + str(address[1])
        self.server = _ThreadedHTTPServer(address, _HTTPRequestHandler)
        self.server.content = content
        self.server.timeout = 0.25
        self.server.block_on_close = False
        self.terminate_event = threading.Event()
        self.terminate_event.set()
        self.stop_event = threading.Event()

    def run(self):
        self.stop_event.clear()
        self.terminate_event.clear()
        try:
            while not self.stop_event.is_set():
                self.server.handle_request()
        except (OSError, ValueError):
            logger.debug("Server loop stopped", exc_info=True)
        self.terminate_event.set()
        self.stop_event.clear()

    def stop(self):
        if self.alive():
            logger.info("Stopping " + self.url)
            self.stop_event.set()
            self.server.server_close()

    def alive(self):
        value = not self.terminate_event.is_set()
        return value

def _open(data):
    registry = dict([
        ("onnx.onnx_ml_pb2.ModelProto", ".onnx"),
        ("torch.jit._script.ScriptModule", ".pytorch"),
        ("torch.Graph", ".pytorch"),
        ("torch._C.Graph", ".pytorch"),
        ("torch.nn.modules.module.Module", ".pytorch")
    ])
    queue = [ data.__class__ ]
    while len(queue) > 0:
        current = queue.pop(0)
        if current.__module__ and current.__name__:
            name = current.__module__ + "." + current.__name__
            if name in registry:
                module_name = registry[name]
                module = importlib.import_module(module_name, package=__package__)
                model_factory = module.ModelFactory()
                return model_factory.open(data)
        queue.extend(_ for _ in current.__bases__ if isinstance(_, type))
    return None

def _threads(address=None):
    threads = []
    for thread in threading.enumerate():
        if isinstance(thread, _HTTPServerThread) and thread.alive():
            threads.append(thread)
    if address is not None:
        address = _make_address(address)
        threads = [ _ for _ in threads if address[0] == _.address[0] ]
        if address[1]:
            threads = [ _ for _ in threads if address[1] == _.address[1] ]
    return threads

def _make_address(address):
    if address is None or isinstance(address, int):
        port = address
        address = ("localhost", port)
    if isinstance(address, tuple) and len(address) == 2:
        host = address[0]
        port = address[1]
        if isinstance(host, str) and (port is None or isinstance(port, int)):
            return address
    raise ValueError("Invalid address.")

def _make_port(address):
    if address[1] is None or address[1] == 0:
        ports = []
        if address[1] != 0:
            ports.append(8080)
            ports.append(8081)
            rnd = random.Random()
            for _ in range(4):
                port = rnd.randrange(15000, 25000)
                if port not in ports:
                    ports.append(port)
        ports.append(0)
        for port in ports:
            temp_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            temp_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            temp_socket.settimeout(1)
            try:
                temp_socket.bind((address[0], port))
                sockname = temp_socket.getsockname()
                address = (address[0], sockname[1])
                return address
            except: # noqa: E722
                pass
            finally:
                temp_socket.close()
    if isinstance(address[1], int):
        return address
    raise ValueError("Failed to allocate port.")

def stop(address=None):
    """Stop serving model at address.

    Args:
        address (tuple, optional): A (host, port) tuple, or a port number.
    """
    threads = _threads(address)
    for thread in threads:
        thread.stop()

def status(address=None):
    """Is model served at address.

    Args:
        address (tuple, optional): A (host, port) tuple, or a port number.
    """
    threads = _threads(address)
    return len(threads) > 0

def wait():
    """Wait for console exit and stop all model servers."""
    try:
        while len(_threads()) > 0:
            time.sleep(0.1)
    except (KeyboardInterrupt, SystemExit):
        stop()

def serve(file, data=None, address=None, browse=False):
    """Start serving model from file or data buffer at address and open in web browser.

    Args:
        file (string): Model file to serve. Required to detect format.
        data (bytes): Model data to serve. None will load data from file.
        address (tuple, optional): A (host, port) tuple, or a port number.
        browse (bool, optional): Launch web browser. Default: True

    Returns:
        A (host, port) address tuple.
    """
    if not logging.getLogger().hasHandlers():
        logging.basicConfig(level=logging.INFO, format="%(message)s")

    has_data = data is not None
    if not has_data and file and not os.path.exists(file):
        raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), file)

    content = _ContentProvider(data, file, file, file)

    if (has_data and not isinstance(data, (bytes, bytearray, memoryview))
            and isinstance(data.__class__, type)):
        logger.info("Experimental")
        model = _open(data)
        if model:
            text = json.dumps(model.to_json(), indent=2, ensure_ascii=False)
            content = _ContentProvider(text.encode("utf-8"), "model.netron", None, file)

    address = _make_address(address)
    if isinstance(address[1], int) and address[1] != 0:
        stop(address)
    else:
        address = _make_port(address)

    thread = _HTTPServerThread(content, address)
    thread.start()
    while not thread.alive():
        time.sleep(0.01)
    state = ("Serving '" + file + "'") if file else "Serving"
    logger.info(f"{state} at {thread.url}")
    if browse:
        webbrowser.open(thread.url)

    return address

def start(file=None, address=None, browse=True):
    """Start serving model file at address and open in web browser.

    Args:
        file (string): Model file to serve.
        browse (bool, optional): Launch web browser, Default: True
        address (tuple, optional): A (host, port) tuple, or a port number.

    Returns:
        A (host, port) address tuple.
    """
    return serve(file, None, browse=browse, address=address)

def widget(address, height=800):
    """ Open address as Jupyter Notebook IFrame.

    Args:
        address (tuple, optional): A (host, port) tuple, or a port number.
        height (int, optional): Height of the IFrame, Default: 800

    Returns:
        A Jupyter Notebook IFrame.
    """
    address = _make_address(address)
    url = f"http://{address[0]}:{address[1]}"
    IPython = __import__("IPython")
    return IPython.display.IFrame(url, width="100%", height=height)
