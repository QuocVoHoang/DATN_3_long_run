import concurrent.futures
import importlib.util
import pathlib
import ssl
import subprocess
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from functools import partial

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('artifact_server', ROOT / 'server.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ServerTests(unittest.TestCase):
    def check_server(self, tls=None, context=None):
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(module.Handler, directory=str(ROOT)))
        if tls:
            server.socket = tls.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        def fetch(path):
            scheme = 'https' if tls else 'http'
            request = urllib.request.Request(f'{scheme}://localhost:{server.server_port}/{path}', method='HEAD')
            try:
                response = urllib.request.urlopen(request, context=context)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                self.assertEqual(response.headers['Cross-Origin-Opener-Policy'], 'same-origin')
                self.assertEqual(response.headers['Cross-Origin-Embedder-Policy'], 'require-corp')
                self.assertEqual(response.headers['Cross-Origin-Resource-Policy'], 'same-origin')
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                list(executor.map(fetch, ['index.html', 'build/motion_engine.wasm', 'missing-file', 'js/page.js']))
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_concurrent_http_headers_and_errors(self):
        self.check_server()

    def test_trusted_tls_localhost_san(self):
        # Test-only trusted root/leaf. Never bypass certificate verification.
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory:
            cert, key = str(pathlib.Path(directory) / 'cert.pem'), str(pathlib.Path(directory) / 'key.pem')
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
                            '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost',
                            '-keyout',key,'-out',cert], check=True, capture_output=True)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            self.check_server(tls, ssl.create_default_context(cafile=cert))

if __name__ == '__main__':
    unittest.main()
