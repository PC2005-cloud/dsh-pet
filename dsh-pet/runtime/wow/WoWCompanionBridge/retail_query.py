"""Bounded read-only queries over one explicitly selected Retail DB2 export."""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import stat
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


KINDS = ("item", "map", "uimap", "area", "spell", "encounter")
TABLE_COLUMNS = {
    "Item": ("ID", "ClassID", "SubclassID"),
    "ItemSparse": ("ID", "Display_lang", "ItemLevel", "RequiredLevel", "OverallQualityID", "InventoryType", "SellPrice", "BuyPrice", "Description_lang"),
    "Map": ("ID", "MapName_lang", "Directory", "MapType", "InstanceType", "ExpansionID", "ParentMapID", "AreaTableID"),
    "UiMap": ("ID", "Name_lang", "ParentUiMapID", "System", "Type", "ContentTuningID"),
    "AreaTable": ("ID", "AreaName_lang", "ContinentID", "ParentAreaID", "ContentTuningID", "FactionGroupMask"),
    "SpellName": ("ID", "Name_lang"),
    "Spell": ("ID", "NameSubtext_lang", "Description_lang", "AuraDescription_lang"),
    "DungeonEncounter": ("ID", "Name_lang", "MapID", "DifficultyID", "OrderIndex", "Faction"),
}
DEPENDENCIES = {
    "item": ("Item", "ItemSparse"), "map": ("Map",), "uimap": ("UiMap",),
    "area": ("AreaTable",), "spell": ("SpellName", "Spell"), "encounter": ("DungeonEncounter", "Map"),
}
PRIMARY_TABLE = {"item": "Item", "map": "Map", "uimap": "UiMap", "area": "AreaTable", "spell": "SpellName", "encounter": "DungeonEncounter"}
# Raw tables keep stored view SQL out of the query surface. Identifiers come only from these fixed definitions.
SELECTS = {
    "item": ('i.ID,s.Display_lang AS title,s.ItemLevel,s.RequiredLevel,s.OverallQualityID,i.ClassID,i.SubclassID,s.InventoryType,s.SellPrice,s.BuyPrice,s.Description_lang', 'Item i LEFT JOIN ItemSparse s ON i.ID=s.ID', 'i.ID', 's.Display_lang'),
    "map": ('m.ID,m.MapName_lang AS title,m.Directory,m.MapType,m.InstanceType,m.ExpansionID,m.ParentMapID,m.AreaTableID', 'Map m', 'm.ID', 'm.MapName_lang'),
    "uimap": ('u.ID,u.Name_lang AS title,u.ParentUiMapID,u.System,u.Type,u.ContentTuningID', 'UiMap u', 'u.ID', 'u.Name_lang'),
    "area": ('a.ID,a.AreaName_lang AS title,a.ContinentID,a.ParentAreaID,a.ContentTuningID,a.FactionGroupMask', 'AreaTable a', 'a.ID', 'a.AreaName_lang'),
    "spell": ('n.ID,n.Name_lang AS title,s.NameSubtext_lang,s.Description_lang,s.AuraDescription_lang', 'SpellName n LEFT JOIN Spell s ON n.ID=s.ID', 'n.ID', 'n.Name_lang'),
    "encounter": ('e.ID,e.Name_lang AS title,e.MapID,e.DifficultyID,e.OrderIndex,e.Faction,m.MapName_lang', 'DungeonEncounter e LEFT JOIN Map m ON CAST(e.MapID AS INTEGER)=m.ID', 'e.ID', 'e.Name_lang'),
}
MAX_RESPONSE_BYTES = 512 * 1024


class QueryFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _integer(value: object, minimum: int, maximum: int) -> bool:
    return type(value) is int and minimum <= value <= maximum


