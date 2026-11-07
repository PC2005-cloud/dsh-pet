"""Compare real Lua item captures and preserve the game-click execution boundary."""
import binascii
import json
import struct
import unittest
import copy

from test_addon import ROOT
import test_confirm_equip


class EquipmentCompareTest(unittest.TestCase):
    def setUp(self):
        self.h = test_confirm_equip.ConfirmEquipTest()
        self.h.setUp()
        self.g, self.ns, self.lua = self.h.g, self.h.ns, self.h.lua

    def table(self, value):
        if isinstance(value, dict):
            return self.lua.table_from({key.encode(): self.table(item) for key, item in value.items()})
        if isinstance(value, list):
            return self.lua.table_from([self.table(item) for item in value])
        return value.encode() if isinstance(value, str) else value

    def add(self, stats=None, kind="INVTYPE_CHEST", level=150, lines=None):
        self.g.New = self.g.NewItem(12345, b"comparison-new", b"New item")
        self.g.New[b"level"] = level
        self.g.New[b"kind"] = kind.encode()
        if stats is not None:
            self.g.New[b"compareStats"] = self.table(stats)
        if lines is not None:
            self.g.New[b"lines"] = self.table([{"leftText": line} for line in lines])
        self.g.Bags[0][2] = self.g.New
        self.ns[b"Equipment"][b"Scan"]()

    def comparison(self):
        value, assessment = self.ns[b"EquipmentCompare"][b"Capture"](self.g.Owner, self.g.Records[1])
        return value, json.loads(self.ns[b"Transfer"][b"ComparisonJSON"](value)), assessment

    def decision(self):
        _, _, assessment = self.comparison()
        return assessment[b"verdict"].decode(), assessment[b"reason"].decode()

    def test_plain_same_type_stat_upgrade_publishes_two_items_and_waits_for_click(self):
        self.g.SetupOld(5, 100, b"Old chest", 100)
        self.add()
        _, body, _ = self.comparison()
        self.assertEqual(self.decision(), ("upgrade", "stats_upgrade"))
        self.assertEqual(body["current"]["itemID"], 100)
        self.assertEqual(body["candidate"]["itemID"], 12345)
        self.assertEqual(body["primary"], 4)
        self.assertTrue(body["current"]["complete"])
        self.assertEqual(len(self.g.Actions), 0)
        self.assertIsNotNone(self.g.Visible)
        self.g.AcceptPopup()
        self.assertEqual(self.h.result()["st"], "equipped")

    def test_equal_item_level_can_improve_actual_stats(self):
        old = self.g.SetupOld(5, 100, b"Old chest", 150)
        old[b"compareStats"] = self.table({"ITEM_MOD_INTELLECT_SHORT": 100, "ITEM_MOD_HASTE_RATING_SHORT": 42})
        self.add(stats={"ITEM_MOD_INTELLECT_SHORT": 101, "ITEM_MOD_HASTE_RATING_SHORT": 42})
        self.assertEqual(self.decision(), ("upgrade", "stats_upgrade"))
        self.assertEqual(self.h.offer()["il"], self.h.offer()["ol"])
        self.assertIsNotNone(self.g.Visible)

    def test_higher_item_level_without_better_stats_never_prompts(self):
        old = self.g.SetupOld(5, 100, b"Old chest", 100)
        stats = {"ITEM_MOD_INTELLECT_SHORT": 100, "ITEM_MOD_HASTE_RATING_SHORT": 42}
        old[b"compareStats"] = self.table(stats)
        self.add(stats=stats)
        self.assertEqual(self.decision(), ("not_upgrade", "equivalent"))
        self.assertIsNone(self.g.Visible)

    def test_primary_upgrade_with_secondary_tradeoff_asks_without_claiming_certain_gain(self):
        self.g.SetupOld(5, 100, b"Old chest", 100)
        self.add(stats={"ITEM_MOD_INTELLECT_SHORT": 150, "ITEM_MOD_HASTE_RATING_SHORT": 20})
        self.assertEqual(self.decision(), ("review", "primary_upgrade_tradeoff"))
        self.assertIn("综合收益未确定", self.g.Visible[b"text"].decode())
        self.assertIn("急速 42→20", self.g.Visible[b"text"].decode())
        self.assertEqual(len(self.g.Actions), 0)

    def test_actual_plate_legs_tradeoff_lists_both_directions_and_waits_for_click(self):
        self.lua.execute(b'Model.class="PALADIN"; Model.spec=70; Owner.class="PALADIN"; Owner.spec=70; Model.level=84; function GetSpecializationInfo() return Model.spec,"Spec",nil,123,"DAMAGER",1 end')
        old=self.g.SetupOld(7,237993,"虚痕队长护胫".encode(),134,b"INVTYPE_LEGS")
        old[b"itemType"],old[b"subtype"]="护甲".encode(),"板甲".encode()
        old[b"compareStats"]=self.table({"ITEM_MOD_STRENGTH_SHORT":29,"ITEM_MOD_STAMINA_SHORT":244,"RESISTANCE0_NAME":69,"ITEM_MOD_CRIT_RATING_SHORT":20,"ITEM_MOD_MASTERY_RATING_SHORT":37})
        old[b"hyperlinkLines"]=self.table([{"leftText":"虚痕队长护胫"},{"type":20,"leftText":"拾取后绑定"},{"type":21,"leftText":"腿部","rightText":"板甲"}])
        self.g.New=self.g.NewItem(257002,b"new-steel-legs","钢皮腿铠".encode())
        new=self.g.New
        new[b"kind"],new[b"level"],new[b"requiredLevel"]=b"INVTYPE_LEGS",158,84
        new[b"itemType"],new[b"subtype"]="护甲".encode(),"板甲".encode()
        new[b"compareStats"]=self.table({"ITEM_MOD_STRENGTH_SHORT":37,"ITEM_MOD_STAMINA_SHORT":402,"RESISTANCE0_NAME":92,"ITEM_MOD_CRIT_RATING_SHORT":36,"ITEM_MOD_MASTERY_RATING_SHORT":30})
        new[b"bagLines"]=self.table([{"leftText":"钢皮腿铠"},{"leftText":"灵魂绑定"},{"leftText":"腿部","rightText":"板甲"}])
        self.g.Bags[0][2]=new
        self.ns[b"Equipment"][b"Scan"]()
        self.assertEqual(self.decision(),("review","primary_upgrade_tradeoff"))
        self.assertEqual(self.h.offer()["item"],257002)
        text=self.g.Visible[b"text"].decode()
        self.assertIn("力量 29→37",text)
        self.assertIn("精通 37→30",text)
        self.assertIn("综合收益未确定",text)
        self.assertEqual(len(self.g.Actions),0)
        self.g.AcceptPopup()
        self.assertEqual(self.h.result()["st"],"equipped")

    def test_tradeoff_does_not_allow_loss_of_stamina_armor_damage_or_other_core_stats(self):
        for key in ["ITEM_MOD_STAMINA_SHORT","RESISTANCE0_NAME","ITEM_MOD_DAMAGE_PER_SECOND_SHORT","ITEM_MOD_ATTACK_POWER_SHORT","ITEM_MOD_SPELL_POWER_SHORT"]:
            with self.subTest(key=key):
                self.setUp()
                old=self.g.SetupOld(5,100,b"Old chest",100)
                old[b"compareStats"]=self.table({"ITEM_MOD_INTELLECT_SHORT":100,key:50})
                self.add(stats={"ITEM_MOD_INTELLECT_SHORT":150,key:40})
                self.assertEqual(self.decision(),("review","stat_tradeoff"))
                self.assertIsNone(self.g.Visible)
                self.assertEqual(len(self.g.Actions),0)

    def test_tradeoff_requires_higher_item_level_and_selected_primary_stat(self):
        for level,primary in [(100,150),(150,100),(99,160)]:
            with self.subTest(level=level,primary=primary):
                self.setUp()
                self.g.SetupOld(5,100,b"Old chest",100)
                self.add(level=level,stats={"ITEM_MOD_INTELLECT_SHORT":primary,"ITEM_MOD_HASTE_RATING_SHORT":20,"ITEM_MOD_CRIT_RATING_SHORT":5})
                self.assertEqual(self.decision(),("review","stat_tradeoff"))
                self.assertIsNone(self.g.Visible)

    def test_manual_bag_review_reuses_current_facts_without_faking_acquisition_history(self):
        self.g.SetupOld(5,100,b"Old chest",100)
        self.g.New=self.g.NewItem(12345,b"baseline-equipment",b"New item")
        self.g.New[b"level"]=150
        self.g.Bags[0][2]=self.g.New
        self.lua.execute(b'NS.Equipment.Initialize(Owner,function(record) Records[#Records+1]=record; NS.Transfer.Add(record); NS.ConfirmEquip.Add(record) end); NS.Equipment.EnterWorld(); AdvanceTime(2)')
        self.assertEqual(len(self.g.Records),0)
        self.ns[b"ConfirmEquip"][b"Command"](b"check 12345")
        self.assertEqual(len(self.g.Records),0)
        self.assertIsNotNone(self.g.Visible)
        self.assertEqual(self.h.offer()["id"],1)
        self.assertEqual(len(self.g.Actions),0)
        self.g.CancelPopup(b"clicked",False)
        self.g.Other=self.g.NewItem(555,b"new-real-acquisition",b"Another item")
        self.g.Other[b"level"]=160
        self.g.Bags[0][3]=self.g.Other
        self.ns[b"Equipment"][b"Scan"]()
        self.assertEqual(len(self.g.Records),1)
        self.assertEqual(self.g.Records[1][b"id"],2)
        self.assertEqual(self.g.Records[1][b"itemID"],555)

    def test_manual_review_skips_unready_and_complex_equipment(self):
        self.g.New=self.g.NewItem(12345,b"review-item",b"New item")
        self.g.Bags[0][2]=self.g.New
        self.g.New[b"noTooltip"]=True
        accepted,unready=self.ns[b"Equipment"][b"Review"](self.ns[b"ConfirmEquip"][b"Add"])
        self.assertEqual((accepted,unready),(0,1))
        self.assertIsNone(self.g.Visible)
        self.assertEqual(len(self.g.Records),0)
        self.g.New[b"noTooltip"]=False
        self.g.New[b"lines"]=self.table([{"leftText":"Use: unknown effect"}])
        accepted,unready=self.ns[b"Equipment"][b"Review"](self.ns[b"ConfirmEquip"][b"Add"])
        self.assertEqual((accepted,unready),(0,0))
        self.assertIsNone(self.g.Visible)

    def test_weaker_stats_and_lower_item_level_do_not_claim_an_upgrade(self):
        self.g.SetupOld(5, 100, b"Old chest", 100)
        self.add(stats={"ITEM_MOD_INTELLECT_SHORT": 90, "ITEM_MOD_HASTE_RATING_SHORT": 40})
        self.assertEqual(self.decision(), ("not_upgrade", "weaker_stats"))
        self.setUp()
        self.g.SetupOld(5, 100, b"Old chest", 160)
        self.add(stats={"ITEM_MOD_INTELLECT_SHORT": 200, "ITEM_MOD_HASTE_RATING_SHORT": 50})
        self.assertEqual(self.decision(), ("review", "stat_tradeoff"))
        self.assertIsNone(self.g.Visible)

    def test_plain_empty_slot_is_an_upgrade_but_complex_empty_slot_needs_review(self):
        self.add()
        self.assertEqual(self.decision(), ("upgrade", "empty_slot"))
        self.setUp()
        self.add(lines=["New item", "装备：攻击有几率提高急速。"])
        self.assertEqual(self.decision(), ("review", "complex_item"))
        self.assertIsNone(self.g.Visible)

    def test_sets_enchants_sockets_trinkets_and_unrecognized_tooltip_text_require_review(self):
        for text in ["(2) 套装：提高伤害。", "附魔：力量 +10", "黄色插槽", "Use: Deal 500 damage", "Unbekannter Effekt"]:
            with self.subTest(text=text):
                self.setUp()
                self.add(lines=["New item", text])
                self.assertEqual(self.decision(), ("review", "complex_item"))
                self.assertIsNone(self.g.Visible)
        self.setUp()
        self.add(kind="INVTYPE_TRINKET")
        self.assertEqual(self.decision(), ("review", "complex_item"))

    def test_unknown_spec_and_api_failure_never_promote_a_candidate(self):
        self.lua.execute(b'C_Item.GetItemSpecInfo=nil')
        self.add()
        self.assertEqual(self.decision(), ("review", "unknown_spec"))
        self.assertIsNone(self.g.Visible)
        self.setUp()
        self.lua.execute(b'GetSpecializationInfo=function() return Secret,nil,nil,nil,nil,Secret end')
        self.add()
        self.assertEqual(self.decision(), ("review", "unknown_spec"))
        self.assertIsNone(self.g.Visible)

    def test_wrong_spec_and_unusable_items_are_rejected(self):
        self.lua.execute(b'C_Item.GetItemSpecInfo=function() return {999} end')
        self.add()
        self.assertEqual(self.decision(), ("not_upgrade", "wrong_spec"))
        self.setUp()
        self.add()
        self.g.New[b"equippable"] = False
        self.assertEqual(self.decision(), ("not_upgrade", "unusable"))

    def test_actual_passive_plate_boots_produce_offer_and_only_equip_after_game_click(self):
        self.lua.execute(b'Model.class="PALADIN"; Model.spec=70; Owner.class="PALADIN"; Owner.spec=70; function GetSpecializationInfo() return Model.spec,"Spec",nil,123,"DAMAGER",1 end')
        old = self.g.SetupOld(8, 272256, "誓言使者战靴".encode(), 133, b"INVTYPE_FEET")
        old[b"itemType"], old[b"subtype"] = "护甲".encode(), "板甲".encode()
        old[b"compareStats"] = self.table({"ITEM_MOD_STRENGTH_SHORT":22,"ITEM_MOD_STAMINA_SHORT":178,"RESISTANCE0_NAME":49,"ITEM_MOD_CRIT_RATING_SHORT":25,"ITEM_MOD_HASTE_RATING_SHORT":17})
        old[b"lines"] = self.table([{"leftText":line} for line in ["誓言使者战靴", "物品等级 133", "灵魂绑定", "脚部", "板甲", "49点护甲", "+22 力量", "+178 耐力", "+25 爆击", "+17 急速", "耐久度 80 / 80", "需要等级 80"]])
        self.g.New = self.g.NewItem(237917, b"blood-tempered-boots", "淬血胫甲".encode())
        new = self.g.New
        new[b"kind"], new[b"level"], new[b"usable"] = b"INVTYPE_FEET", 174, False
        new[b"itemType"], new[b"subtype"] = "护甲".encode(), "板甲".encode()
        new[b"compareStats"] = self.table({"ITEM_MOD_STRENGTH_SHORT":32,"ITEM_MOD_STAMINA_SHORT":401,"RESISTANCE0_NAME":83,"ITEM_MOD_CRIT_RATING_SHORT":27,"ITEM_MOD_HASTE_RATING_SHORT":27})
        new[b"lines"] = self.table([{"leftText":line} for line in ["淬血胫甲", "物品等级 174", "灵魂绑定", "脚部", "板甲", "83点护甲", "+32 力量", "+401 耐力", "+27 爆击", "+27 急速", "品质：|A:Professions-ChatIcon-Quality-Tier3:17:17|a", "<由制甲师制造>", "耐久度 80 / 80", "需要等级 80"]])
        self.g.Bags[0][2] = new
        self.ns[b"Equipment"][b"Scan"]()
        _, body, _ = self.comparison()
        self.assertTrue(body["usable"])
        self.assertFalse(body["candidate"]["complex"])
        self.assertFalse(body["current"]["complex"])
        self.assertEqual(self.decision(), ("upgrade", "stats_upgrade"))
        self.assertEqual(self.h.offer()["item"], 237917)
        self.assertEqual(self.h.offer()["old"], 272256)
        self.assertIsNotNone(self.g.Visible)
        self.assertEqual(len(self.g.Actions), 0)
        self.g.AcceptPopup()
        self.assertEqual(self.g.Inventory[8][b"guid"], b"blood-tempered-boots")
        self.assertEqual(self.h.result()["st"], "equipped")

    def test_item_use_api_is_not_required_for_passive_equipment(self):
        self.lua.execute(b'C_Item.IsUsableItem=function() error("item-use API must not gate equipping") end')
        self.add()
        self.assertEqual(self.decision(), ("upgrade", "empty_slot"))
        self.assertIsNotNone(self.g.Visible)
        self.g.AcceptPopup()
        self.assertEqual(self.h.result()["st"], "equipped")

    def test_real_bop_hyperlink_and_soulbound_bag_paths_offer_the_actual_plate_boot_upgrade(self):
        self.lua.execute(b'Model.class="PALADIN"; Model.spec=70; Owner.class="PALADIN"; Owner.spec=70; function GetSpecializationInfo() return Model.spec,"Spec",nil,123,"DAMAGER",1 end')
        old = self.g.SetupOld(8, 272256, "誓言使者战靴".encode(), 133, b"INVTYPE_FEET")
        old[b"itemType"], old[b"subtype"] = "护甲".encode(), "板甲".encode()
        old[b"compareStats"] = self.table({"ITEM_MOD_STRENGTH_SHORT":22,"ITEM_MOD_STAMINA_SHORT":178,"RESISTANCE0_NAME":49,"ITEM_MOD_CRIT_RATING_SHORT":25,"ITEM_MOD_HASTE_RATING_SHORT":17})
        old[b"hyperlinkLines"] = self.table([
            {"type":0,"leftText":"誓言使者战靴"}, {"leftText":"物品等级133"},
            {"type":20,"leftText":"拾取后绑定"}, {"type":21,"leftText":"脚部","rightText":"板甲"},
            {"leftText":"49点护甲"}, {"leftText":"+22 力量"}, {"leftText":"+178 耐力"},
            {"leftText":"+25 爆击"}, {"leftText":"+17 急速"}, {"leftText":"耐久度 65 / 65"},
            {"leftText":"需要等级 80"}, {"type":11},
        ])
        old[b"inventoryLines"] = self.table([{"leftText":"誓言使者战靴"}, {"type":20,"leftText":"灵魂绑定"}])
        self.g.New = self.g.NewItem(237917, b"actual-bop-path-boots", "淬血胫甲".encode())
        new = self.g.New
        new[b"kind"], new[b"level"], new[b"usable"] = b"INVTYPE_FEET", 174, False
        new[b"itemType"], new[b"subtype"] = "护甲".encode(), "板甲".encode()
        new[b"compareStats"] = self.table({"ITEM_MOD_STRENGTH_SHORT":32,"ITEM_MOD_STAMINA_SHORT":401,"RESISTANCE0_NAME":83,"ITEM_MOD_CRIT_RATING_SHORT":27,"ITEM_MOD_HASTE_RATING_SHORT":27})
        new[b"bagLines"] = self.table([
            {"leftText":line} for line in ["淬血胫甲", "物品等级174", "灵魂绑定", "脚部 · 板甲", "83点护甲", "+32 力量", "+401 耐力", "+27 爆击", "+27 急速", "品质：|A:Professions-ChatIcon-Quality-Tier4:17:17|a", "<由制甲师制造>", "耐久度 65 / 65", "需要等级 81"]
        ])
        self.g.Bags[0][2] = new
        self.ns[b"Equipment"][b"Scan"]()
        _, body, _ = self.comparison()
        record_tooltip = [self.g.Records[1][b"tooltip"][i].decode() for i in range(1, len(self.g.Records[1][b"tooltip"])+1)]
        self.assertIn("灵魂绑定", record_tooltip)
        self.assertNotIn("拾取后绑定", record_tooltip)
        self.assertGreater(self.g.TooltipReads[b"bag"][new[b"link"]], 0)
        self.assertGreater(self.g.TooltipReads[b"hyperlink"][old[b"link"]], 0)
        self.assertIsNone(self.g.TooltipReads[b"inventory"][old[b"link"]])
        self.assertFalse(body["current"]["complex"])
        self.assertFalse(body["candidate"]["complex"])
        self.assertEqual(self.decision(), ("upgrade", "stats_upgrade"))
        self.assertEqual(self.h.offer()["item"], 237917)
        self.assertEqual(self.h.offer()["old"], 272256)
        self.assertIsNotNone(self.g.Visible)
        self.assertEqual(len(self.g.Actions), 0)
        self.g.AcceptPopup()
        self.assertEqual(self.g.Inventory[8][b"guid"], b"actual-bop-path-boots")
        self.assertEqual(self.h.result()["st"], "equipped")

    def test_wrist_slot_metadata_is_plain_but_bop_does_not_hide_real_effects(self):
        self.add(kind="INVTYPE_WRIST", lines=["New item", "腕部", "拾取后绑定", "83点护甲", "+27 爆击"])
        self.assertEqual(self.decision(), ("upgrade", "empty_slot"))
        for effect in ["拾取后绑定，装备：提高伤害", "装备：攻击有几率触发护盾。", "(2) 套装：提高伤害。", "附魔：力量 +10", "黄色插槽"]:
            with self.subTest(effect=effect):
                self.setUp()
                old = self.g.SetupOld(9, 100, b"Old wrist", 100, b"INVTYPE_WRIST")
                old[b"hyperlinkLines"] = self.table([{"leftText":"Old wrist"}, {"type":20,"leftText":"拾取后绑定"}, {"leftText":"腕部"}, {"leftText":effect}])
                self.add(kind="INVTYPE_WRIST", lines=["New item", "腕部", "灵魂绑定"])
                self.assertEqual(self.decision(), ("review", "complex_item"))
                self.assertIsNone(self.g.Visible)
                self.assertEqual(len(self.g.Actions), 0)

    def test_equippability_and_level_must_be_known_and_rechecked_on_click(self):
        for change in [b'C_Item.IsEquippableItem=nil', b'C_Item.IsEquippableItem=function() return Secret end', b'Model.level=Secret']:
            with self.subTest(change=change):
                self.setUp()
                self.add()
                self.lua.execute(change)
                _, body, assessment = self.comparison()
                self.assertFalse(body["candidate"]["complete"])
                self.assertNotEqual(assessment[b"verdict"], b"upgrade")
                self.g.AcceptPopup()
                self.assertEqual(len(self.g.Actions), 0)
                self.assertEqual(self.h.result()["st"], "failed")

    def test_insufficient_level_does_not_offer_equipment(self):
        self.g.Model[b"level"] = 79
        self.add()
        self.assertEqual(self.decision(), ("not_upgrade", "unusable"))
        self.assertIsNone(self.g.Visible)
        self.assertEqual(len(self.g.Offers), 0)
        self.assertEqual(len(self.g.Actions), 0)

    def test_basic_localized_tooltip_metadata_does_not_hide_actual_effects(self):
        self.add(lines=["New item", "手部", "83点护甲", "+27 爆击", "品质：|A:quality-icon:17:17|a", "<由制甲师制造>", "Quality: |A:quality-icon:17:17|a", "<Made by Smith>", "<Crafted by Smith>", "83 Armor", "+27 Critical Strike"])
        self.assertEqual(self.decision(), ("upgrade", "empty_slot"))
        for text in ["83点护甲，受到攻击时触发护盾", "品质：使伤害提高", "<由制甲师制造> 装备：触发火球", "装备：提高护甲83点。", "(2) 套装：提高伤害。", "附魔：力量 +10", "黄色插槽"]:
            with self.subTest(text=text):
                self.setUp()
                self.add(lines=["New item", "手部", "83点护甲", "+27 爆击", text])
                self.assertEqual(self.decision(), ("review", "complex_item"))
                self.assertIsNone(self.g.Visible)

    def test_client_localized_labels_and_numeric_formats_keep_effects_for_review(self):
        self.lua.execute('''
ITEM_MOD_CRIT_RATING_SHORT="Coup critique"
ITEM_SOULBOUND="Lié"
INVTYPE_HAND="Mains"
ITEM_LEVEL="Niveau d’objet %d"
ARMOR_TEMPLATE="%s armure"
DURABILITY_TEMPLATE="Durabilité %d / %d"
'''.encode())
        load = self.lua.eval(b"function(source,ns) assert(loadstring(source))('WoWMapCompanion',ns) end")
        load((ROOT / "EquipmentCompare.lua").read_bytes(), self.ns)
        self.add(lines=["New item", "Mains", "Lié", "Niveau d’objet 150", "83 armure", "+27 Coup critique", "Durabilité 40 / 40"])
        self.assertEqual(self.decision(), ("upgrade", "empty_slot"))
        # Exact numeric formats do not consume a suffix describing a real effect.
        record = self.g.Records[1]
        record[b"tooltip"] = self.table(["New item", "83 armure et déclenche un bouclier"])
        comparison, assessment = self.ns[b"EquipmentCompare"][b"Capture"](self.g.Owner, record)
        self.assertTrue(comparison[b"candidate"][b"complex"])
        self.assertEqual(assessment[b"verdict"], b"review")

    def test_retribution_single_hand_case_is_not_an_upgrade_despite_47_more_item_levels(self):
        self.lua.execute(b'Model.class="PALADIN"; Model.spec=70; Owner.class="PALADIN"; Owner.spec=70; function GetSpecializationInfo() return Model.spec,"Spec",nil,123,"DAMAGER",1 end')
        old = self.g.SetupOld(16, 219354, "塑山者的巨斧".encode(), 111, b"INVTYPE_2HWEAPON")
        old[b"compareStats"] = self.table({"ITEM_MOD_STRENGTH_SHORT":24,"ITEM_MOD_STAMINA_SHORT":131,"ITEM_MOD_HASTE_RATING_SHORT":26,"ITEM_MOD_VERSATILITY":22,"ITEM_MOD_DAMAGE_PER_SECOND_SHORT":17.6})
        self.add(kind="INVTYPE_WEAPON", level=158, stats={"ITEM_MOD_STRENGTH_SHORT":18,"ITEM_MOD_STAMINA_SHORT":201,"ITEM_MOD_HASTE_RATING_SHORT":16,"ITEM_MOD_VERSATILITY":17,"ITEM_MOD_DAMAGE_PER_SECOND_SHORT":20.769229888916})
        self.assertEqual(self.decision(), ("not_upgrade", "wrong_spec"))
        self.assertIsNone(self.g.Visible)
        self.assertEqual(len(self.g.Actions), 0)

    def test_weapon_family_changes_and_unknown_stat_keys_need_review(self):
        self.g.SetupOld(16, 100, b"Old two hand", 100, b"INVTYPE_2HWEAPON")
        self.add(kind="INVTYPE_WEAPON")
        self.assertEqual(self.decision(), ("review", "weapon_change"))
        self.setUp()
        self.g.SetupOld(5, 100, b"Old chest", 100)
        self.add(stats={"ITEM_MOD_INTELLECT_SHORT":150,"UNKNOWN_BONUS":10})
        self.assertEqual(self.decision(), ("review", "incomplete"))
        self.assertIsNone(self.g.Visible)

    def test_inactive_primary_stats_do_not_block_a_relevant_upgrade(self):
        old = self.g.SetupOld(5, 100, b"Old chest", 100)
        old[b"compareStats"] = self.table({"ITEM_MOD_INTELLECT_SHORT":100,"ITEM_MOD_STRENGTH_SHORT":200})
        self.add(stats={"ITEM_MOD_INTELLECT_SHORT":150,"ITEM_MOD_STRENGTH_SHORT":100})
        self.assertEqual(self.decision(), ("upgrade", "stats_upgrade"))

    def test_specialization_and_stats_are_rechecked_before_the_actual_click(self):
        for change in [b'Model.spec=63', b'New.compareStats={ITEM_MOD_INTELLECT_SHORT=50}', b'C_Item.GetItemSpecInfo=function() return Secret end']:
            with self.subTest(change=change):
                self.setUp()
                self.g.SetupOld(5, 100, b"Old chest", 100)
                self.add()
                self.lua.execute(change)
                self.g.AcceptPopup()
                self.assertEqual(len(self.g.Actions), 0)
                self.assertEqual(self.h.result()["r"], "changed")

    def test_unknown_item_level_does_not_emit_an_invalid_comparison_or_prompt(self):
        self.add()
        self.lua.execute(b'C_Item.GetDetailedItemLevelInfo=function() return Secret end')
        value, _, _ = self.comparison()
        self.assertIsNone(self.ns[b"Transfer"][b"EncodeComparison"](value)[0])
        self.g.AcceptPopup()
        self.assertEqual(len(self.g.Actions), 0)

    def test_c1_text_is_not_published_as_valid_complete_item_facts(self):
        self.add()
        self.g.New[b"name"] = "Bad\u0085Name".encode()
        _, body, _ = self.comparison()
        self.assertFalse(body["candidate"]["complete"])
        self.assertEqual(body["candidate"]["name"], "")

    def test_comparison_roundtrip_has_exact_512_byte_frames_and_unmodified_stats(self):
        self.g.SetupOld(5,100,b"Old chest",100)
        self.add()
        value, body, _ = self.comparison()
        frames, encoded = self.ns[b"Transfer"][b"EncodeComparison"](value)
        self.assertLessEqual(len(encoded), 4096)
        import base64
        pieces=[]
        for index in range(1,len(frames)+1):
            frame=frames[index]
            self.assertEqual(len(frame),512)
            self.assertEqual(frame[:4], b"WCF1" if ROOT.name=="WoWForeverCompanion" else b"WCP1")
            size,crc=struct.unpack("<HH",frame[4:8]); fragment=json.loads(frame[8:8+size])
            self.assertEqual(binascii.crc_hqx(frame[8:8+size],0xffff),crc)
            self.assertEqual(fragment["kind"],"cmp")
            pieces.append(base64.b64decode(fragment["d"]))
        self.assertEqual(json.loads(b"".join(pieces)),body)
        fixture=ROOT/'tests'/'fixtures';fixture.mkdir(exist_ok=True)
        (fixture/'lua-comparison.json').write_text(json.dumps(body,ensure_ascii=False,indent=2),encoding='utf-8')
        for index in range(1,len(frames)+1):(fixture/f'lua-comparison-{index:03}.bin').write_bytes(frames[index])

    def test_comparison_encoder_does_not_truncate_large_stats_to_create_false_proof(self):
        self.g.SetupOld(5,100,b"Old chest",100)
        self.add()
        value, _, _ = self.comparison()
        oversized=[{"key":f"{'X'*60}{i:02}","value":1e12} for i in range(32)]
        value[b"candidate"][b"stats"] = self.table(oversized)
        value[b"current"][b"stats"] = self.table(oversized)
        self.assertIsNone(self.ns[b"Transfer"][b"EncodeComparison"](value)[0])
        self.assertEqual(len(value[b"candidate"][b"stats"]),32)

    def test_fresh_comparison_precedes_equipment_without_replacing_state_or_offer_slots(self):
        self.g.SetupOld(5,100,b"Old chest",100)
        self.add()
        kinds=[]
        for _ in range(80):
            self.ns[b"Transfer"][b"Advance"]()
            frame=self.ns[b"Transfer"][b"Current"](b"state")
            if frame==b"state":kinds.append("state")
            else:
                length=struct.unpack('<H',frame[4:6])[0]
                kinds.append(json.loads(frame[8:8+length]).get('kind'))
        self.assertEqual(kinds[1::2],["state"]*40)
        self.assertLess(kinds.index('cmp'),kinds.index('eq'))
        self.assertIn('offer',kinds)
        self.assertIn('eq',kinds)

    def test_comparisons_are_still_published_when_confirmation_is_disabled(self):
        self.g.Settings[b"confirmEquip"] = False
        self.add()
        self.ns[b"Transfer"][b"Advance"]()
        frame=self.ns[b"Transfer"][b"Current"](b"state")
        length=struct.unpack('<H',frame[4:6])[0]
        self.assertEqual(json.loads(frame[8:8+length])["kind"],"cmp")
        self.assertIsNone(self.g.Visible)

    def test_shared_assessment_vectors_are_produced_by_actual_lua_rules(self):
        self.g.SetupOld(5,100,b"Old chest",150)
        self.add(stats={"ITEM_MOD_INTELLECT_SHORT":151,"ITEM_MOD_HASTE_RATING_SHORT":42})
        _,base,_=self.comparison()
        examples=[]
        def case(name, changes, verdict, reason):
            comparison=copy.deepcopy(base)
            changes(comparison)
            result=self.ns[b"EquipmentCompare"][b"Evaluate"](self.table(comparison))
            assessment={"verdict":result[b"verdict"].decode(),"reason":result[b"reason"].decode()}
            self.assertEqual(assessment,{"verdict":verdict,"reason":reason},name)
            examples.append({"name":name,"comparison":comparison,"assessment":assessment})
        case('same-level-actual-stat-upgrade',lambda c:None,'upgrade','stats_upgrade')
        case('empty-slot',lambda c:c.update(current={"itemID":0,"name":"空槽","itemLevel":-1,"equipLoc":"","type":"","subtype":"","stats":[],"complex":False,"complete":True}),'upgrade','empty_slot')
        case('unusable',lambda c:c.update(usable=False),'not_upgrade','unusable')
        case('wrong-spec',lambda c:c.update(specMatch=False),'not_upgrade','wrong_spec')
        case('unknown-target',lambda c:c.update(slot=0,current=None),'review','no_target')
        case('incomplete',lambda c:c['candidate'].update(complete=False),'review','incomplete')
        case('unknown-spec',lambda c:c.update(specMatch=None),'review','unknown_spec')
        case('complex',lambda c:c['candidate'].update(complex=True),'review','complex_item')
        case('different-weapon-family',lambda c:c['current'].update(equipLoc='INVTYPE_2HWEAPON'),'review','weapon_change')
        case('weaker',lambda c:c['candidate'].update(stats=[{"key":"ITEM_MOD_INTELLECT_SHORT","value":140},{"key":"ITEM_MOD_HASTE_RATING_SHORT","value":42}]),'not_upgrade','weaker_stats')
        case('equivalent',lambda c:c['candidate'].update(stats=copy.deepcopy(c['current']['stats'])),'not_upgrade','equivalent')
        case('mixed',lambda c:c['candidate'].update(stats=[{"key":"ITEM_MOD_INTELLECT_SHORT","value":160},{"key":"ITEM_MOD_HASTE_RATING_SHORT","value":20}]),'review','stat_tradeoff')
        case('primary-upgrade-secondary-tradeoff',lambda c:c['candidate'].update(itemLevel=160,stats=[{"key":"ITEM_MOD_INTELLECT_SHORT","value":160},{"key":"ITEM_MOD_HASTE_RATING_SHORT","value":20}]),'review','primary_upgrade_tradeoff')
        def core_loss(c):
            c['current']['stats'].append({"key":"ITEM_MOD_STAMINA_SHORT","value":200})
            c['candidate'].update(itemLevel=160,stats=[{"key":"ITEM_MOD_INTELLECT_SHORT","value":160},{"key":"ITEM_MOD_HASTE_RATING_SHORT","value":20},{"key":"ITEM_MOD_STAMINA_SHORT","value":199}])
        case('primary-upgrade-core-stat-loss',core_loss,'review','stat_tradeoff')
        case('lower-level-up-stats',lambda c:c['candidate'].update(itemLevel=140),'review','stat_tradeoff')
        def primary(c):
            c['current']['stats'].append({"key":"ITEM_MOD_STRENGTH_SHORT","value":500})
            c['candidate']['stats'].append({"key":"ITEM_MOD_STRENGTH_SHORT","value":100})
        case('ignore-inactive-primary',primary,'upgrade','stats_upgrade')
        case('unknown-stat-key',lambda c:c['candidate']['stats'].append({"key":"UNKNOWN_EFFECT","value":100}),'review','incomplete')
        def hammer(c):
            c.update(class_='PALADIN')
            c['class']=c.pop('class_');c.update(spec=70,primary=1,specMatch=False,slot=16)
            c['current'].update(itemID=219354,name='塑山者的巨斧',itemLevel=111,equipLoc='INVTYPE_2HWEAPON',type='武器',subtype='双手斧',stats=[{"key":"ITEM_MOD_STRENGTH_SHORT","value":24},{"key":"ITEM_MOD_STAMINA_SHORT","value":131},{"key":"ITEM_MOD_HASTE_RATING_SHORT","value":26},{"key":"ITEM_MOD_VERSATILITY","value":22},{"key":"ITEM_MOD_DAMAGE_PER_SECOND_SHORT","value":17.6}])
            c['candidate'].update(itemID=257013,name='新绿碎击者',itemLevel=158,equipLoc='INVTYPE_WEAPON',type='武器',subtype='单手锤',stats=[{"key":"ITEM_MOD_STRENGTH_SHORT","value":18},{"key":"ITEM_MOD_STAMINA_SHORT","value":201},{"key":"ITEM_MOD_HASTE_RATING_SHORT","value":16},{"key":"ITEM_MOD_VERSATILITY","value":17},{"key":"ITEM_MOD_DAMAGE_PER_SECOND_SHORT","value":20.769229888916}])
        case('actual-retribution-hammer',hammer,'not_upgrade','wrong_spec')
        fixture=ROOT/'tests'/'fixtures';fixture.mkdir(exist_ok=True)
        (fixture/'lua-comparison-cases.json').write_text(json.dumps(examples,ensure_ascii=False,indent=2),encoding='utf-8')

    def test_real_addon_transmits_complete_comparison_within_eight_seconds_at_quarter_second_cadence(self):
        from test_addon import LuaRuntime, MOCK
        from test_equipment import EQUIPMENT_MOCK
        import base64
        runtime=LuaRuntime(encoding=None,unpack_returned_tuples=True)
        runtime.execute(MOCK);runtime.execute(EQUIPMENT_MOCK);runtime.execute(test_confirm_equip.CONFIRM_MOCK)
        g,ns=runtime.globals(),runtime.table()
        g.NS=ns
        g.SetupOld(5,100,b"Old chest",100)
        load=runtime.eval(b'function(source,name,ns) assert(loadstring(source))(name,ns) end')
        for filename in ('Protocol.lua','Money.lua','Equipment.lua','Transfer.lua','EquipmentCompare.lua','ConfirmEquip.lua','Inventory.lua','Quests.lua','Talents.lua','Telemetry.lua',ROOT.name+'.lua'):
            load((ROOT/filename).read_bytes(),ROOT.name.encode(),ns)
        g.Fire(b'ADDON_LOADED',ROOT.name.encode());g.Fire(b'PLAYER_ENTERING_WORLD');g.AdvanceTime(2)
        self.assertEqual([g.Tickers[i][b'delay'] for i in range(1,len(g.Tickers)+1)],[1,0.25])
        g.New=g.NewItem(12345,b'quarter-second-item',b'New item');g.New[b'level']=150;g.Bags[0][2]=g.New
        g.Fire(b'BAG_UPDATE_DELAYED')
        parts,offer,finished={},None,None
        for step in range(1,33):
            g.AdvanceTime(0.25)
            # Execute the actual two ticker callbacks at their independent production cadence.
            if step%4==0:g.Tickers[1][b'callback']()
            g.Tickers[2][b'callback']()
            frame=ns[b'Transfer'][b'Current'](b'state')
            if frame==b'state':continue
            size,crc=struct.unpack('<HH',frame[4:8]);payload=frame[8:8+size]
            self.assertEqual(binascii.crc_hqx(payload,0xffff),crc)
            fragment=json.loads(payload)
            if fragment['kind']=='offer' and fragment['st']=='ready':offer=fragment
            if fragment['kind']=='cmp':
                parts.setdefault(fragment['p'],base64.b64decode(fragment['d']))
                if len(parts)==fragment['n'] and offer:
                    finished=step*0.25;break
        self.assertIsNotNone(finished)
        self.assertLessEqual(finished,8)
        comparison=json.loads(b''.join(parts[p] for p in sorted(parts)))
        self.assertEqual((comparison['id'],comparison['candidate']['itemID'],offer['id'],offer['item']),(1,12345,1,12345))
        self.assertTrue(comparison['candidate']['complete'])
        database=g[(ROOT.name+'DB').encode()]
        self.assertEqual(database[b'snapshot'][b'tick'],step//4)
        self.assertEqual(len(g.Actions),0)

    def test_maximum_comparison_finishes_before_offer_and_equipment_ttls(self):
        self.g.SetupOld(5,100,b"Old chest",100)
        self.add()
        value,body,_=self.comparison()
        self.lua.eval(b'function(source,ns) assert(loadstring(source))("test",ns) end')((ROOT/'Transfer.lua').read_bytes(),self.ns)
        body['current']['complete']=False
        body['candidate']['complete']=False
        body['candidate']['stats']=[{'key':f'{"X"*60}{i:02}','value':1e12} for i in range(32)]
        # Choose an exact largest valid body without truncating any source facts.
        body['current']['stats']=[]
        current=self.table(body)
        remaining=4096-len(self.ns[b'Transfer'][b'ComparisonJSON'](current))
        self.assertGreater(remaining,0)
        for item in ['current','candidate']:
            for key in ['name','type','subtype','equipLoc']:
                take=min(128-len(body[item][key].encode()),remaining)
                body[item][key]+='X'*take;remaining-=take
        self.assertEqual(remaining,0)
        current=self.table(body)
        frames,encoded=self.ns[b'Transfer'][b'EncodeComparison'](current)
        self.assertEqual(len(encoded),4096)
        self.assertEqual(len(frames),18)
        self.assertTrue(self.ns[b'Transfer'][b'AddComparison'](current))
        record=self.g.Records[1]
        record[b'tooltip']=self.table([])
        while True:
            index=len(record[b'tooltip'])+1
            record[b'tooltip'][index]=b'Z'*256
            size=len(self.ns[b'Transfer'][b'JSON'](record))
            if size>8190:
                record[b'tooltip'][index]=b'Z'*(256-(size-8190));break
        self.ns[b'Transfer'][b'Add'](record)
        self.ns[b'Transfer'][b'SetOffer'](self.g.Offers[1])
        self.ns[b'Transfer'][b'AddSwap'](self.table({'v':1,'kind':'swap','s':body['session'],'g':body['guid'],'id':1,'e':body['id'],'st':'declined','r':'user','at':1700000002,'slot':5,'item':12345,'old':100}))
        cmp_parts,eq_parts={},{}
        eq_start=None
        for tick in range(1,300):
            self.g.AdvanceTime(1)
            self.ns[b'Transfer'][b'Advance']()
            frame=self.ns[b'Transfer'][b'Current'](b'state')
            if frame==b'state':continue
            length=struct.unpack('<H',frame[4:6])[0];fragment=json.loads(frame[8:8+length])
            if fragment['kind']=='cmp':cmp_parts.setdefault(fragment['p'],tick)
            if fragment['kind']=='eq':
                eq_start=eq_start or tick;eq_parts.setdefault(fragment['p'],tick)
            if len(eq_parts)==35:break
        self.assertEqual(len(cmp_parts),18)
        self.assertLessEqual(max(cmp_parts.values()),72)
        self.assertEqual(len(eq_parts),35)
        self.assertLess(max(eq_parts.values())-eq_start,180)

    def test_new_comparison_explicitly_drops_an_older_partial_equipment_stream(self):
        self.add()
        value,_,_=self.comparison()
        self.lua.eval(b'function(source,ns) assert(loadstring(source))("test",ns) end')((ROOT/'Transfer.lua').read_bytes(),self.ns)
        self.ns[b'Transfer'][b'Add'](self.g.Records[1])
        self.ns[b'Transfer'][b'Advance']()
        value[b'id']=2
        self.assertTrue(self.ns[b'Transfer'][b'AddComparison'](value))
        self.assertIn('缓存 0/6'.encode(),self.ns[b'Transfer'][b'Status']())
        self.assertIn('跳过 1'.encode(),self.ns[b'Transfer'][b'Status']())
        for _ in range(30):
            self.ns[b'Transfer'][b'Advance']()
            frame=self.ns[b'Transfer'][b'Current'](b'state')
            if frame!=b'state':
                length=struct.unpack('<H',frame[4:6])[0]
                self.assertEqual(json.loads(frame[8:8+length])['kind'],'cmp')


if __name__ == '__main__':
    unittest.main()
