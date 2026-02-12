---
title: "programs.yaml"
source_path: "02_Operations_and_Data/programs.yaml"
tags: ["返佣", "SOP", "表格", "清单", "服务", "语言", "新加坡", "PSB", "Amity", "Kaplan"]
ocr: false
---

# programs.yaml

简介：内容概述：# Maple Education – Program & Provider Definitions

## 内容

```text
# Maple Education – Program & Provider Definitions
# 枫叶留学项目与院校数据（供 SOP / 网站 / 内部定价统一使用）

# 设计思路：
# - providers：新加坡本地教学提供方（Kaplan / PSB / Amity / SIM 等）。
# - programs：以「本地院校 + 合作大学 + 学位层级」为颗粒度的项目列表，可逐步补全。
# - 返佣比例和具体金额仍以 Template_04_返佣项目清单.md 为准，这里只保留“高/中/低/无”等 band。

providers:
  - id: kaplan
    name_en: "Kaplan Higher Education Academy"
    name_cn: "新加坡楷博高等教育学院"
    category: "private_university"
    brand_position_cn: >
      合作项目众多，包含多所 QS 前列大学的衔接课程；整体录取难度不高，
      必要时可先读语言班，但毕业要求相对严格，适合愿意投入学习的学生。
    typical_routes:
      - private_university_sg
      - new2_pathway
    commission_band: "high"   # 具体比例见 Template_04_返佣项目清单.md

  - id: psb
    name_en: "PSB Academy"
    name_cn: "新加坡 PSB 学院"
    category: "private_university"
    brand_position_cn: >
      历史较久的私立院校，拥有多所合作大学项目，整体定位与 Kaplan 相近，
      重视教学质量与毕业要求。
    typical_routes:
      - private_university_sg
      - new2_pathway
    commission_band: "high"

  - id: amity
    name_en: "Amity Global Institute"
    name_cn: "新加坡 Amity 全球学院"
    category: "private_university"
    brand_position_cn: >
      可作为私立本科路径的保底选项，录取相对容易，毕业压力相对较小，
      本科成绩较好同样可以申请 NUS / NTU 硕士，成绩一般则可衔接私立硕士。
    typical_routes:
      - private_university_sg
    commission_band: "high"

  - id: sim
    name_en: "SIM Global Education"
    name_cn: "SIM Global Education"
    category: "private_university"
    brand_position_cn: >
      整体品牌与教学质量在新加坡私立院校中处于较高位置，但录取与毕业难度较大，
      更适合基础较好、学习自驱力强的学生。
    typical_routes:
      - private_university_sg
    commission_band: "medium"   # 返佣相对不高，学生端需加收服务费

  - id: aeis_public
    name_en: "Singapore Government Schools via AEIS"
    name_cn: "新加坡公立学校（AEIS / S-AEIS）"
    category: "k12_public"
    brand_position_cn: >
      通过 AEIS / S-AEIS 考试进入政府小学/中学，是目前唯一可以在学生身份阶段申请 PR 的主流路线。
    typical_routes:
      - aeis_public
    commission_band: "none"

  - id: k12_international_generic
    name_en: "Singapore International Schools (Generic)"
    name_cn: "新加坡国际学校（统称）"
    category: "k12_international"
    brand_position_cn: >
      包含新加坡常见的国际学校体系（如加拿大国际学校、澳洲国际学校等），
      以欧美/澳洲名校为主要升学目标，新加坡公立大学为备选。
    typical_routes:
      - k12_international
    commission_band: "low_or_medium"

  - id: kindergarten_private_generic
    name_en: "Private Kindergartens (Generic)"
    name_cn: "本地私立幼儿园（统称）"
    category: "kindergarten"
    brand_position_cn: >
      主要面向 6 岁以下儿童的本地私立幼儿园，用于早期落地和适应环境，
      可与后续公立/国际学校路径结合。
    typical_routes:
      - kindergarten_private
    commission_band: "none"

programs:
  # 下面仅为示例项目，真实列表可根据返佣表与合作协议逐步补充。

  - id: kaplan_ucd_bachelor_business_generic
    provider_id: kaplan
    main_route: private_university_sg
    partner_university_en: "University College Dublin"
    partner_university_cn: "都柏林大学（UCD）"
    degree_level: "bachelor"
    discipline: "business"
    qs_band_approx: "QS 前 150 左右（以当年为准）"
    entry_difficulty: "easy"
    graduation_difficulty: "medium"
    commission_band: "high"
    route_tags:
      - private_university
      - future_nus_ntu_masters_possible
    selling_points_cn: >
      对接 UCD 等 QS 前 150 左右的商科项目，录取门槛相对友好，
      必要时可先读语言班，但毕业需要持续投入学习。
    internal_notes_cn: "具体佣金比例请参考 Template_04_返佣项目清单.md 中 Kaplan 对应条目。"

  - id: psb_birmingham_bachelor_business_generic
    provider_id: psb
    main_route: private_university_sg
    partner_university_en: "University of Birmingham"
    partner_university_cn: "伯明翰大学"
    degree_level: "bachelor"
    discipline: "business"
    qs_band_approx: "英国传统名校，QS 排名以当年为准"
    entry_difficulty: "easy_or_medium"
    graduation_difficulty: "medium_or_high"
    commission_band: "high"
    route_tags:
      - private_university
      - future_nus_ntu_masters_possible
    selling_points_cn: >
      通过 PSB 对接伯明翰等英国名校商科项目，适合有一定学术基础、
      希望获得具有国际认可度学位的学生。
    internal_notes_cn: "具体合作结构与佣金条款以当期协议为准，需手工补充。"

  - id: amity_generic_bachelor_business
    provider_id: amity
    main_route: private_university_sg
    partner_university_en: "Amity Partner University (Generic)"
    partner_university_cn: "Amity 合作大学（统称）"
    degree_level: "bachelor"
    discipline: "business"
    qs_band_approx: "中等水平，适合作为保底与相对容易毕业选项"
    entry_difficulty: "easy"
    graduation_difficulty: "easy_or_medium"
    commission_band: "high"
    route_tags:
      - private_university
      - future_nus_ntu_masters_possible
    selling_points_cn: >
      可作为私立本科路径的保底方案，录取相对容易，毕业压力相对较小，
      对于想要稳妥拿本科学位、未来再视成绩冲击 NUS/NTU 硕士或私立硕士的学生很合适。
    internal_notes_cn: "后续可按具体合作大学拆分为若干条 Program。"

  - id: sim_generic_bachelor_business
    provider_id: sim
    main_route: private_university_sg
    partner_university_en: "SIM Partner Universities (Generic)"
    partner_university_cn: "SIM 合作大学（统称）"
    degree_level: "bachelor"
    discipline: "business"
    qs_band_approx: "整体合作院校质量较高，QS 区间以当年为准"
    entry_difficulty: "medium_or_high"
    graduation_difficulty: "high"
    commission_band: "medium"
    route_tags:
      - private_university
      - future_nus_ntu_masters_possible
    selling_points_cn: >
      整体品牌和合作大学质量较高，但录取与毕业难度也相对更大，
      更适合学习成绩和自驱力都比较强的学生。
    internal_notes_cn: "由于返佣水平相对不高，前端定价时需要在学生端额外加收服务费。"

  - id: aeis_public_generic
    provider_id: aeis_public
    main_route: aeis_public
    degree_level: "primary_or_secondary"
    discipline: "k12"
    qs_band_approx: ""
    entry_difficulty: "exam_competitive"
    graduation_difficulty: "public_school_standard"
    commission_band: "none"
    route_tags:
      - k12_public
      - student_pr_possible
    selling_points_cn: >
      通过 AEIS / S-AEIS 考试进入政府小学/中学，长期来看有机会以学生身份申请 PR，
      但考试存在不确定性，对学生英文与学科基础有一定要求。
    internal_notes_cn: "具体目标学校可在后续细分为多条 Program。"

  - id: k12_international_generic
    provider_id: k12_international_generic
    main_route: k12_international
    degree_level: "k12"
    discipline: "ib_alevel_igcse"
    qs_band_approx: ""
    entry_difficulty: "varies"
    graduation_difficulty: "varies"
    commission_band: "low_or_medium"
    route_tags:
      - k12_international
      - overseas_top_universities
    selling_points_cn: >
      通过国际学校体系（IB / A-Level / IGCSE 等）为主，未来以欧美 / 澳洲大学为主要升学方向，
      适合希望孩子接受国际课程、未来走多国路径的家庭。
    internal_notes_cn: "可以后续拆分为具体学校（CIS / AIS 等）的独立 Program。"

  - id: kindergarten_private_generic
    provider_id: kindergarten_private_generic
    main_route: kindergarten_private
    degree_level: "kindergarten"
    discipline: "early_childhood"
    qs_band_approx: ""
    entry_difficulty: "easy_or_medium"
    graduation_difficulty: ""
    commission_band: "none"
    route_tags:
      - kindergarten
    selling_points_cn: >
      帮助 6 岁以下儿童在新加坡找到合适的本地私立幼儿园，提前适应环境，
      为后续公立或国际学校路线打基础。
    internal_notes_cn: "对应的收费在幼儿园择校服务协议中已固定为 SGD 2,000。"
```
