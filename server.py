#!/usr/bin/env python3
"""Concurrent isolated HTTP/HTTPS artifact server (no build side effects)."""
import argparse
import functools
import os
import ssl
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('port', nargs='?', type=int, default=8091)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--cert')
    parser.add_argument('--key')
    parser.add_argument('--lan-host', help='DNS name or IP present in certificate SAN, for printed LAN URL')
    args = parser.parse_args()
    if bool(args.cert) != bool(args.key):
        parser.error('--cert and --key must be supplied together')
    handler = functools.partial(Handler, directory=os.path.dirname(os.path.abspath(__file__)))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    scheme = 'https' if args.cert else 'http'
    if args.cert:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(args.cert, args.key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    host = args.lan_host or ('localhost' if args.host in ('0.0.0.0', '127.0.0.1') else args.host)
    print(f'Serving {scheme}://{host}:{server.server_port}/', flush=True)
    if not args.cert:
        print(f'Local secure-context exception: http://localhost:{server.server_port}/; LAN requires trusted HTTPS.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
