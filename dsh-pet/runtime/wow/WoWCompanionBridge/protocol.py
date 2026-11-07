"""Retail WCP1 and Forever WCF1 telemetry. Pure Python, no Windows dependencies."""

from __future__ import annotations

import base64
import binascii
import json
import math
import re
import struct

COLS = ROWS = 64
FRAME_BYTES = 512
MAX_PAYLOAD = 504
MAX_SAFE_INTEGER = 9007199254740991
GAME_PROTOCOLS = {"retail": "WCP1", "forever": "WCF1"}
EQUIPMENT_CHUNK_BYTES = 240
EQUIPMENT_MAX_BYTES = 8192
EQUIPMENT_MAX_PARTS = 35
COMPARISON_MAX_BYTES = 4096
COMPARISON_MAX_PARTS = 18
LOADOUT_MAX_BYTES = 196608
LOADOUT_MAX_PARTS = 820
LOADOUT_ITEM_MAX_BYTES = 8192
INVENTORY_MAX_BYTES = 65536
INVENTORY_MAX_PARTS = 274
QUEST_MAX_BYTES = 32768
QUEST_MAX_PARTS = 137
TALENT_MAX_BYTES = 65536
TALENT_MAX_PARTS = 274


def frame_magic(protocol: str) -> bytes:
    if protocol not in GAME_PROTOCOLS.values():
        raise ValueError("Unknown WoW telemetry protocol")
    return protocol.encode("ascii")


class FrameError(ValueError):
    pass


class EquipmentSwapError(FrameError):
    """An intact swap frame failed validation, not the character heartbeat."""


class EquipmentOfferError(FrameError):
    """An intact offer frame failed validation, not the character heartbeat."""


class EquipmentComparisonError(FrameError):
    """An intact comparison fragment failed validation, not the character heartbeat."""


class EquipmentLoadoutError(FrameError):
    """An intact current-equipment fragment failed validation, not the heartbeat."""


class InventoryError(FrameError):
    """An intact inventory fragment failed validation, not the character heartbeat."""


class QuestError(FrameError):
    """An intact task fragment failed validation, not the heartbeat."""


class TalentError(FrameError):
    """An intact committed-talent fragment failed, not the character heartbeat."""


def load_json(payload: bytes) -> object:
    """Reject ambiguous object keys, non-finite numbers, and invalid UTF-8."""
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON field")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise ValueError("Invalid JSON number")

    try:
        return json.loads(payload.decode("utf-8"), object_pairs_hook=object_pairs,
                          parse_constant=invalid_constant)
    except (ValueError, UnicodeDecodeError, RecursionError) as exc:
        raise FrameError("遥测 JSON 或 UTF-8 不合法") from exc


def _text(value: object, key: str, maximum: int, *, nullable=False, identity=False):
    if nullable and value is None:
        return None
    try:
        valid = (isinstance(value, str) and len(value.encode("utf-8")) <= maximum
                 and not any(ord(c) < 32 for c in value))
    except UnicodeEncodeError:
        valid = False
    if not valid or (identity and re.fullmatch(r"[A-Za-z0-9_-]+", value) is None):
        raise FrameError(f"装备字段 {key} 不合法")
    return value


def _integer(value: object, key: str, minimum: int, maximum: int):
    if type(value) is not int or not minimum <= value <= maximum:
        raise FrameError(f"装备字段 {key} 超出范围")
    return value


def _number(value: object, key: str, minimum: float, maximum: float):
    if type(value) not in (int, float) or not minimum <= value <= maximum or not math.isfinite(value):
        raise FrameError(f"装备字段 {key} 超出范围")
    return value


def _validate_fragment(value: object, kind: str, maximum_parts: int, maximum_bytes: int) -> dict:
    if not isinstance(value, dict) or set(value) != {"v", "kind", "s", "g", "id", "p", "n", "d"}:
        raise FrameError("装备分片字段不完整或含未知字段")
    _integer(value["v"], "v", 1, 1)
    if value["kind"] != kind:
        raise FrameError("装备分片类型不合法")
    _text(value["s"], "s", 40, identity=True)
    _text(value["g"], "g", 48, identity=True)
    _integer(value["id"], "id", 1, 2147483647)
    count = _integer(value["n"], "n", 1, maximum_parts)
    part = _integer(value["p"], "p", 1, count)
    encoded = _text(value["d"], "d", 320)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise FrameError("装备分片 Base64 不合法") from exc
    if (not 1 <= len(raw) <= EQUIPMENT_CHUNK_BYTES
            or (part < count and len(raw) != EQUIPMENT_CHUNK_BYTES)
            or (part == count and (count - 1) * EQUIPMENT_CHUNK_BYTES + len(raw) > maximum_bytes)
            or base64.b64encode(raw).decode("ascii") != encoded):
        raise FrameError("装备分片长度或 Base64 编码不合法")
    return dict(value)


def validate_equipment_fragment(value: object) -> dict:
    return _validate_fragment(value, "eq", EQUIPMENT_MAX_PARTS, EQUIPMENT_MAX_BYTES)


def validate_comparison_fragment(value: object) -> dict:
    try:
        return _validate_fragment(value, "cmp", COMPARISON_MAX_PARTS, COMPARISON_MAX_BYTES)
    except FrameError as exc:
        raise EquipmentComparisonError(f"装备比较分片无效：{exc}") from exc


def validate_loadout_fragment(value: object) -> dict:
    try:
        return _validate_fragment(value, "gear", LOADOUT_MAX_PARTS, LOADOUT_MAX_BYTES)
    except FrameError as exc:
        raise EquipmentLoadoutError(f"当前装备分片无效：{exc}") from exc


