import unittest
from pathlib import Path

import test_macro_import
from protocol import FrameError, decode_frame, encode_frame, validate_group_buff
from state import CompanionState
from test_bridge import snapshot


def frame(**changes):
    result = dict(v=1, kind="buff", s="test-session", g="Player-1-TEST", e=1, q=1, st="ready",
                  spell=6673, name="战斗怒吼", missing=1, checked=2, total=2, instanceType="party", instanceID=33)
    result.update(changes)
    return result


MOCK = b'''
clock=0; combat=false; inside=true; grouped=true; raid=false; known=true; class="WARRIOR"; spell=6673
scene="party"; instanceID=33; units={player={},party1={}}; count=2; hidden={}; disconnected={}; dead={}; far={}
secret={}; restricted=false
function issecretvalue(v) return v==secret end
function canaccesstable(t) return t~=secret end
function CreateFrame() listener={RegisterEvent=function() end,SetScript=function(self,_,fn) self.event=fn end}; return listener end
function GetTime() return clock end
function IsInInstance() return inside,scene end
function IsInGroup() return grouped end
function IsInRaid() return raid end
function GetNumGroupMembers() return count end
function GetInstanceInfo() return "Dungeon",scene,1,"Normal",5,false,false,instanceID end
function InCombatLockdown() return combat end
function UnitAffectingCombat() return combat end
function UnitClass() return "Class",class end
function UnitExists(u) return units[u]~=nil end
function UnitIsConnected(u) return not disconnected[u] end
function UnitIsDeadOrGhost(u) return not not dead[u] end
function UnitIsVisible(u) return not hidden[u] end
function UnitInRange(u) return not far[u],true end
function UnitGUID(u) return u end
C_SpellBook={IsSpellKnown=function(id) return known and id==spell end}
C_Spell={GetSpellName=function() return "Buff" end}
C_UnitAuras={GetAuraDataByIndex=function(u,i) if restricted then error("restricted") end return units[u][i] end}
ns={}
'''


