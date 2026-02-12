---
title: "routes.yaml"
source_path: "02_Operations_and_Data/routes.yaml"
tags: ["返佣", "SOP", "说明", "新加坡", "澳洲", "Maple", "yaml"]
ocr: false
---

# routes.yaml

简介：内容概述：# Maple Education – Route Definitions

## 内容

```text
# Maple Education – Route Definitions
# 枫叶留学路径规则配置（供 SOP HTML 使用）

# 说明：
# - 这一层只管「路径逻辑」（适合什么年龄 / 学历 / 目标），不管具体学校返佣数字。
# - 具体学校与合作大学项目在 programs.yaml 中维护。

routes:
  - id: aeis_public
    name_en: "Singapore Public School & AEIS Route"
    name_cn: "新加坡公立学校 & AEIS 路线"
    description_cn: >
      通过 AEIS / S-AEIS 考试进入新加坡政府小学或中学，之后走本地公立体系
      （小学/中学 → JC / 理工 → 本地大学），是目前唯一可以在学生身份阶段申请 PR 的路线。
    description_en: >
      Use AEIS / S-AEIS exams to enter Singapore government primary or secondary schools,
      then progress through the local system (primary/secondary → JC/poly → local universities).
      This is currently the only route where students may apply for PR while still on a student pass.
    goals:
      - nus_ntu_future
      - student_pr_possible
      - long_term_settlement
    eligibility:
      min_age: 7              # 约小二
      max_age: 16             # 上限大致对应初二
      allow_gaokao_graduate: false
      notes_cn: "年龄超过约 16 岁（初二以上）一般不再主推 AEIS，可考虑私立本科 / 新二等路线。"
    recommended_segments:
      - S3_aeis_k12_public
    typical_addons:
      - S7_family_self_employed_ep   # 视家庭条件而定，可选

  - id: k12_international
    name_en: "K12 International School Route"
    name_cn: "K12 国际学校路线"
    description_cn: >
      在新加坡国际学校体系（IB / A-Level / IGCSE 等）就读，从幼儿园一路到高中，
      以欧美 / 澳洲高校为主要目标，新加坡公立大学为备选或加分项。
    description_en: >
      Study in Singapore international schools (IB / A-Level / IGCSE, etc.)
      from kindergarten through high school, using Singapore as a springboard
      to universities in the US/UK/EU/Australia, with local universities as an option.
    goals:
      - overseas_top_universities
      - flexible_destination
    eligibility:
      min_age: 3
      max_age: 18
      allow_gaokao_graduate: true
      notes_cn: "更多是“跳板欧美/澳洲”定位，家庭预算与英文要求通常高于 AEIS 公立路线。"
    recommended_segments:
      - S2_k12_international
    typical_addons:
      - S7_family_self_employed_ep
      - concierge_relocation

  - id: kindergarten_private
    name_en: "Private Kindergarten Placement Route"
    name_cn: "本地私立幼儿园路线"
    description_cn: >
      为 6 岁以下儿童匹配新加坡本地私立幼儿园，帮助家庭提前落地和适应环境，
      为后续 K12 公立或国际学校路线做准备。
    description_en: >
      Match children under 6 with suitable private kindergartens in Singapore,
      helping families settle in early and prepare for later K12 public or international routes.
    goals:
      - early_settlement
      - k12_preparation
    eligibility:
      max_age: 6
      notes_cn: "年龄超过 6 岁通常不再建议走“幼儿园择校”产品，而直接考虑小学或国际学校。"
    recommended_segments:
      - S6_kindergarten
    typical_addons:
      - concierge_relocation

  - id: private_university_sg
    name_en: "Singapore Private University Route"
    name_cn: "新加坡私立大学路线"
    description_cn: >
      以 Kaplan / PSB / Amity / SIM 等新加坡私立院校为载体，从国内初中/高中毕业
      直接进入大专 / 本科或新二 / 预科，再通过合作大学学位接轨全球院校或申请 NUS / NTU 硕士。
    description_en: >
      Use Singapore private institutions such as Kaplan, PSB, Amity and SIM as the main platform,
      allowing students from Chinese junior/senior high to enter diploma/degree or pathway programs,
      then progress to partner universities worldwide or apply for NUS/NTU master’s degrees if grades permit.
    goals:
      - overseas_degree
      - future_nus_ntu_masters_possible
    eligibility:
      min_china_grade: "初中毕业"    # 初中毕业及以上
      allow_gaokao_graduate: true
      notes_cn: >
        适合在国内初中 / 高中毕业，希望尽快取得海外本科学历的学生。
        SIM 整体最好但录取和毕业难度较高；Kaplan / PSB 有 QS100 左右合作大学，
        录取相对容易但毕业有一定难度；Amity 可作为保底且相对容易毕业的选项。
    recommended_segments:
      - S1_private_university
      - S4_new2_pathway
    typical_addons:
      - concierge_relocation
      - S7_family_self_employed_ep

  - id: nus_ntu_direct
    name_en: "NUS / NTU Direct Application Route"
    name_cn: "NUS / NTU 直申路线"
    description_cn: >
      面向中国高考后成绩优秀的学生（内部参考：高考超一本线约 50 分），
      直接申请新加坡公立顶尖大学的本科或硕士项目，可搭配背景提升项目。
    description_en: >
      For strong applicants after the Chinese Gaokao (internally: about +50 points over the tier-1 cutoff),
      applying directly to top Singapore public universities (NUS / NTU) for undergraduate or master’s programs,
      with optional background enhancement services.
    goals:
      - nus_ntu_admission
      - high_end_universities
    eligibility:
      requires_gaokao: true
      gaokao_band_internal_note: "内部参考：高考超一本线约 50 分，不在对外文案中直接写明。"
      notes_cn: "适合目标明确冲顶尖公立大学，能接受严格筛选与较高学术要求的学生。"
    recommended_segments:
      - S5_nus_ntu_highend
    typical_addons:
      - background_enhancement
      - concierge_relocation

  - id: family_self_employed_ep
    name_en: "Family Self-Employed EP Route"
    name_cn: "家庭自雇 EP 路线"
    description_cn: >
      以父母之一持有本科学历为基础，设计新加坡自雇 EP 方案并注册公司，
      实现家长工作身份 + 孩子学生签证 / 学校安置，配合中长期 PR 规划与合规建议。
    description_en: >
      Based on at least one parent having a bachelor’s degree, design a self-employed EP plan and set up
      a Singapore company to secure a work pass for the parent and schooling/visas for the children,
      together with medium- to long-term PR planning and compliance guidance.
    goals:
      - family_relcation
      - long_term_pr_planning
    eligibility:
      requires_parent_bachelor: true
      notes_cn: "建议至少有一位家长具备本科学历及一定资金/业务基础，再考虑自雇 EP 全案。"
    recommended_segments:
      - S7_self_employed_ep_and_family
    typical_addons:
      - concierge_relocation
```