def validate_inventory_fragment(value: object) -> dict:
    try:
        return _validate_fragment(value, "inv", INVENTORY_MAX_PARTS, INVENTORY_MAX_BYTES)
    except FrameError as exc:
        raise InventoryError(f"背包库存分片无效：{exc}") from exc


def validate_inventory(value: object) -> dict:
    """Validate aggregated carried item counts. Missing bank data is explicitly unknown."""
    fields = {"v", "id", "session", "guid", "observedAt", "source", "bank", "complete", "items"}
    if not isinstance(value, dict) or set(value) != fields:
        raise FrameError("背包库存字段不完整或含未知字段")
    _integer(value["v"], "v", 1, 1)
    _integer(value["id"], "id", 1, 2147483647)
    _text(value["session"], "session", 40, identity=True)
    _text(value["guid"], "guid", 48, identity=True)
    _integer(value["observedAt"], "observedAt", 1, 4102444800)
    if (value["source"] != "bags" or value["bank"] != "unknown" or type(value["complete"]) is not bool
            or not isinstance(value["items"], list) or len(value["items"]) > 1000):
        raise FrameError("背包库存范围或完整性无效")
    previous = 0
    for item in value["items"]:
        if not isinstance(item, dict) or set(item) != {"itemID", "quantity"}:
            raise FrameError("背包库存物品字段无效")
        identifier = _integer(item["itemID"], "itemID", 1, 2147483647)
        _integer(item["quantity"], "quantity", 1, 2147483647)
        if identifier <= previous:
            raise FrameError("背包库存物品必须按编号升序且不重复")
        previous = identifier
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > INVENTORY_MAX_BYTES:
        raise FrameError("背包库存超过 65536 字节")
    return dict(value)


def validate_quest_fragment(value: object) -> dict:
    try:
        return _validate_fragment(value, "qlog", QUEST_MAX_PARTS, QUEST_MAX_BYTES)
    except FrameError as exc:
        raise QuestError(f"任务分片无效：{exc}") from exc


def validate_quests(value: object) -> dict:
    def exact(data, fields):
        if not isinstance(data, dict) or set(data) != set(fields.split()):
            raise FrameError("任务字段不完整或含未知字段")
    def flag(data, key, nullable=False):
        if type(data[key]) is not bool and not (nullable and data[key] is None):
            raise FrameError("任务布尔值无效")
    def count(data, key, high=2147483647, low=0, nullable=False):
        if not (nullable and data[key] is None):
            _integer(data[key], key, low, high)
    def labels(data, fields):
        for key, maximum in fields:
            _loadout_text(data[key], key, maximum, nullable=True)
    exact(value, "v id session guid observedAt source log completion")
    _integer(value["v"], "v", 1, 1)
    count(value, "id", low=1)
    _text(value["session"], "session", 40, identity=True)
    _text(value["guid"], "guid", 48, identity=True)
    count(value, "observedAt", high=4102444800, low=1)
    if value["source"] != "quest-log":
        raise FrameError("任务来源无效")
    log, completion = value["log"], value["completion"]
    exact(log, "complete truncated total entries")
    flag(log, "complete"); flag(log, "truncated"); count(log, "total", nullable=True)
    if not isinstance(log["entries"], list) or len(log["entries"]) > 50:
        raise FrameError("任务日志条目超过限制")
    previous = 0
    for entry in log["entries"]:
        exact(entry, "questID title level header readyForTurnIn failed objectivesComplete objectives")
        count(entry, "questID", low=1); count(entry, "level", high=255, nullable=True)
        labels(entry, (("title", 128), ("header", 128)))
        flag(entry, "readyForTurnIn", True); flag(entry, "failed", True); flag(entry, "objectivesComplete")
        if entry["questID"] <= previous:
            raise FrameError("任务编号必须升序且不重复")
        previous = entry["questID"]
        if not isinstance(entry["objectives"], list) or len(entry["objectives"]) > 8:
            raise FrameError("任务目标超过限制")
        objective_index = 0
        for objective in entry["objectives"]:
            exact(objective, "index text type fulfilled required finished")
            count(objective, "index", high=8, low=1)
            labels(objective, (("text", 256), ("type", 40)))
            count(objective, "fulfilled", nullable=True); count(objective, "required", nullable=True); flag(objective, "finished", True)
            if objective["index"] <= objective_index:
                raise FrameError("任务目标编号必须升序且不重复")
            objective_index = objective["index"]
    if log["complete"] and (log["truncated"] or log["total"] != len(log["entries"])):
        raise FrameError("任务日志覆盖声明不一致")
    exact(completion, "source scope complete truncated total ids turnIns")
    if completion["source"] not in ("completed-api", "session-events", "unknown") or completion["scope"] != "unknown":
        raise FrameError("任务完成证据或范围无效")
    flag(completion, "complete"); flag(completion, "truncated"); count(completion, "total", nullable=True)
    if not isinstance(completion["ids"], list) or len(completion["ids"]) > 512 or not isinstance(completion["turnIns"], list) or len(completion["turnIns"]) > 32:
        raise FrameError("任务完成记录超过限制")
    previous = 0
    for identifier in completion["ids"]:
        _integer(identifier, "questID", 1, 2147483647)
        if identifier <= previous:
            raise FrameError("任务完成编号必须升序且不重复")
        previous = identifier
    turned_in = set()
    for entry in completion["turnIns"]:
        exact(entry, "questID observedAt")
        count(entry, "questID", low=1); count(entry, "observedAt", high=value["observedAt"], low=1)
        if entry["questID"] in turned_in:
            raise FrameError("任务交付事件重复")
        turned_in.add(entry["questID"])
    if completion["complete"] and (completion["source"] != "completed-api" or completion["truncated"] or completion["total"] != len(completion["ids"])):
        raise FrameError("任务完成覆盖声明不一致")
    if completion["source"] != "completed-api" and (completion["ids"] or completion["total"] is not None):
        raise FrameError("无API证据不能提供任务完成标记")
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > QUEST_MAX_BYTES:
        raise FrameError("任务快照超过32768字节")
    return dict(value)


