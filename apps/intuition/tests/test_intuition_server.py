"""Tests for the intuition sidecar that need no weights and no JAX."""

import json
import os
import sys
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import intuition_server as srv  # noqa: E402


class FakeModel:
    name = "fake"

    def __init__(self):
        self.calls = []

    def policy(self, fen, history=None, start_fen=None):
        self.calls.append((fen, history, start_fen))
        return [{"uci": "e2e4", "prob": 0.6, "winProb": 0.55}, {"uci": "d2d4", "prob": 0.4, "winProb": 0.54}]


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = FakeModel()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.make_handler(cls.model))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def post(self, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/policy", data=json.dumps(body).encode(), method="POST")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_health(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health") as r:
            self.assertEqual(json.loads(r.read()), {"status": "ok", "model": "fake"})

    def test_policy(self):
        code, data = self.post({"fen": "startfen", "history": ["e2e4"], "startFen": None})
        self.assertEqual(code, 200)
        self.assertEqual(data["model"], "fake")
        self.assertEqual([m["uci"] for m in data["moves"]], ["e2e4", "d2d4"])
        self.assertEqual(self.model.calls[-1], ("startfen", ["e2e4"], None))

    def test_bad_request(self):
        code, data = self.post({"nofen": 1})
        self.assertEqual(code, 400)
        self.assertIn("bad request", data["error"])


class ImportStubTest(unittest.TestCase):
    def test_stubs_training_only_modules(self):
        saved = {k: sys.modules.pop(k) for k in list(sys.modules) if k.split(".")[0] in ("apache_beam", "grain")}
        try:
            srv._stub_training_only_imports()
            from apache_beam import coders  # noqa: F401
            from grain import python as pygrain

            coders.TupleCoder((coders.StrUtf8Coder(), coders.FloatCoder()))
            self.assertTrue(hasattr(pygrain, "DataLoader"))
        finally:
            for k in [k for k in sys.modules if k.split(".")[0] in ("apache_beam", "grain")]:
                del sys.modules[k]
            sys.modules.update(saved)

    def test_missing_repo_is_a_clear_error(self):
        with self.assertRaises(FileNotFoundError) as cm:
            srv.SearchlessPolicy("/nonexistent", "9M")
        self.assertIn("clone google-deepmind/searchless_chess", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