def _request(value: object) -> dict:
    if not isinstance(value, dict) or value.get("operation") not in ("stats", "search", "fetch"):
        raise QueryFailure("query-invalid")
    operation = value["operation"]
    if operation == "stats":
        if set(value) != {"operation"}:
            raise QueryFailure("query-invalid")
        return dict(value)
    if operation == "fetch":
        if set(value) != {"operation", "id"} or not isinstance(value["id"], str):
            raise QueryFailure("query-invalid")
        match = re.fullmatch(r"(item|map|uimap|area|spell|encounter):(0|[1-9][0-9]{0,9})", value["id"])
        if not match or int(match[2]) > 2147483647:
            raise QueryFailure("query-invalid")
        return {**value, "kind": match[1], "numericId": int(match[2])}
    if set(value) - {"operation", "kind", "query", "offset", "limit"} or value.get("kind") not in KINDS:
        raise QueryFailure("query-invalid")
    query = value.get("query")
    if not isinstance(query, str) or not query.strip() or len(query) > 160 or any(ord(char) < 32 for char in query):
        raise QueryFailure("query-invalid")
    offset, limit = value.get("offset", 0), value.get("limit", 20)
    if not _integer(offset, 0, 10000) or not _integer(limit, 1, 50):
        raise QueryFailure("query-invalid")
    return {**value, "query": query.strip(), "offset": offset, "limit": limit}


def _fingerprint(path: Path) -> tuple[int, int, int]:
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise QueryFailure("database-invalid")
    return info.st_size, info.st_mtime_ns, info.st_ino


def _text(value: object, maximum: int, notices: set[str]) -> str:
    text = str(value)
    clean = "".join(char for char in text if char in "\n\t" or ord(char) >= 32 and not 127 <= ord(char) <= 159)
    if len(clean) > maximum:
        notices.add("result-truncated")
    return clean[:maximum]