def validate_talent_fragment(value: object) -> dict:
    try:
        return _validate_fragment(value, "traits", TALENT_MAX_PARTS, TALENT_MAX_BYTES)
    except FrameError as exc:
        raise TalentError(f"天赋分片无效：{exc}") from exc


def validate_talents(value: object) -> dict:
    def exact(data, keys):
        if not isinstance(data, dict) or set(data) != set(keys.split()):
            raise FrameError("天赋字段不完整或含未知字段")
    def flag(value, nullable=True):
        if type(value) is not bool and not (nullable and value is None):
            raise FrameError("天赋布尔字段无效")
    def integer(value, high=2147483647, low=1, nullable=False):
        if not (nullable and value is None):
            _integer(value, "talent number", low, high)
    def ordered(values, field):
        previous = 0
        for row in values:
            identifier = row[field] if isinstance(row, dict) else row
            integer(identifier)
            if identifier <= previous:
                raise FrameError("天赋编号必须升序且不重复")
            previous = identifier
    def pairs(values):
        previous = (0, 0)
        for row in values:
            integer(row["treeID"]); integer(row["nodeID"])
            pair = row["treeID"], row["nodeID"]
            if pair <= previous or row["treeID"] not in value["treeIDs"]:
                raise FrameError("天赋树节点排序或范围无效")
            previous = pair
    exact(value, "v id session guid observedAt source clientBuild locale class classID specID configID configName configType status hasStagedChanges scope complete truncated treeIDs knownZeroNodes nodes")
    _integer(value["v"], "v", 1, 1); integer(value["id"]); integer(value["observedAt"], 4102444800)
    _text(value["session"], "session", 40, identity=True); _text(value["guid"], "guid", 48, identity=True)
    if value["source"] != "class-traits" or value["scope"] != "selected-nodes" or value["status"] not in ("active", "staged", "unknown", "inaccessible"):
        raise FrameError("天赋来源或提交状态无效")
    if value["clientBuild"] is not None and (not isinstance(value["clientBuild"], str) or len(value["clientBuild"]) > 40 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+", value["clientBuild"])):
        raise FrameError("天赋客户端构建无效")
    if value["locale"] is not None and (not isinstance(value["locale"], str) or not re.fullmatch(r"[a-z]{2}[A-Z]{2}", value["locale"])):
        raise FrameError("天赋客户端语言无效")
    if value["class"] is not None and (not isinstance(value["class"], str) or len(value["class"]) > 20 or not re.fullmatch(r"[A-Z][A-Z_]+", value["class"])):
        raise FrameError("天赋职业标识无效")
    for key in ("classID", "specID", "configID"):
        integer(value[key], nullable=True)
    integer(value["configType"], 1000, 0, True)
    _loadout_text(value["configName"], "configName", 128, nullable=True)
    flag(value["hasStagedChanges"]); flag(value["complete"], False); flag(value["truncated"], False)
    for key, maximum in (("treeIDs", 8), ("knownZeroNodes", 1024), ("nodes", 128)):
        if not isinstance(value[key], list) or len(value[key]) > maximum:
            raise FrameError("天赋列表超过限制")
    ordered(value["treeIDs"], "treeID")
    for zero in value["knownZeroNodes"]:
        exact(zero, "treeID nodeID")
    pairs(value["knownZeroNodes"])
    for node in value["nodes"]:
        exact(node, "treeID nodeID ranksPurchased activeRank maxRanks isAvailable isVisible meetsEdgeRequirements entriesComplete entries conditionsComplete conditions")
        integer(node["treeID"]); integer(node["nodeID"])
        for key in ("ranksPurchased", "activeRank", "maxRanks"):
            integer(node[key], 1000, 0, True)
        if not ((node["ranksPurchased"] or 0) > 0 or (node["activeRank"] or 0) > 0):
            raise FrameError("已选节点缺少实际rank证据")
        for key in ("isAvailable", "isVisible", "meetsEdgeRequirements"):
            flag(node[key])
        for key in ("entriesComplete", "conditionsComplete"):
            flag(node[key], False)
        for key in ("entries", "conditions"):
            if not isinstance(node[key], list) or len(node[key]) > 8:
                raise FrameError("天赋条目或条件超过限制")
        for entry in node["entries"]:
            exact(entry, "entryID definitionID spellID rank isActive")
            integer(entry["entryID"]); integer(entry["definitionID"], nullable=True); integer(entry["spellID"], nullable=True)
            integer(entry["rank"], 1000, 0, True); flag(entry["isActive"])
        ordered(node["entries"], "entryID")
        for condition in node["conditions"]:
            exact(condition, "conditionID isMet playerLevel spentAmountRequired traitCurrencyID")
            integer(condition["conditionID"]); flag(condition["isMet"])
            integer(condition["playerLevel"], 255, 0, True); integer(condition["spentAmountRequired"], low=0, nullable=True)
            integer(condition["traitCurrencyID"], nullable=True)
        ordered(node["conditions"], "conditionID")
    pairs(value["nodes"])
    selected = {(node["treeID"], node["nodeID"]) for node in value["nodes"]}
    if any((node["treeID"], node["nodeID"]) in selected for node in value["knownZeroNodes"]):
        raise FrameError("已选节点不能同时声明零rank")
    if value["status"] == "active" and (value["hasStagedChanges"] is not False or value["configID"] is None or value["configType"] not in (1, 4) or not value["treeIDs"]):
        raise FrameError("已生效天赋缺少稳定提交证据")
    if value["status"] == "staged" and value["hasStagedChanges"] is not True:
        raise FrameError("未提交状态缺少编辑证据")
    if value["status"] != "active" and (value["complete"] or value["nodes"] or value["knownZeroNodes"]):
        raise FrameError("未确认生效的配置不能提供实际rank")
    if value["complete"] and value["truncated"]:
        raise FrameError("截断天赋不能声明完整")
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > TALENT_MAX_BYTES:
        raise FrameError("天赋快照超过65536字节")
    return dict(value)


def _loadout_text(value: object, key: str, maximum: int, *, nullable=False, identity=False):
    result = _text(value, key, maximum, nullable=nullable, identity=identity)
    if result is not None and any(127 <= ord(character) <= 159 for character in result):
        raise FrameError(f"当前装备字段 {key} 含控制字符")
    return result


def validate_loadout_item(value: object) -> dict:
    fields = {"itemID", "itemGUID", "link", "name", "type", "subtype", "equipLoc", "quality",
              "itemLevel", "requiredLevel", "stats", "tooltip", "infoComplete", "statsComplete",
              "tooltipComplete", "truncated"}
    if not isinstance(value, dict) or set(value) != fields:
        raise FrameError("当前装备物品字段不完整或含未知字段")
    _integer(value["itemID"], "itemID", 1, 2147483647)
    link = _loadout_text(value["link"], "link", 1024)
    match = re.search(r"item:(\d+)", link)
    if match is None or int(match[1]) != value["itemID"]:
        raise FrameError("当前装备物品链接与标识不一致")
    for key in ("itemGUID", "name", "type", "subtype", "equipLoc"):
        label = _loadout_text(value[key], key, 128, nullable=True)
        if label == "":
            raise FrameError(f"当前装备字段 {key} 不允许空文字，未知值必须使用 null")
    for key, maximum in (("quality", 8), ("requiredLevel", 255)):
        if value[key] is not None:
            _integer(value[key], key, 0, maximum)
    if value["itemLevel"] is not None:
        _number(value["itemLevel"], "itemLevel", 0, 100000)
    for key in ("infoComplete", "statsComplete", "tooltipComplete", "truncated"):
        if type(value[key]) is not bool:
            raise FrameError(f"当前装备字段 {key} 必须是布尔值")
    stats = value["stats"]
    if not isinstance(stats, list) or len(stats) > 32:
        raise FrameError("当前装备属性数量不合法")
    keys = set()
    for entry in stats:
        if not isinstance(entry, dict) or set(entry) != {"key", "value"}:
            raise FrameError("当前装备属性字段不合法")
        key = _loadout_text(entry["key"], "stats.key", 64)
        if not key or key in keys:
            raise FrameError("当前装备属性标识为空或重复")
        keys.add(key)
        _number(entry["value"], "stats.value", -1e12, 1e12)
    tooltip = value["tooltip"]
    if not isinstance(tooltip, list) or len(tooltip) > 48:
        raise FrameError("当前装备说明行数不合法")
    for line in tooltip:
        if not _loadout_text(line, "tooltip", 256):
            raise FrameError("当前装备说明行不能为空")
    if value["infoComplete"] and (any(not value[key] for key in ("name", "type", "subtype", "equipLoc"))
                                  or any(value[key] is None for key in ("quality", "itemLevel", "requiredLevel"))):
        raise FrameError("完整当前装备缺少物品资料")
    if value["tooltipComplete"] and not tooltip:
        raise FrameError("完整当前装备说明不能为空")
    if value["truncated"] and all(value[key] for key in ("infoComplete", "statsComplete", "tooltipComplete")):
        raise FrameError("截断当前装备必须标明不完整资料")
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > LOADOUT_ITEM_MAX_BYTES:
        raise FrameError("当前装备单件资料超过 8192 字节")
    return value


def validate_equipment_loadout(value: object) -> dict:
    """Validate all slots together. Unknown and empty slots remain distinct."""
    fields = {"v", "id", "session", "guid", "observedAt", "reason", "slots"}
    if not isinstance(value, dict) or set(value) != fields:
        raise FrameError("当前装备快照字段不完整或含未知字段")
    _integer(value["v"], "v", 1, 1)
    _integer(value["id"], "id", 1, 2147483647)
    _loadout_text(value["session"], "session", 40, identity=True)
    _loadout_text(value["guid"], "guid", 48, identity=True)
    _integer(value["observedAt"], "observedAt", 0, 4102444800)
    if value["reason"] not in ("login", "equipment_acquired", "equipment_changed", "refresh"):
        raise FrameError("当前装备快照原因不合法")
    slots = value["slots"]
    if not isinstance(slots, list) or len(slots) != 19:
        raise FrameError("当前装备快照必须包含全部 19 个槽位")
    for expected_slot, entry in enumerate(slots, 1):
        if not isinstance(entry, dict) or set(entry) != {"slot", "state", "item"}:
            raise FrameError("当前装备槽位字段不完整或含未知字段")
        if _integer(entry["slot"], "slot", 1, 19) != expected_slot:
            raise FrameError("当前装备槽位必须从 1 到 19 排序且不重复")
        if entry["state"] == "equipped":
            validate_loadout_item(entry["item"])
        elif entry["state"] in ("empty", "unknown"):
            if entry["item"] is not None:
                raise FrameError("空或未知装备槽位必须使用 null 物品")
        else:
            raise FrameError("当前装备槽位状态不合法")
    return value


def _comparison_text(value: object, key: str, maximum: int, *, identity=False):
    text = _text(value, key, maximum, identity=identity)
    if any(127 <= ord(character) <= 159 for character in text):
        raise FrameError(f"装备比较字段 {key} 含控制字符")
    return text


def _comparison_item(value: object, *, candidate: bool):
    fields = {"itemID", "name", "itemLevel", "equipLoc", "type", "subtype", "stats", "complex", "complete"}
    if not isinstance(value, dict) or set(value) != fields:
        raise FrameError("装备比较物品字段不完整或含未知字段")
    identifier = _integer(value["itemID"], "itemID", 1 if candidate else 0, 2147483647)
    for key in ("name", "equipLoc", "type", "subtype"):
        _comparison_text(value[key], key, 128)
    _number(value["itemLevel"], "itemLevel", 0 if identifier else -1, 100000)
    for key in ("complex", "complete"):
        if type(value[key]) is not bool:
            raise FrameError(f"装备比较字段 {key} 必须是布尔值")
    stats = value["stats"]
    if not isinstance(stats, list) or len(stats) > 32:
        raise FrameError("装备比较属性数量不合法")
    keys = set()
    for stat in stats:
        if not isinstance(stat, dict) or set(stat) != {"key", "value"}:
            raise FrameError("装备比较属性字段不完整或含未知字段")
        key = _comparison_text(stat["key"], "stats.key", 64)
        if not key or key in keys:
            raise FrameError("装备比较属性标识为空或重复")
        keys.add(key)
        _number(stat["value"], "stats.value", -1e12, 1e12)
    if identifier == 0 and (value["itemLevel"] != -1 or stats):
        raise FrameError("装备比较空槽必须使用 -1 装等和空属性")
    if identifier and value["complete"] and any(not value[key] for key in ("name", "equipLoc", "type", "subtype")):
        raise FrameError("完整装备比较缺少物品资料")
    return value


def validate_equipment_comparison(value: object) -> dict:
    """Validate observed attributes. The bridge never decides which item is better."""
    fields = {"v", "id", "session", "guid", "class", "spec", "primary", "observedAt", "slot",
              "usable", "specMatch", "current", "candidate"}
    if not isinstance(value, dict) or set(value) != fields:
        raise FrameError("装备比较记录字段不完整或含未知字段")
    _integer(value["v"], "v", 1, 1)
    _integer(value["id"], "id", 1, 2147483647)
    _comparison_text(value["session"], "session", 40, identity=True)
    _comparison_text(value["guid"], "guid", 48, identity=True)
    token = _comparison_text(value["class"], "class", 32)
    if re.fullmatch(r"[A-Z_]{1,32}", token) is None:
        raise FrameError("装备比较职业标识不合法")
    _integer(value["spec"], "spec", 0, MAX_SAFE_INTEGER)
    primary = _integer(value["primary"], "primary", 0, 4)
    if primary not in (0, 1, 2, 4):
        raise FrameError("装备比较主属性标识不合法")
    _integer(value["observedAt"], "observedAt", 0, 4102444800)
    slot = _integer(value["slot"], "slot", 0, 19)
    if type(value["usable"]) is not bool or (value["specMatch"] is not None and type(value["specMatch"]) is not bool):
        raise FrameError("装备比较可用性或专精匹配标识不合法")
    if value["current"] is None:
        if slot != 0:
            raise FrameError("未知比较槽位必须使用 slot=0")
    else:
        if slot == 0:
            raise FrameError("已知比较槽位必须在 1–19 范围")
        _comparison_item(value["current"], candidate=False)
    _comparison_item(value["candidate"], candidate=True)
    return value


def validate_equipment_record(value: object) -> dict:
    fields = {"v", "id", "session", "guid", "itemID", "itemGUID", "link", "name", "type", "subtype",
              "equipLoc", "quality", "itemLevel", "requiredLevel", "stats", "tooltip", "quantity",
              "observedAt", "source", "infoComplete", "statsComplete", "tooltipComplete", "truncated"}
    if not isinstance(value, dict) or set(value) != fields:
        raise FrameError("装备记录字段不完整或含未知字段")
    _integer(value["v"], "v", 1, 1)
    for key in ("id", "itemID"):
        _integer(value[key], key, 1, 2147483647)
    _text(value["session"], "session", 40, identity=True)
    _text(value["guid"], "guid", 48, identity=True)
    _text(value["link"], "link", 1024)
    for key in ("itemGUID", "name", "type", "subtype", "equipLoc"):
        _text(value[key], key, 128, nullable=True)
    for key, maximum in (("quality", 8), ("requiredLevel", 255)):
        if value[key] is not None:
            _integer(value[key], key, 0, maximum)
    if value["itemLevel"] is not None:
        _number(value["itemLevel"], "itemLevel", 0, 100000)
    _integer(value["quantity"], "quantity", 1, 100000)
    _integer(value["observedAt"], "observedAt", 0, 4102444800)
    if value["source"] != "bag_added":
        raise FrameError("装备来源不合法")
    for key in ("infoComplete", "statsComplete", "tooltipComplete", "truncated"):
        if type(value[key]) is not bool:
            raise FrameError(f"装备字段 {key} 必须是布尔值")
    stats = value["stats"]
    if not isinstance(stats, list) or len(stats) > 32:
        raise FrameError("装备属性数量不合法")
    keys = set()
    for entry in stats:
        if not isinstance(entry, dict) or set(entry) != {"key", "value"}:
            raise FrameError("装备属性字段不合法")
        key = _text(entry["key"], "stats.key", 64)
        if not key or key in keys:
            raise FrameError("装备属性标识为空或重复")
        keys.add(key)
        _number(entry["value"], "stats.value", -1e12, 1e12)
    tooltip = value["tooltip"]
    if not isinstance(tooltip, list) or len(tooltip) > 48:
        raise FrameError("装备说明行数不合法")
    for line in tooltip:
        _text(line, "tooltip", 256)
    return value


def validate_equipment_swap(value: object) -> dict:
    """Read a game-reported outcome. This message never requests an action."""
    fields = {"v", "kind", "s", "g", "id", "e", "st", "r", "at", "slot", "item", "old"}
    try:
        if not isinstance(value, dict) or set(value) != fields:
            raise FrameError("换装结果字段不完整或含未知字段")
        _integer(value["v"], "v", 1, 1)
        if value["kind"] != "swap":
            raise FrameError("换装结果类型不合法")
        _text(value["s"], "s", 40, identity=True)
        _text(value["g"], "g", 48, identity=True)
        for key in ("id", "e", "item"):
            _integer(value[key], key, 1, 2147483647)
        _integer(value["old"], "old", 0, 2147483647)
        _integer(value["at"], "at", 0, 4102444800)
        _integer(value["slot"], "slot", 1, 19)
        reasons = {
            "equipped": ("confirmed",),
            "declined": ("user",),
            "expired": ("timeout",),
            "failed": ("timeout", "combat", "changed", "unavailable", "locked", "cursor",
                       "dead", "restricted", "disabled", "left_world"),
        }
        if (not isinstance(value["st"], str) or value["st"] not in reasons
                or value["r"] not in reasons[value["st"]]):
            raise FrameError("换装结果状态与原因不匹配")
        return dict(value)
    except FrameError as exc:
        raise EquipmentSwapError(str(exc)) from exc


def validate_group_buff(value: object) -> dict:
    fields = {"v", "kind", "s", "g", "e", "q", "st", "spell", "name", "missing", "checked", "total", "instanceType", "instanceID"}
    if not isinstance(value, dict) or set(value) != fields or value["kind"] != "buff":
        raise FrameError("Invalid group buff frame")
    _integer(value["v"], "v", 1, 1)
    _text(value["s"], "s", 40, identity=True)
    _text(value["g"], "g", 48, identity=True)
    _integer(value["e"], "e", 0, MAX_SAFE_INTEGER)
    _integer(value["q"], "q", 1, MAX_SAFE_INTEGER)
    _integer(value["spell"], "spell", 0, 2147483647)
    _integer(value["instanceID"], "instanceID", 0, 2147483647)
    name = _text(value["name"], "name", 96)
    for key in ("missing", "checked", "total"):
        _integer(value[key], key, 0, 40)
    if not 0 <= value["missing"] <= value["checked"] <= value["total"]:
        raise FrameError("Inconsistent group buff counts")
    if value["st"] not in ("inactive", "waiting", "ready") or "|" in name or "\x7f" in name:
        raise FrameError("Invalid group buff status or name")
    if value["instanceType"] not in ("unknown", "party", "raid", "pvp", "scenario"):
        raise FrameError("Invalid group buff instance")
    if value["st"] == "inactive":
        if any(value[k] for k in ("spell", "name", "missing", "checked", "total", "instanceID")) or value["instanceType"] != "unknown":
            raise FrameError("Inactive group buff carries observations")
    elif value["e"] == 0 or value["instanceID"] == 0 or value["instanceType"] == "unknown":
        raise FrameError("Group buff lacks entry identity")
    if value["spell"] not in (0, 6673, 1459, 21562, 1126, 462854, 364342) or bool(value["spell"]) != bool(name):
        raise FrameError("Invalid group buff spell")
    if value["st"] == "ready" and (not name or value["missing"] == 0 or value["total"] < 2):
        raise FrameError("Ready group buff lacks missing members")
    return dict(value)


def validate_calendar(value: object) -> dict:
    from datetime import date, datetime, timedelta
    fields = {"v", "kind", "s", "g", "day", "p", "n", "title", "action", "when"}
    if not isinstance(value, dict) or set(value) != fields or value["kind"] != "calendar":
        raise FrameError("Invalid calendar frame")
    _integer(value["v"], "v", 1, 1)
    _text(value["s"], "s", 40, identity=True)
    _text(value["g"], "g", 48, identity=True)
    _text(value["title"], "title", 160)
    _integer(value["n"], "n", 0, 32)
    _integer(value["p"], "p", 1, max(1, value["n"]))
    try:
        day = date.fromisoformat(value["day"])
        if day.isoformat() != value["day"]:
            raise ValueError()
        if value["n"] == 0:
            if (value["action"], value["title"], value["when"]) != ("none", "", ""):
                raise ValueError()
        else:
            when = datetime.strptime(value["when"], "%Y-%m-%d %H:%M")
            if not value["title"] or value["action"] not in ("start", "end", "personal_start", "personal_end", "reset", "reset_soon"):
                raise ValueError()
            expected = day if value["action"] in ("start", "personal_start", "reset") else day + timedelta(days=1)
            if when.date() != expected or when.strftime("%Y-%m-%d %H:%M") != value["when"]:
                raise ValueError()
    except (ValueError, TypeError, OverflowError):
        raise FrameError("Invalid calendar date or action") from None
    return dict(value)


def validate_macro(value: object) -> dict:
    fields = {"v", "kind", "s", "g", "q", "id", "st", "r", "hash", "bytes", "focus", "input", "chat", "combat"}
    if not isinstance(value, dict) or set(value) != fields or value["kind"] != "macro":
        raise FrameError("Invalid macro frame")
    _integer(value["v"], "v", 1, 1)
    _text(value["s"], "s", 40, identity=True)
    _text(value["g"], "g", 48, identity=True)
    _integer(value["q"], "q", 1, MAX_SAFE_INTEGER)
    _integer(value["hash"], "hash", 0, 4294967295)
    _integer(value["bytes"], "bytes", 0, 1048576)
    if value["id"] != "" and (not isinstance(value["id"], str) or not re.fullmatch(r"[0-9a-f]{32}", value["id"])):
        raise FrameError("Invalid macro request ID")
    if value["st"] not in ("idle", "ready", "edited", "saved", "error", "closed"):
        raise FrameError("Invalid macro state")
    if value["r"] not in ("", "empty", "length", "control", "command", "lua", "combat", "conflict", "full", "save", "saved"):
        raise FrameError("Invalid macro reason")
    for key in ("focus", "input", "chat", "combat"):
        if type(value[key]) is not bool:
            raise FrameError("Invalid macro focus or combat value")
    if (value["focus"] or value["chat"]) and not value["input"]:
        raise FrameError("Inconsistent macro focus")
    if value["focus"] and value["chat"]:
        raise FrameError("Conflicting input focus")
    return dict(value)


def validate_equipment_offer(value: object) -> dict:
    """A game confirmation is telemetry. Desktop choices cannot execute it."""
    fields = {"v", "kind", "s", "g", "id", "q", "st", "slot", "item", "n", "il", "old", "ol", "until"}
    try:
        if not isinstance(value, dict) or set(value) != fields:
            raise FrameError("换装提议字段不完整或含未知字段")
        _integer(value["v"], "v", 1, 1)
        if value["kind"] != "offer" or value["st"] not in ("ready", "closed"):
            raise FrameError("换装提议类型或状态不合法")
        _text(value["s"], "s", 40, identity=True)
        _text(value["g"], "g", 48, identity=True)
        for key in ("id", "q", "item"):
            _integer(value[key], key, 1, 2147483647)
        _integer(value["slot"], "slot", 1, 19)
        _integer(value["old"], "old", 0, 2147483647)
        _integer(value["until"], "until", 1, 4102444800)
        name = _text(value["n"], "n", 96)
        if not name or "\x7f" in name:
            raise FrameError("换装提议装备名为空或含控制字符")
        _number(value["il"], "il", 0, 100000)
        _number(value["ol"], "ol", -1, 100000)
        if value["il"] < value["ol"] or (value["ol"] != -1 if value["old"] == 0 else value["ol"] < 0):
            raise FrameError("换装提议低于当前装等或空槽标识无效")
        return dict(value)
    except FrameError as exc:
        raise EquipmentOfferError(str(exc)) from exc


def validate_message(value: object) -> dict:
    if isinstance(value, dict) and value.get("kind") == "traits":
        return validate_talent_fragment(value)
    if isinstance(value, dict) and value.get("kind") == "qlog":
        return validate_quest_fragment(value)
    if isinstance(value, dict) and value.get("kind") == "inv":
        return validate_inventory_fragment(value)
    if isinstance(value, dict) and value.get("kind") == "buff":
        return validate_group_buff(value)
    if isinstance(value, dict) and value.get("kind") == "calendar":
        return validate_calendar(value)
    if isinstance(value, dict) and value.get("kind") == "macro":
        return validate_macro(value)
    if isinstance(value, dict) and value.get("kind") == "gear":
        return validate_loadout_fragment(value)
    if isinstance(value, dict) and value.get("kind") == "cmp":
        return validate_comparison_fragment(value)
    if isinstance(value, dict) and value.get("kind") == "eq":
        return validate_equipment_fragment(value)
    if isinstance(value, dict) and value.get("kind") == "swap":
        return validate_equipment_swap(value)
    if isinstance(value, dict) and value.get("kind") == "offer":
        return validate_equipment_offer(value)
    return validate_snapshot(value)


def validate_snapshot(value: object) -> dict:
    if not isinstance(value, dict):
        raise FrameError("快照必须是 JSON 对象")
    if type(value.get("v")) is not int or value["v"] != 3:
        raise FrameError("角色快照需要 v3，请同时更新插件、桥接和 AIRI")
    string_limits = {"session": 64, "guid": 96, "name": 64, "realm": 96, "class": 32, "zone": 192}
    result = {"v": 3}
    for key, maximum in string_limits.items():
        item = value.get(key)
        if not isinstance(item, str) or len(item.encode("utf-8")) > maximum or any(ord(c) < 32 for c in item):
            raise FrameError(f"字段 {key} 不合法")
        result[key] = item
    if not result["session"] or not result["guid"] or not result["name"]:
        raise FrameError("缺少角色或会话标识")
    if not re.fullmatch(r"[A-Z_]{1,32}", result["class"]):
        raise FrameError("职业标识不合法")
    if "faction" not in value or value["faction"] not in (None, "Alliance", "Horde", "Neutral"):
        raise FrameError("字段 faction 必须是 Alliance、Horde、Neutral 或 null")
    result["faction"] = value["faction"]
    if "race" not in value:
        raise FrameError("缺少字段 race；未知种族必须显式传入 null")
    race = value["race"]
    if race is not None:
        try:
            valid_race = (isinstance(race, str) and 0 < len(race.encode("utf-8")) <= 48
                          and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in race))
        except UnicodeEncodeError:
            valid_race = False
        if not valid_race:
            raise FrameError("字段 race 必须是非空且最多 48 个 UTF-8 字节的种族名称或 null")
    result["race"] = race
    ranges = {"seq": (0, 2147483647), "tick": (0, 2147483647),
              "level": (1, 255), "spec": (0, 65535), "map": (0, 2147483647)}
    for key, (minimum, maximum) in ranges.items():
        item = value.get(key)
        if type(item) is not int or not minimum <= item <= maximum:
            raise FrameError(f"字段 {key} 超出范围")
        result[key] = item
    for key in ("account", "moneyEpoch"):
        item = value.get(key)
        if not isinstance(item, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,40}", item) is None:
            raise FrameError(f"字段 {key} 不合法")
        result[key] = item
    for key in ("copper", "earned", "spent"):
        item = value.get(key)
        if key == "copper" and key in value and item is None:
            result[key] = None
            continue
        if type(item) is not int or not 0 <= item <= MAX_SAFE_INTEGER:
            raise FrameError(f"字段 {key} 必须是安全的非负整数铜币数")
        result[key] = item
    for key in ("combat", "dead", "online"):
        item = value.get(key)
        if type(item) is not bool:
            raise FrameError(f"字段 {key} 必须是布尔值")
        result[key] = item
    # Both omitted fields are a supported v3 snapshot without position data.
    # A present pair uses map-relative fractions scaled by 10000, not screen pixels.
    has_x, has_y = "px" in value, "py" in value
    if has_x != has_y:
        raise FrameError("字段 px、py 必须成对传入或同时省略")
    px, py = value.get("px"), value.get("py")
    if px is not None or py is not None:
        if type(px) is not int or type(py) is not int or not 0 <= px <= 10000 or not 0 <= py <= 10000:
            raise FrameError("字段 px、py 必须同时为 0–10000 整数或同时为 null")
    # Invalid types are rejected before unavailable state clears a valid pair.
    # A position cannot describe a current character without an online map.
    if not result["online"] or result["map"] == 0:
        px, py = None, None
    result["px"], result["py"] = px, py
    # Scene observations are optional in v3. Missing fields never imply an outdoor scene.
    instance_types = ("none", "party", "raid", "pvp", "arena", "scenario", "unknown")
    if "instanceType" in value:
        kind = value["instanceType"]
        if not isinstance(kind, str) or kind not in instance_types:
            raise FrameError("字段 instanceType 不是支持的场景类型")
        result["instanceType"] = kind if result["online"] else "unknown"
    if "instanceID" in value:
        instance_id = value["instanceID"]
        if instance_id is not None:
            if type(instance_id) is not int or not 1 <= instance_id <= 2147483647:
                raise FrameError("字段 instanceID 必须是正整数副本标识或 null")
            if value.get("instanceType") not in ("party", "raid", "pvp", "arena", "scenario"):
                raise FrameError("副本标识需要已知的副本或战场类型")
        result["instanceID"] = instance_id if result["online"] else None
    return result


