"""Exercise the read-only DB2 service with real SQLite, HTTP, and owned CLI processes."""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from retail_query import MAX_RESPONSE_BYTES, TABLE_COLUMNS, RetailDatabase
from server import BridgeServer

TOKEN = "a5" * 32
INSTANCE = "c4717bf4-bf5b-43cf-a540-b7684d740ba5"


@contextmanager
def edit_database(path: Path):
    db = sqlite3.connect(path)
    try:
        yield db
        db.commit()
    finally:
        db.close()


def create_database(path: Path):
    with edit_database(path) as db:
        for table, columns in TABLE_COLUMNS.items():
            db.execute(f'CREATE TABLE "{table}" (' + ','.join(f'"{column}" ' + ('INTEGER PRIMARY KEY' if column == 'ID' else 'TEXT') for column in columns) + ')')
        db.execute('CREATE TABLE _export_metadata(key TEXT PRIMARY KEY,value TEXT)')
        metadata = {"product": "wow", "build": "12.1.5.70575", "locale": "zhCN", "localOnly": True,
                    "hotfixesApplied": False, "updatedAt": "2026-10-30T15:32:33.5754384+00:00", "gameRoot": "PRIVATE_GAME_PATH"}
        db.executemany('INSERT INTO _export_metadata VALUES (?,?)', [(key, json.dumps(value)) for key, value in metadata.items()])
        db.execute('CREATE TABLE _export_tables(name TEXT PRIMARY KEY,status TEXT,rows INTEGER,metadata TEXT)')
        db.executemany('INSERT INTO Item(ID,ClassID,SubclassID) VALUES (?,3,4)', [(1,), (2,), (3,), (4,), (5,)])
        db.executemany('INSERT INTO ItemSparse(ID,Display_lang,ItemLevel,RequiredLevel,Description_lang) VALUES (?,?,?,NULL,?)',
                       [(1, "测试材料", "", "原始描述"), (3, "测试材料二", "8", "次级材料"), (4, "100%材料", "3", ""), (5, "A_B", "2", "")])
        db.execute('INSERT INTO Map(ID,MapName_lang,ParentMapID) VALUES (0,?,?)', ("艾泽拉斯", "-1"))
        db.execute('INSERT INTO UiMap(ID,Name_lang,ParentUiMapID,ContentTuningID) VALUES (0,?,?,?)', ("世界地图", "0", "22"))
        db.execute('INSERT INTO AreaTable(ID,AreaName_lang,ContinentID,ContentTuningID) VALUES (3,?,?,?)', ("塔伦米尔", "0", "123"))
        db.execute('INSERT INTO SpellName(ID,Name_lang) VALUES (133,?)', ("火球术",))
        db.execute('INSERT INTO Spell(ID,Description_lang) VALUES (133,?)', ("造成$s1伤害，持续$d。",))
        db.execute('INSERT INTO DungeonEncounter(ID,Name_lang,MapID,DifficultyID,OrderIndex,Faction) VALUES (7,?,?,?,?,?)', ("测试首领", "0", "1", "0", "0"))
        for table in TABLE_COLUMNS:
            encrypted = table in ("Item", "ItemSparse", "SpellName", "Spell", "AreaTable")
            count = db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            db.execute('INSERT INTO _export_tables VALUES (?,?,?,?)', (table, "decoded_with_encrypted_sections" if encrypted else "decoded", count, '{}'))


class RetailQueryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wow-retail-readonly-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "retail.sqlite3"
        create_database(self.path)
        self.database = RetailDatabase(self.path)

    def fetch(self, identifier):
        return self.database.execute({"operation": "fetch", "id": identifier})

    def test_six_entity_kinds_and_map_zero_have_explicit_local_sources(self):
        for identifier in ["item:1", "map:0", "uimap:0", "area:3", "spell:133", "encounter:7"]:
            with self.subTest(identifier=identifier):
                result = self.fetch(identifier)
                self.assertEqual(result["outcome"], "ok")
                self.assertEqual(result["entries"][0]["id"], identifier)
                self.assertEqual(result["source"]["name"], "正式服本地 DB2")
                self.assertEqual(result["source"]["game"], "retail")
                self.assertEqual(result["source"]["exportedAt"], "2026-10-30T15:32:33.5754384+00:00")
                self.assertEqual(len(result["source"]["datasetId"]), 64)
                self.assertNotIn("PRIVATE_GAME_PATH", json.dumps(result))
                self.assertNotIn(str(self.path), json.dumps(result))

    def test_scope_notices_preserve_hotfix_encryption_and_raw_spell_templates(self):
        item = self.fetch("item:1")
        self.assertIn("hotfixes-not-applied", item["notices"])
        self.assertIn("encrypted-sections", item["notices"])
        self.assertEqual({table["name"] for table in item["source"]["tables"]}, {"Item", "ItemSparse"})
        self.assertIn("map-id-not-uimap-id", self.fetch("map:0")["notices"])
        self.assertIn("content-tuning-not-exploration-level", self.fetch("area:3")["notices"])
        spell = self.fetch("spell:133")["entries"][0]
        self.assertIn("raw-spell-template", spell["notices"])
        self.assertIn("$s1", next(field["value"] for field in spell["fields"] if field["key"] == "Description_lang"))

    def test_null_missing_names_and_empty_text_are_not_fabricated_as_zero(self):
        entry = self.fetch("item:1")["entries"][0]
        self.assertNotIn("RequiredLevel", {field["key"] for field in entry["fields"]})
        self.assertEqual(next(field["value"] for field in entry["fields"] if field["key"] == "ItemLevel"), "")
        self.assertIn("missing-fields", entry["notices"])
        missing = self.fetch("item:2")["entries"][0]
        self.assertEqual(missing["title"], "#2")
        self.assertIn("missing-fields", missing["notices"])

    def test_relations_keep_world_map_and_base_map_namespaces_distinct(self):
        self.assertEqual(self.fetch("area:3")["entries"][0]["links"], [{"kind": "map", "id": "map:0"}])
        encounter = self.fetch("encounter:7")["entries"][0]
        self.assertEqual(encounter["links"], [{"kind": "map", "id": "map:0", "title": "艾泽拉斯"}])
        self.assertEqual(self.fetch("uimap:0")["entries"][0]["links"], [])

    def test_stats_counts_cover_only_supported_tables(self):
        result = self.database.execute({"operation": "stats"})
        self.assertEqual(result["stats"]["counts"], {"item": 5, "map": 1, "uimap": 1, "area": 1, "spell": 1, "encounter": 1})
        self.assertEqual(len(result["source"]["tables"]), 8)
        self.assertEqual(result["entries"], [])
        self.assertEqual(result["limit"], 0)

    def test_search_is_literal_paginated_and_deterministic(self):
        request = {"operation": "search", "kind": "item", "query": "测试材料", "limit": 1}
        first = self.database.execute(request)
        second = self.database.execute({**request, "offset": 1})
        self.assertEqual([entry["id"] for entry in first["entries"]], ["item:1"])
        self.assertTrue(first["hasMore"])
        self.assertEqual([entry["id"] for entry in second["entries"]], ["item:3"])
        self.assertFalse(second["hasMore"])
        for query, wanted in [("%", "item:4"), ("_", "item:5"), ("1", "item:1")]:
            self.assertEqual(self.database.execute({"operation": "search", "kind": "item", "query": query})["entries"][0]["id"], wanted)

    def test_not_found_and_empty_remain_snapshot_scoped(self):
        self.assertEqual(self.fetch("item:999")["outcome"], "not_found")
        result = self.database.execute({"operation": "search", "kind": "item", "query": "不存在"})
        self.assertEqual(result["outcome"], "empty")
        self.assertIn("encrypted-sections", result["notices"])

    def test_sql_and_path_inputs_are_rejected_or_bound_as_literal_names(self):
        for request in [
            {"operation": "stats", "sql": "DROP TABLE Item"}, {"operation": "stats", "database": str(self.path)},
            {"operation": "fetch", "id": "recipe:1"}, {"operation": "fetch", "id": "map:2147483648"},
            {"operation": "fetch", "id": "map:00"}, {"operation": "search", "kind": "item", "query": "x", "limit": 51},
            {"operation": "search", "kind": "item", "query": "x", "offset": -1},
            {"operation": "search", "kind": "item", "query": "x", "offset": True},
            {"operation": "search", "kind": "item", "query": " "},
        ]:
            with self.subTest(request=request):
                self.assertEqual(self.database.execute(request)["errorCode"], "query-invalid")
        result = self.database.execute({"operation": "search", "kind": "item", "query": "'; DROP TABLE Item; --"})
        self.assertEqual(result["outcome"], "empty")
        self.assertEqual(self.database.execute({"operation": "stats"})["stats"]["counts"]["item"], 5)

    def test_queries_leave_source_bytes_metadata_and_sidecars_unchanged(self):
        before = self.path.stat()
        digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        files = sorted(path.name for path in self.path.parent.iterdir())
        for operation in [{"operation": "stats"}, {"operation": "fetch", "id": "item:1"}, {"operation": "search", "kind": "item", "query": "测试"}]:
            self.database.execute(operation)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), digest)
        self.assertEqual(self.path.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(sorted(path.name for path in self.path.parent.iterdir()), files)

    def test_wrong_product_missing_schema_and_corrupt_files_report_stable_codes(self):
        with edit_database(self.path) as db:
            db.execute('UPDATE _export_metadata SET value=? WHERE key="product"', (json.dumps("wowf"),))
        self.assertEqual(self.database.execute({"operation": "stats"})["errorCode"], "database-invalid")
        self.path.write_bytes(b"not sqlite")
        self.assertEqual(self.fetch("item:1")["errorCode"], "database-invalid")
        self.path.unlink()
        self.assertEqual(self.fetch("item:1")["errorCode"], "database-missing")

    def test_active_wal_exports_and_stored_views_are_not_queried(self):
        wal = Path(str(self.path) + "-wal")
        wal.write_bytes(b"export in progress")
        self.assertEqual(self.fetch("item:1")["errorCode"], "database-invalid")
        wal.unlink()
        with edit_database(self.path) as db:
            db.execute('DROP TABLE Spell')
            db.execute('CREATE VIEW Spell AS SELECT * FROM SpellName')
        self.assertEqual(self.fetch("item:1")["errorCode"], "database-invalid")

    def test_deadline_and_mid_query_replacement_have_explicit_failures(self):
        expired = RetailDatabase(self.path, query_seconds=-1)
        self.assertEqual(expired.execute({"operation": "stats"})["errorCode"], "query-timeout")
        calls = [0]
        def clock():
            calls[0] += 1
            if calls[0] > 1:
                info = self.path.stat()
                os.utime(self.path, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000))
            return 0
        changed = RetailDatabase(self.path, clock=clock)
        self.assertEqual(changed.execute({"operation": "stats"})["errorCode"], "database-changed")

    def test_long_entries_keep_pagination_rows_under_the_response_byte_budget(self):
        with edit_database(self.path) as db:
            for identifier in range(1000, 1061):
                db.execute('INSERT INTO SpellName(ID,Name_lang) VALUES (?,?)', (identifier, f"长法术{identifier}"))
                db.execute('INSERT INTO Spell(ID,Description_lang,AuraDescription_lang) VALUES (?,?,?)', (identifier, "超长文字" * 5000, "说明" * 5000))
        result = self.database.execute({"operation": "search", "kind": "spell", "query": "长法术", "limit": 50})
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(len(result["entries"]), 50)
        self.assertEqual(result["limit"], 50)
        self.assertTrue(result["hasMore"])
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False).encode()), MAX_RESPONSE_BYTES)
        self.assertTrue(all("result-truncated" in entry["notices"] for entry in result["entries"]))


class RetailHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="wow-retail-http-")
        cls.path = Path(cls.temp.name) / "retail.sqlite3"
        create_database(cls.path)
        cls.server = BridgeServer(("127.0.0.1", 0), database=RetailDatabase(cls.path), query_token=TOKEN, query_instance=INSTANCE)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.temp.cleanup()

    def request(self, method, path, data=None, *, token=TOKEN, headers=None):
        merged = {"Content-Type": "application/json"}
        if token is not None:
            merged["X-Wow-Query-Token"] = token
        merged.update(headers or {})
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            body = json.dumps(data) if data is not None else None
            conn.request(method, path, body, merged)
            result = conn.getresponse()
            return result.status, result.read()
        finally:
            conn.close()

    def test_health_and_all_methods_require_the_ownership_token(self):
        for method, path in [("GET", "/health"), ("POST", "/api/retail/query"), ("OPTIONS", "/health"), ("HEAD", "/health")]:
            for token in (None, "0" * 64):
                with self.subTest(method=method, token=token):
                    self.assertEqual(self.request(method, path, {"operation": "stats"}, token=token)[0], 403)
        status, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        health = json.loads(body)
        self.assertEqual(health["instanceId"], INSTANCE)
        self.assertEqual(health["mode"], "query-only")
        self.assertEqual(health["capabilities"], ["retail-db2"])
        self.assertEqual(health["version"], "2.19.0")
        self.assertNotIn(TOKEN, body.decode())
        self.assertIsNone(self.server.state)

    def test_capture_paths_and_request_configuration_are_unavailable(self):
        for path in ("/", "/api/status", "/api/frame.bmp", "/api/config", "/api/demo", "/api/reconnect"):
            self.assertEqual(self.request("GET", path)[0], 404)
            self.assertEqual(self.request("POST", path, {})[0], 404)
            self.assertEqual(self.request("OPTIONS", path)[0], 404)
        status, body = self.request("POST", "/api/retail/query", {"operation": "stats", "path": str(self.path)})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["errorCode"], "query-invalid")

    def test_foreign_origin_and_dns_rebinding_fail_even_with_a_valid_token(self):
        for headers in ({"Origin": "https://evil.example"}, {"Host": "evil.example:18767"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("GET", "/health", headers=headers)[0], 403)

    def test_authenticated_http_queries_do_not_need_a_character_connection(self):
        status, body = self.request("POST", "/api/retail/query", {"operation": "fetch", "id": "map:0"})
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(result["entries"][0]["id"], "map:0")


class RetailOwnedCliTests(unittest.TestCase):
    def test_query_only_never_loads_capture_and_exits_after_parent_eof(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        with tempfile.TemporaryDirectory(prefix="wow-retail-cli-") as directory:
            database = Path(directory) / "retail.sqlite3"
            create_database(database)
            instance = str(uuid.uuid4())
            wrapper = ('import server,sys\n'
                       'assert not any(name in sys.modules for name in ("capture","connection","window","geometry"))\n'
                       'def fail(*args): raise RuntimeError("capture must not run")\n'
                       'server.capture_loop=fail\nserver.main()\n')
            child = subprocess.Popen([sys.executable, "-u", "-c", wrapper, "--query-only", "--game", "retail", "--port", str(port),
                                      "--database", str(database), "--query-token", TOKEN, "--query-instance", instance, "--managed-stdin"],
                                     cwd=Path(__file__).parent, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            try:
                deadline = time.monotonic() + 8
                while True:
                    try:
                        request = Request(f"http://127.0.0.1:{port}/health", headers={"X-Wow-Query-Token": TOKEN})
                        with urlopen(request, timeout=.5) as response:
                            self.assertEqual(json.load(response)["instanceId"], instance)
                        break
                    except (URLError, TimeoutError):
                        if child.poll() is not None or time.monotonic() >= deadline:
                            self.fail("Owned query-only bridge did not become ready")
                        time.sleep(.05)
                child.stdin.close()
                self.assertEqual(child.wait(timeout=5), 0)
                self.assertEqual(sorted(path.name for path in Path(directory).iterdir()), ["retail.sqlite3"])
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                child.stdin.close()
                child.stderr.close()

    def test_query_only_rejects_capture_flags_missing_tokens_and_foreign_games(self):
        base = [sys.executable, str(Path(__file__).with_name("server.py")), "--query-only", "--database", str(Path(__file__).resolve())]
        for extra in [[], ["--game", "forever"], ["--config", "ignored.json"], ["--demo"]]:
            result = subprocess.run(base + extra, input=b"", capture_output=True, timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(TOKEN.encode(), result.stderr)


if __name__ == "__main__":
    unittest.main()