def _entry(kind: str, row: sqlite3.Row) -> dict:
    identifier = row["ID"]
    if not _integer(identifier, 0, 2147483647):
        raise QueryFailure("database-invalid")
    notices: set[str] = set()
    title = _text(row["title"], 256, notices).strip() if row["title"] is not None else ""
    if not title:
        title = f"#{identifier}"
        notices.add("missing-fields")
    fields = []
    for key in row.keys():
        if key in ("ID", "title"):
            continue
        if row[key] is None:
            notices.add("missing-fields")
            continue
        fields.append({"key": key, "value": _text(row[key], 4096, notices)})
    links = []
    relations = {
        "map": (("ParentMapID", "map"), ("AreaTableID", "area")),
        "uimap": (("ParentUiMapID", "uimap"),),
        "area": (("ContinentID", "map"), ("ParentAreaID", "area")),
        "encounter": (("MapID", "map"),),
    }.get(kind, ())
    for key, target_kind in relations:
        raw = row[key]
        if raw is None or not re.fullmatch(r"0|[1-9][0-9]{0,9}", str(raw)):
            continue
        number = int(raw)
        # Zero is a valid base Map ID. Zero parent identifiers in other namespaces mean no parent.
        if number > 2147483647 or (number == 0 and not (target_kind == "map" and key in ("ParentMapID", "ContinentID", "MapID"))):
            continue
        if target_kind == kind and number == identifier:
            continue
        link = {"kind": target_kind, "id": f"{target_kind}:{number}"}
        if kind == "encounter" and row["MapName_lang"]:
            link["title"] = _text(row["MapName_lang"], 256, notices)
        links.append(link)
    if kind == "spell" and any("$" in field["value"] for field in fields):
        notices.add("raw-spell-template")
    entry = {"id": f"{kind}:{identifier}", "kind": kind, "numericId": identifier, "title": title,
             "fields": fields, "links": links, "notices": sorted(notices)}
    # A per-entry byte budget keeps all requested pagination rows within the response cap.
    while len(json.dumps(entry, ensure_ascii=False).encode()) > 8192:
        longest = max(fields, key=lambda field: len(field["value"]))
        longest["value"] = longest["value"][:len(longest["value"]) // 2]
        notices.add("result-truncated")
        entry["notices"] = sorted(notices)
    return entry


class RetailDatabase:
    """Each request owns one immutable read connection and a deadline. No SQL or paths cross the request boundary."""
    def __init__(self, database: Path, *, clock=time.monotonic, query_seconds: float = 2.0):
        self.database = database.resolve()
        self.clock = clock
        self.query_seconds = query_seconds

    @staticmethod
    def _authorize(action, first, second, _database, _trigger):
        if action == sqlite3.SQLITE_READ:
            return sqlite3.SQLITE_OK if first in (*TABLE_COLUMNS, "_export_metadata", "_export_tables", "sqlite_master") else sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_TRANSACTION):
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_PRAGMA:
            return sqlite3.SQLITE_OK if first == "table_info" and second in (*TABLE_COLUMNS, "_export_metadata", "_export_tables") else sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION:
            return sqlite3.SQLITE_OK if second in ("like", "coalesce") else sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_DENY

    @staticmethod
    def _metadata(db: sqlite3.Connection, fingerprint: tuple[int, int, int]) -> tuple[dict, dict]:
        required = {**TABLE_COLUMNS, "_export_metadata": ("key", "value"), "_export_tables": ("name", "status", "rows", "metadata")}
        table_rows = db.execute('SELECT name,type FROM sqlite_master WHERE name IN (' + ','.join('?' for _ in required) + ')', tuple(required)).fetchall()
        if {row["name"] for row in table_rows if row["type"] == "table"} != set(required):
            raise QueryFailure("database-invalid")
        for table, columns in required.items():
            present = {row["name"] for row in db.execute(f'PRAGMA table_info("{table}")')}
            if not set(columns) <= present:
                raise QueryFailure("database-invalid")
        keys = ("build", "locale", "product", "localOnly", "hotfixesApplied", "updatedAt")
        pairs = db.execute('SELECT key,value FROM _export_metadata WHERE key IN (?,?,?,?,?,?)', keys).fetchall()
        try:
            metadata = {row["key"]: json.loads(row["value"]) for row in pairs if isinstance(row["value"], str) and len(row["value"]) <= 256}
            if (len(pairs) != len(keys) or set(metadata) != set(keys) or metadata["product"] != "wow" or metadata["localOnly"] is not True
                    or type(metadata["hotfixesApplied"]) is not bool
                    or not isinstance(metadata["build"], str) or len(metadata["build"]) > 40 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+", metadata["build"])
                    or not isinstance(metadata["locale"], str) or not re.fullmatch(r"[a-z]{2}[A-Z]{2}", metadata["locale"])
                    or not isinstance(metadata["updatedAt"], str) or len(metadata["updatedAt"]) > 80
                    or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})", metadata["updatedAt"])
                    or datetime.fromisoformat(metadata["updatedAt"].replace("Z", "+00:00")).tzinfo is None):
                raise QueryFailure("database-invalid")
        except (ValueError, TypeError):
            raise QueryFailure("database-invalid") from None
        descriptors = {}
        descriptions = db.execute('SELECT name,status,rows FROM _export_tables WHERE name IN (' + ','.join('?' for _ in TABLE_COLUMNS) + ')', tuple(TABLE_COLUMNS)).fetchall()
        if len(descriptions) != len(TABLE_COLUMNS):
            raise QueryFailure("database-invalid")
        for row in descriptions:
            if row["status"] not in ("decoded", "decoded_with_encrypted_sections") or not _integer(row["rows"], 0, 9007199254740991):
                raise QueryFailure("database-invalid")
            descriptors[row["name"]] = {"name": row["name"], "status": row["status"], "rows": row["rows"], "encrypted": row["status"] == "decoded_with_encrypted_sections"}
        if set(descriptors) != set(TABLE_COLUMNS):
            raise QueryFailure("database-invalid")
        identity = {"build": metadata["build"], "locale": metadata["locale"], "exportedAt": metadata["updatedAt"], "size": fingerprint[0], "modifiedNs": fingerprint[1]}
        source = {"name": "正式服本地 DB2", "game": "retail", "product": "wow", "localOnly": True,
                  "build": metadata["build"], "locale": metadata["locale"], "exportedAt": metadata["updatedAt"],
                  "hotfixesApplied": metadata["hotfixesApplied"],
                  "datasetId": hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest(), "tables": []}
        return source, descriptors

    def execute(self, payload: object) -> dict:
        operation = payload.get("operation") if isinstance(payload, dict) and payload.get("operation") in ("stats", "search", "fetch") else "stats"
        result = {"operation": operation, "outcome": "error", "source": None, "entries": [], "offset": 0, "limit": 0,
                  "hasMore": False, "notices": [], "receivedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds")}
        deadline = self.clock() + self.query_seconds
        try:
            request = _request(payload)
            fingerprint = _fingerprint(self.database)
            wal = Path(str(self.database) + "-wal")
            if wal.exists() and wal.stat().st_size > 0:
                raise QueryFailure("database-invalid")
            with self.database.open("rb") as stream:
                if stream.read(16) != b"SQLite format 3\x00":
                    raise QueryFailure("database-invalid")
            # Immutable snapshots avoid WAL/SHM or journal writes. Active WAL exports must finish before querying.
            with closing(sqlite3.connect(self.database.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=1, isolation_level=None)) as db:
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA query_only=ON")
                db.execute("PRAGMA trusted_schema=OFF")
                db.set_authorizer(self._authorize)
                db.set_progress_handler(lambda: int(self.clock() > deadline), 1000)
                db.execute("BEGIN")
                source, tables = self._metadata(db, fingerprint)
                dependencies = tuple(TABLE_COLUMNS) if operation == "stats" else DEPENDENCIES[request["kind"]]
                source["tables"] = [tables[table] for table in dependencies]
                result["source"] = source
                notices = {"client-db2-only"}
                if not source["hotfixesApplied"]:
                    notices.add("hotfixes-not-applied")
                if any(table["encrypted"] for table in source["tables"]):
                    notices.add("encrypted-sections")
                if request.get("kind") == "map":
                    notices.add("map-id-not-uimap-id")
                if request.get("kind") in ("area", "uimap"):
                    notices.add("content-tuning-not-exploration-level")
                if operation == "stats":
                    result["stats"] = {"counts": {kind: tables[PRIMARY_TABLE[kind]]["rows"] for kind in KINDS}}
                    result["outcome"] = "ok"
                else:
                    columns, table, id_column, name_column = SELECTS[request["kind"]]
                    if operation == "fetch":
                        sql = f'SELECT {columns} FROM {table} WHERE {id_column}=? LIMIT 1'
                        rows = db.execute(sql, (request["numericId"],)).fetchall()
                        result["limit"] = 1
                    else:
                        query = request["query"]
                        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                        number = int(query) if re.fullmatch(r"0|[1-9][0-9]{0,9}", query) and int(query) <= 2147483647 else -1
                        sql = f'''SELECT {columns} FROM {table}
                            WHERE {id_column}=? OR {name_column} LIKE ? ESCAPE '\\'
                            ORDER BY CASE WHEN {id_column}=? THEN 0 WHEN {name_column}=? COLLATE NOCASE THEN 1
                            WHEN {name_column} LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END,{id_column}
                            LIMIT ? OFFSET ?'''
                        rows = db.execute(sql, (number, f"%{escaped}%", number, query, f"{escaped}%", request["limit"] + 1, request["offset"])).fetchall()
                        result.update(offset=request["offset"], limit=request["limit"], hasMore=len(rows) > request["limit"])
                        rows = rows[:request["limit"]]
                    result["entries"] = [_entry(request["kind"], row) for row in rows]
                    result["outcome"] = "ok" if rows else "not_found" if operation == "fetch" else "empty"
                if self.clock() > deadline:
                    raise QueryFailure("query-timeout")
                if _fingerprint(self.database) != fingerprint:
                    raise QueryFailure("database-changed")
                result["notices"] = sorted(notices)
                if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_RESPONSE_BYTES:
                    raise QueryFailure("query-failed")
            return result
        except FileNotFoundError:
            code = "database-missing"
        except PermissionError:
            code = "database-unreadable"
        except QueryFailure as exc:
            code = exc.code
        except sqlite3.DatabaseError:
            code = "query-timeout" if self.clock() > deadline else "database-invalid"
        except (OSError, ValueError, TypeError, OverflowError, RecursionError):
            code = "database-invalid"
        result.update(outcome="error", entries=[], hasMore=False, offset=0, limit=0, errorCode=code)
        result.pop("stats", None)
        return result