def encode_frame(snapshot: dict, protocol: str = "WCP1") -> bytes:
    """Used for fixtures and diagnostics; the game addon implements the same codec."""
    validate_message(snapshot)
    payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_PAYLOAD:
        raise FrameError("遥测数据超过 504 字节")
    frame = frame_magic(protocol) + struct.pack("<HH", len(payload), binascii.crc_hqx(payload, 0xFFFF)) + payload
    return frame.ljust(FRAME_BYTES, b"\0")


def decode_frame(frame: bytes, protocol: str = "WCP1") -> dict:
    expected_magic = frame_magic(protocol)
    if len(frame) != FRAME_BYTES or frame[:4] != expected_magic:
        if len(frame) == FRAME_BYTES and frame[:4] in (b"WCP1", b"WCF1"):
            raise FrameError("采集到另一个魔兽世界版本的传输码，请切换版本页面或调整采集坐标")
        raise FrameError(f"未找到 {protocol} 网格，请检查坐标、大小和游戏画面")
    length, expected_crc = struct.unpack_from("<HH", frame, 4)
    if not 1 <= length <= MAX_PAYLOAD:
        raise FrameError("遥测长度不合法")
    payload = frame[8:8 + length]
    if binascii.crc_hqx(payload, 0xFFFF) != expected_crc:
        raise FrameError("CRC 校验失败，等待下一完整帧")
    return validate_message(load_json(payload))


