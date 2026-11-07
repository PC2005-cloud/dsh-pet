"""Real Lua import validation, pixel receipts, and bounded desktop input sequences."""
import copy
from pathlib import Path
import sys
import unittest

from macro_import import ImportFailure, MacroImporter, body_hash, normalize
from protocol import FrameError, decode_frame, encode_frame
from state import CompanionState
from test_bridge import snapshot

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "WoWMapCompanion" / "tests" / ".deps"))
from lupa.lua51 import LuaRuntime


def receipt(**changes):
    value = {"v": 1, "kind": "macro", "s": "test-session", "g": "Player-1-TEST", "q": 1,
             "id": "", "st": "idle", "r": "", "hash": 5381, "bytes": 0,
             "focus": False, "input": False, "chat": False, "combat": False}
    value.update(changes)
    return value


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.now = 100
        self.state = CompanionState(clock=lambda: self.now)
        self.state.ingest(snapshot())

    def test_both_protocols_and_invalid_values(self):
        for magic in ("WCP1", "WCF1"):
            self.assertEqual(decode_frame(encode_frame(receipt(), magic), magic), receipt())
        for changes in ({"q": True}, {"bytes": -1}, {"hash": 2**32}, {"id": "bad"}, {"focus": "yes"},
                        {"focus": True}, {"focus": True, "input": True, "chat": True}, {"st": "executed"}):
            with self.subTest(changes=changes), self.assertRaises(FrameError):
                encode_frame(receipt(**changes))

    def test_frozen_frame_does_not_refresh_receipt_or_heartbeat(self):
        self.state.ingest(receipt())
        self.assertIsNotNone(self.state.view()["macroImport"])
        self.now += 3
        self.state.ingest(receipt())
        self.assertIsNone(self.state.view()["macroImport"])
        self.state.ingest(receipt(q=2))
        self.assertIsNotNone(self.state.view()["macroImport"])
        self.now += 3
        self.state.ingest(receipt(q=3))
        self.assertEqual(self.state.view()["status"], "stale")
        self.assertIsNone(self.state.view()["macroImport"])

    def test_foreign_session_and_role_switch(self):
        self.state.ingest(receipt(s="other"))
        self.assertIsNone(self.state.view()["macroImport"])
        self.state.ingest(receipt())
        self.state.ingest(snapshot(session="next", tick=2))
        self.assertIsNone(self.state.view()["macroImport"])
        self.state.ingest(receipt(q=2))
        self.assertIsNone(self.state.view()["macroImport"])

    def test_pause_and_capture_error_hide_receipts(self):
        self.state.ingest(receipt())
        self.state.error = "capture failed"
        self.assertIsNone(self.state.view()["macroImport"])
        self.state.error = None
        self.state.config["paused"] = True
        self.assertIsNone(self.state.view()["macroImport"])


LUA_MOCK = b'''
combat=false; slots={}; count=0; MAX_ACCOUNT_MACROS=120; MAX_CHARACTER_MACROS=18
SLASH_TARGET_EXACT1="/targetexact"; SLASH_CAST1="/cast"; SLASH_SCRIPT1="/run"; SLASH_SCRIPT2="/script"
SlashCmdList={}; UISpecialFrames={}; focused=nil; frameObjects={}
C_Timer={After=function(_, callback) callback() end}
function GetLocale() return "zhCN" end
function InCombatLockdown() return combat end
function UnitAffectingCombat() return combat end
function GetCurrentKeyBoardFocus() return focused end
function IsControlKeyDown() return control end
function GetNumMacros() return 0,count end
function GetMacroInfo(i) if slots[i] then return slots[i].name,134400,slots[i].body end end
function GetMacroBody(i) return slots[i] and slots[i].body end
function CreateMacro(name, icon, body, character)
  assert(character==true); count=count+1; slots[120+count]={name=name,body=body}; return 120+count
end
function EditMacro(i,name,icon,body) slots[i]={name=name,body=body}; return i end
local methods={}
function methods:SetScript(event,fn) self.scripts[event]=fn end
function methods:SetText(text) self.text=text; if self.scripts.OnTextChanged then self.scripts.OnTextChanged(self) end end
function methods:GetText() return self.text or "" end
function methods:Insert(text) self:SetText(self:GetText() .. text) end
function methods:GetName() return self.name end
function methods:Show() self.shown=true end
function methods:IsShown() return self.shown==true end
function methods:Hide() self.shown=false; if self.scripts.OnHide then self.scripts.OnHide(self) end end
function methods:SetFocus() focused=self end
function methods:ClearFocus() if focused==self then focused=nil end end
function methods:CreateFontString() return CreateFrame("FontString") end
setmetatable(methods,{__index=function() return function() end end})
function CreateFrame(kind,name)
  local f=setmetatable({name=name,scripts={}}, {__index=methods})
  if name then frameObjects[name]=f end
  if kind=="Frame" then f.TitleText=CreateFrame("FontString") end
  return f
end
UIParent=CreateFrame("Frame")
'''


