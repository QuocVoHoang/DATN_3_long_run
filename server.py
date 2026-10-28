#!/usr/bin/env python3
import os, sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy','same-origin')
        self.send_header('Cross-Origin-Embedder-Policy','require-corp')
        self.send_header('Cache-Control','no-store')
        super().end_headers()
if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    HTTPServer(('0.0.0.0', int(sys.argv[1]) if len(sys.argv)>1 else 8090), Handler).serve_forever()