class GroupBuffTests(unittest.TestCase):
    def test_protocol_validation_and_frame_budget(self):
        for magic in ("WCP1", "WCF1"):
            self.assertEqual(decode_frame(encode_frame(frame(), magic), magic), frame())
        for changes in ({"missing": 3}, {"total": 41}, {"q": True}, {"instanceType": "none"},
                        {"st": "inactive"}, {"spell": 123}, {"name": ""}, {"instanceID": 0}):
            with self.subTest(changes=changes), self.assertRaises(FrameError):
                validate_group_buff(frame(**changes))

    def test_bridge_freshness_identity_combat_and_scene(self):
        now = [0]
        state = CompanionState(clock=lambda: now[0])
        state.ingest(snapshot(instanceType="party", instanceID=33))
        state.ingest(frame(s="other"))
        self.assertIsNone(state.view()["groupBuff"])
        state.ingest(frame())
        self.assertEqual(state.view()["groupBuff"]["missing"], 1)
        now[0] = 7
        state.ingest(snapshot(tick=2, instanceType="party", instanceID=33))
        state.ingest(frame())
        self.assertIsNone(state.view()["groupBuff"])
        state.ingest(frame(q=2))
        self.assertIsNotNone(state.view()["groupBuff"])
        for changes in ({"combat": True}, {"dead": True}, {"online": False}, {"instanceID": 34}, {"instanceType": "none"}):
            state.ingest(snapshot(tick=3, instanceType="party", instanceID=33) | changes)
            self.assertIsNone(state.view()["groupBuff"])
        state.ingest(snapshot(tick=4, session="new", instanceType="party", instanceID=33))
        state.ingest(frame(q=3))
        self.assertIsNone(state.view()["groupBuff"])

    def lua(self, folder="WoWMapCompanion"):
        lua = test_macro_import.LuaRuntime(unpack_returned_tuples=True, encoding=None)
        lua.execute(MOCK)
        root = Path(__file__).resolve().parent.parent / folder
        for file in ("Protocol.lua", "GroupBuffs.lua"):
            lua.execute((root / file).read_bytes(), b"test", lua.globals().ns)
        lua.execute(b'ns.GroupBuffs.Initialize(); listener:event("PLAYER_ENTERING_WORLD")')
        return lua

    def ready(self, lua):
        lua.execute(b'ns.GroupBuffs.Next(); clock=6; ns.GroupBuffs.Next(); clock=9; result=ns.GroupBuffs.Next()')
        return lua.globals().result

    def test_both_addons_stabilize_and_clear_on_buff_gain(self):
        for folder in ("WoWMapCompanion", "WoWForeverCompanion"):
            lua = self.lua(folder)
            lua.execute(b'units.player={{spellId=6673}}')
            result = self.ready(lua)
            self.assertEqual(result[b"st"], b"ready")
            self.assertEqual(result[b"missing"], 1)
            lua.execute(b'units.party1={{spellId=6673}}; clock=10; result=ns.GroupBuffs.Next()')
            self.assertEqual(lua.globals().result[b"missing"], 0)
            self.assertNotEqual(lua.globals().result[b"st"], b"ready")

    def test_secret_remote_dead_unknown_and_missing_api_never_mean_missing(self):
        for setup in (b'hidden.party1=true', b'disconnected.party1=true', b'dead.party1=true', b'far.party1=true',
                      b'units.party1={{spellId=secret}}', b'units.party1={secret}', b'restricted=true',
                      b'C_UnitAuras=nil', b'known=false', b'combat=true', b'grouped=false', b'inside=false'):
            lua = self.lua()
            lua.execute(b'units.player={{spellId=6673}}; ' + setup)
            with self.subTest(setup=setup):
                self.assertNotEqual(self.ready(lua)[b"st"], b"ready")

    def test_classes_raid_battleground_and_bronze_recipient_aura(self):
        for class_name, spell in (("WARRIOR", 6673), ("MAGE", 1459), ("PRIEST", 21562),
                                  ("DRUID", 1126), ("SHAMAN", 462854), ("EVOKER", 364342)):
            lua = self.lua()
            lua.execute(f'class="{class_name}"; spell={spell}; scene="pvp"; raid=true; units={{raid1={{}},raid2={{}}}}'.encode())
            self.assertEqual(self.ready(lua)[b"spell"], spell)
            self.assertEqual(lua.globals().result[b"missing"], 2)
        lua.execute(b'units.raid1={{spellId=381748,name="Buff"}}; units.raid2={{spellId=381732,name="Buff"}}; clock=10; result=ns.GroupBuffs.Next()')
        self.assertEqual(lua.globals().result[b"missing"], 0)

    def test_reentry_and_member_changes_require_new_observations(self):
        lua = self.lua()
        first = self.ready(lua)[b"e"]
        lua.execute(b'clock=10; listener:event("PLAYER_LEAVING_WORLD"); result=ns.GroupBuffs.Next()')
        self.assertEqual(lua.globals().result[b"st"], b"inactive")
        lua.execute(b'listener:event("PLAYER_ENTERING_WORLD"); result=ns.GroupBuffs.Next()')
        self.assertGreater(lua.globals().result[b"e"], first)
        self.assertEqual(lua.globals().result[b"st"], b"waiting")
        lua.execute(b'clock=16; ns.GroupBuffs.Next(); units.party1={{spellId=6673}}; clock=19; result=ns.GroupBuffs.Next()')
        self.assertEqual(lua.globals().result[b"st"], b"waiting")

    def test_lua_transfer_roundtrip_preserves_state_slots(self):
        for folder, magic in (("WoWMapCompanion", "WCP1"), ("WoWForeverCompanion", "WCF1")):
            lua = self.lua(folder)
            self.ready(lua)
            root = Path(__file__).resolve().parent.parent / folder
            lua.execute((root / "Transfer.lua").read_bytes(), b"test", lua.globals().ns)
            lua.execute(b'ns.Transfer.SetMacroState({session="test-session",guid="Player-1-TEST"})')
            received = []
            for step in range(32):
                lua.execute(b'clock=clock+0.25; ns.Transfer.Advance(); result=ns.Transfer.Current("state")')
                payload = lua.globals().result
                if step % 2 == 1:
                    self.assertEqual(payload, b"state")
                if payload != b"state":
                    received.append(decode_frame(payload, magic))
            self.assertTrue(any(value["st"] == "ready" for value in received))
            self.assertTrue(all(value["kind"] == "buff" for value in received))


if __name__ == "__main__":
    unittest.main()
