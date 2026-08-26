# QY70/QY100 Web Console
# Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
# Licensed under the GNU General Public License v3.0 or later. See LICENSE.
# Support future development: <https://www.patreon.com/doffu>

"""Local dev server that disables caching entirely, so edits always show up
on a normal reload instead of getting stuck behind the browser's HTTP cache."""
import http.server


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.test(HandlerClass=NoCacheHandler, port=port)
