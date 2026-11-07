"""Validate translated game prompts without depending on desktop language settings."""
import re
import unittest
from pathlib import Path

from test_addon import LuaRuntime, MOCK, ROOT


class LocalizationTest(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        self.load = self.lua.eval(b"function(source, ns) local f, err = loadstring(source); assert(f, err); return f('WoWMapCompanion', ns) end")

    def load_locale(self, locale):
        self.lua.globals().TestLocale = locale.encode()
        self.lua.execute(b"function GetLocale() return TestLocale end")
        ns = self.lua.table()
        self.load((ROOT / "Localization.lua").read_bytes(), ns)
        return ns[b"L"]

    def test_locale_dispatch_and_unsupported_locale_fallback(self):
        key = "确认换装".encode()
        expected = {"enUS": "Confirm equip", "zhCN": "确认换装", "zhTW": "確認換裝", "esES": "Equipar", "frFR": "Équiper", "itIT": "Equipaggia", "ptBR": "Equipar", "jaJP": "装備する", "koKR": "장착 확인", "ruRU": "Надеть"}
        for locale, label in expected.items():
            with self.subTest(locale=locale):
                self.assertEqual(self.load_locale(locale)(key).decode(), label)
        self.assertEqual(self.load_locale("unknown")(key), b"Confirm equip")
        self.assertEqual(self.load_locale("ptPT")(key), self.load_locale("ptBR")(key))
        self.assertEqual(self.load_locale("esMX")(key), self.load_locale("esES")(key))

    def test_every_translated_format_is_safe_for_lua_string_format(self):
        # Every quoted Chinese source key is an independently addressable message.
        source = (ROOT / "Localization.lua").read_text("utf-8")
        keys = re.findall(r'^    \["((?:[^"\\]|\\.)*)"\] = ', source, re.M)
        self.lua.execute(b"function FormatMessage(message) local args={} for token in message:gmatch('%%[-+ #0]*[%d$.]*[sdifq]') do args[#args+1]=token:sub(-1)=='s' and 'Item' or 12 end; return string.format(message,unpack(args)) end")
        import json
        for locale in ("enUS", "zhCN", "zhTW", "esES", "frFR", "itIT", "ptBR", "jaJP", "koKR", "ruRU"):
            translate = self.load_locale(locale)
            for escaped in set(keys):
                key = json.loads('"' + escaped + '"').encode()
                translated = translate(key)
                self.assertTrue(translated, (locale, key))
                original_spec = re.findall(rb'%[-+ #0]*[\d$.]*[sdifq]', key)
                self.assertEqual(re.findall(rb'%[-+ #0]*[\d$.]*[sdifq]', translated), original_spec, (locale, key))
                self.lua.globals().FormatMessage(translated)

    def test_real_addon_startup_uses_client_locale(self):
        self.lua.execute(MOCK)
        self.lua.execute(b"function GetLocale() return 'frFR' end")
        ns = self.lua.table()
        load = self.lua.eval(b"function(source, ns) local f, err=loadstring(source); assert(f,err); return f('WoWMapCompanion',ns) end")
        for line in (ROOT / "WoWMapCompanion.toc").read_text("utf-8").splitlines():
            if line.endswith('.lua'):
                load((ROOT / line).read_bytes(), ns)
        self.lua.globals().Fire(b"ADDON_LOADED", b"WoWMapCompanion")
        self.lua.globals().Fire(b"PLAYER_ENTERING_WORLD")
        self.lua.globals().SlashCmdList[b"WOWMAPCOMPANION"](b"equip on")
        messages = list(self.lua.globals().Messages.values())
        self.assertTrue(messages)
        self.assertIn(b"Compagnon WoW", messages[-1])
        self.assertNotIn("确认换装".encode(), messages[-1])

    def test_versions_share_one_display_catalog(self):
        forever = ROOT.parent / "WoWForeverCompanion" / "Localization.lua"
        self.assertEqual(forever.read_bytes(), (ROOT / "Localization.lua").read_bytes())


if __name__ == '__main__':
    unittest.main()