def decode_pixels(bgra: bytes, width: int, height: int, cell_size: int, protocol: str = "WCP1") -> dict:
    """Decode a top-down 32-bit BGRA crop, sampling cell centers."""
    if width != COLS * cell_size or height != ROWS * cell_size or len(bgra) != width * height * 4:
        raise FrameError("截图尺寸与网格配置不匹配")
    frame = bytearray(FRAME_BYTES)
    offset = cell_size // 2
    for i in range(COLS * ROWS):
        x, y = (i % COLS) * cell_size + offset, (i // COLS) * cell_size + offset
        position = (y * width + x) * 4
        b, g, r = bgra[position:position + 3]
        intensity = (r + g + b) // 3
        if 96 < intensity < 160:
            raise FrameError("网格像素模糊或被遮挡，请检查缩放、位置和 HDR")
        if intensity >= 160:
            frame[i // 8] |= 1 << (7 - i % 8)
    return decode_frame(bytes(frame), protocol)


def pixels_for_frame(frame: bytes, cell_size: int = 2) -> bytes:
    """Synthetic image for protocol tests. Never used as live game data."""
    rows = []
    for y in range(ROWS):
        row = bytearray()
        for x in range(COLS):
            i = y * COLS + x
            v = 255 if frame[i // 8] & (1 << (7 - i % 8)) else 0
            row.extend(bytes((v, v, v, 255)) * cell_size)
        rows.extend([bytes(row)] * cell_size)
    return b"".join(rows)