class LuaTests(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        self.lua.execute(LUA_MOCK)
        self.lua.execute((ROOT / "WoWMacroImport" / "MacroImport.lua").read_bytes(), b"WoWMacroImport")
        self.api = self.lua.globals().WoWCompanionMacroImport

    def test_validation_and_utf8_hash(self):
        body = "/targetexact 测试 NPC".encode()
        self.assertEqual(self.api.Validate(body), body)
        self.assertEqual(self.api.Hash(body), body_hash(body.decode()))
        for text, code in ((b"", b"empty"), (b"hello", b"command"), (b"/unknown x", b"command"),
                           (b"/run local =", b"lua"), (b"/cast " + b"x" * 250, b"length"),
                           (b"/cast x\0y", b"control"), (b"#showtooltip", b"empty")):
            self.assertEqual(self.api.Validate(text), (None, code))
        self.assertEqual(self.api.Validate(b"/run error('never executed')"), b"/run error('never executed')")

    def test_create_update_and_do_not_overwrite_user_edits(self):
        self.assertTrue(self.api.Import(b"/cast Test"))
        self.assertEqual(self.lua.globals().GetMacroBody(121), b"/cast Test")
        self.assertTrue(self.api.Import(b"/targetexact NPC"))
        self.assertEqual(self.lua.globals().count, 1)
        self.lua.globals().slots[121][b"body"] = b"/cast UserEdit"
        self.assertEqual(self.api.Import(b"/cast New"), (False, b"conflict"))
        self.assertEqual(self.lua.globals().GetMacroBody(121), b"/cast UserEdit")

    def test_combat_slots_and_nonowned_name(self):
        self.lua.globals().combat = True
        self.assertEqual(self.api.Import(b"/cast Test"), (False, b"combat"))
        self.lua.globals().combat = False
        self.lua.globals().count = 18
        self.assertEqual(self.api.Import(b"/cast Test"), (False, b"full"))
        self.lua.globals().count = 0
        self.lua.globals().CreateMacro(b"WCP Import", 134400, b"/cast Test", True)
        self.assertEqual(self.api.Import(b"/cast New"), (False, b"conflict"))

    def test_ui_command_paste_submit_and_close_receipts(self):
        self.api.Open(b"a" * 32)
        ready = self.api.Telemetry()
        self.assertEqual(ready[b"st"], b"ready")
        self.assertTrue(ready[b"focus"])
        edit = self.lua.globals().frameObjects[b"WoWMacroImportEditBox"]
        edit.SetText(edit, b"/targetexact NPC")
        self.assertEqual(self.api.Telemetry()[b"st"], b"edited")
        self.lua.globals().control = True
        edit.scripts[b"OnEnterPressed"](edit)
        self.assertEqual(self.api.Telemetry()[b"st"], b"saved")
        self.assertFalse(self.api.Telemetry()[b"focus"])
        edit.scripts[b"OnEscapePressed"](edit)
        self.assertEqual(self.api.Telemetry()[b"st"], b"closed")

    def test_enter_adds_newline_without_saving(self):
        self.api.Open(b"")
        edit = self.lua.globals().frameObjects[b"WoWMacroImportEditBox"]
        edit.SetText(edit, b"#showtooltip")
        edit.scripts[b"OnEnterPressed"](edit)
        self.assertEqual(edit.GetText(edit), b"#showtooltip\n")
        self.assertEqual(self.lua.globals().count, 0)

    def test_actual_lua_frames_decode_for_both_games(self):
        for folder, magic in (("WoWMapCompanion", "WCP1"), ("WoWForeverCompanion", "WCF1")):
            ns = self.lua.table()
            self.lua.execute((ROOT / folder / "Protocol.lua").read_bytes(), folder.encode(), ns)
            self.lua.execute((ROOT / folder / "Transfer.lua").read_bytes(), folder.encode(), ns)
            ns.Transfer.SetMacroState(self.lua.table_from({b"session": b"test-session", b"guid": b"Player-1-TEST"}))
            self.lua.execute(b"function GetTime() return 10 end")
            for _ in range(3):
                ns.Transfer.Advance()
            data = ns.Transfer.Current(b"state")
            value = decode_frame(data, magic)
            self.assertEqual(value["kind"], "macro")
            self.assertEqual(value["g"], "Player-1-TEST")
            self.assertEqual(len(data), 512)


class FakeNative:
    def __init__(self):
        self.actions = []
        self.receipt = receipt()
        self.snapshot = snapshot()
        self.now = 100
        self.cancel = False
        self.focus = True
        self.on_read = None

    def check(self):
        if not self.focus:
            raise ImportFailure("focus-lost")

    def activate(self):
        self.actions.append("activate")

    def copy(self, text):
        self.body = text
        self.actions.append("copy")

    def press(self, action):
        self.actions.append(action)
        if action == "enter":
            self.receipt.update(input=True, chat=True)
        elif action == "paste":
            self.receipt.update(st="edited", hash=body_hash(self.body), bytes=len(self.body.encode()))
        elif action == "save":
            self.receipt.update(st="saved", r="saved", focus=False, input=False)

    def command(self, text):
        self.actions.append("command")
        self.receipt.update(id=text.split()[1], st="ready", focus=True, input=True, chat=False)

    def read(self):
        self.receipt["q"] += 1
        if self.on_read:
            self.on_read()
        return {"instanceId": "bridge-test", "status": "live", "source": "screen", "game": "retail",
                "ageSeconds": 0, "snapshot": copy.deepcopy(self.snapshot), "macroImport": copy.deepcopy(self.receipt)}

    def sleep(self, delay):
        self.now += delay


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.native = FakeNative()
        self.runner = MacroImporter(self.native.read, self.native, lambda: self.native.cancel,
                                    lambda: self.native.now, self.native.sleep)

    def run_import(self):
        return self.runner.run("/targetexact 测试", "retail")

    def test_success_requires_saved_receipt(self):
        result = self.run_import()
        self.assertTrue(result["ok"])
        self.assertEqual(self.native.actions, ["copy", "activate", "enter", "command", "copy", "paste", "save"])

    def test_combat_wait_has_no_keys_until_end(self):
        self.native.snapshot["combat"] = True
        def read():
            if self.native.now < 100.5:
                self.assertEqual(self.native.actions, ["copy", "activate"])
            else:
                self.native.snapshot["combat"] = False
        self.native.on_read = read
        self.assertTrue(self.run_import()["ok"])

    def test_combat_during_paste_cancels_before_save(self):
        def read():
            if "paste" in self.native.actions:
                self.native.snapshot["combat"] = True
        self.native.on_read = read
        with self.assertRaisesRegex(ImportFailure, "combat-started"):
            self.run_import()
        self.assertNotIn("save", self.native.actions)

    def test_wrong_clipboard_content_is_not_saved(self):
        def read():
            if "paste" in self.native.actions:
                self.native.receipt["hash"] = 1
        self.native.on_read = read
        with self.assertRaisesRegex(ImportFailure, "content-mismatch"):
            self.run_import()
        self.assertNotIn("save", self.native.actions)

    def test_missing_receipt_does_not_repeat_input(self):
        def read():
            if "command" in self.native.actions:
                self.native.receipt["id"] = ""
        self.native.on_read = read
        with self.assertRaisesRegex(ImportFailure, "receipt-timeout"):
            self.run_import()
        self.assertEqual(self.native.actions.count("command"), 1)
        self.assertNotIn("paste", self.native.actions)

    def test_character_switch_cancels(self):
        def read():
            if "enter" in self.native.actions:
                self.native.snapshot["session"] = "other"
        self.native.on_read = read
        with self.assertRaisesRegex(ImportFailure, "character-changed"):
            self.run_import()
        self.assertNotIn("command", self.native.actions)

    def test_initial_focus_timeout_has_no_keys(self):
        self.native.focus = False
        with self.assertRaisesRegex(ImportFailure, "focus-not-acquired"):
            self.run_import()
        self.assertNotIn("enter", self.native.actions)

    def test_delayed_initial_activation_waits_without_typing(self):
        self.native.focus = False
        def sleep(delay):
            self.assertNotIn("enter", self.native.actions)
            self.native.now += delay
            if self.native.now >= 100.5:
                self.native.focus = True
        self.runner.sleep = sleep
        self.assertTrue(self.run_import()["ok"])
        self.assertEqual(self.native.actions.count("activate"), 1)
        self.assertEqual(self.native.actions.count("paste"), 1)

    def test_focus_lost_after_first_key_never_reactivates_or_pastes(self):
        def read():
            if "enter" in self.native.actions:
                self.native.focus = False
        self.native.on_read = read
        with self.assertRaisesRegex(ImportFailure, "focus-lost"):
            self.run_import()
        self.assertEqual(self.native.actions.count("activate"), 1)
        self.assertNotIn("command", self.native.actions)
        self.assertNotIn("paste", self.native.actions)

    def test_brief_focus_does_not_start_typing(self):
        self.native.focus = False
        def sleep(delay):
            self.assertNotIn("enter", self.native.actions)
            self.native.now += delay
            elapsed = self.native.now - 100
            self.native.focus = 0.1 <= elapsed < 0.2 or elapsed >= 0.6
        self.runner.sleep = sleep
        self.assertTrue(self.run_import()["ok"])
        self.assertGreaterEqual(self.native.now, 100.85)
        self.assertEqual(self.native.actions.count("activate"), 1)

    def test_cancellation_while_waiting_for_focus_has_no_keys(self):
        self.native.focus = False
        def sleep(delay):
            self.native.now += delay
            self.native.cancel = True
        self.runner.sleep = sleep
        with self.assertRaisesRegex(ImportFailure, "cancelled"):
            self.run_import()
        self.assertNotIn("enter", self.native.actions)

    def test_window_identity_failure_is_not_retried_as_focus_loss(self):
        def check():
            raise ImportFailure("window-changed")
        self.native.check = check
        with self.assertRaisesRegex(ImportFailure, "window-changed"):
            self.run_import()
        self.assertNotIn("enter", self.native.actions)

    def test_activation_denial_does_not_abort_before_the_workflow_can_wait(self):
        from macro_native import WindowsMacroInput
        from types import SimpleNamespace
        native = WindowsMacroInput.__new__(WindowsMacroInput)
        checks = []
        native.check = lambda foreground=True: checks.append(foreground)
        native.handle = 123
        native.user = SimpleNamespace(SetForegroundWindow=lambda handle: False)
        native.activate()
        self.assertEqual(checks, [False])

    def test_stale_demo_dead_paused_and_missing_addon(self):
        for changes in ({"status": "stale"}, {"source": "demo"}, {"macroImport": None},
                        {"status": "paused"}, {"ageSeconds": 3}, {"snapshot": snapshot(dead=True)}):
            with self.subTest(changes=changes):
                native = FakeNative()
                runner = MacroImporter(lambda: native.read() | changes, native, lambda: False)
                with self.assertRaisesRegex(ImportFailure, "telemetry-unavailable"):
                    runner.run("/cast Test", "retail")
                self.assertNotIn("enter", native.actions)

    def test_cancellation_and_busy_input(self):
        self.native.cancel = True
        with self.assertRaisesRegex(ImportFailure, "cancelled"):
            self.run_import()
        self.native.cancel = False
        self.native.receipt["input"] = True
        with self.assertRaisesRegex(ImportFailure, "input-busy"):
            self.run_import()
        self.assertNotIn("enter", self.native.actions)

    def test_normalization_does_not_strip_macro_commands(self):
        self.assertEqual(normalize("\r\n/targetexact 测试\r\n"), "/targetexact 测试")
        for value in ("```macro\n/cast Test\n```", "/cast " + "测" * 100, "/cast a\x00"):
            with self.assertRaises(ImportFailure):
                normalize(value)


if __name__ == "__main__":
    unittest.main()
