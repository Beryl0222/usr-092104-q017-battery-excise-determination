// 产品技术分类目录：分类只依赖可核验技术属性与证据，市场名称不参与判定。
// 阈值在此一处定义并随法规版本接受复核；它不是“名称→税率”的映射表。

export const CATEGORIES = {
  solid_state_cell: {
    label: "全固态电芯（试制）",
    tax_scope: "solid_state_cell",
    boundary: false,
    required_evidence: ["inspection_report", "process_record"],
  },
  li_ion_cell: {
    label: "锂离子电芯",
    tax_scope: "li_ion_cell",
    boundary: false,
    required_evidence: ["inspection_report"],
  },
  li_ion_module: {
    label: "锂离子电池模组（含车用动力电池包）",
    tax_scope: "li_ion_module",
    boundary: false,
    required_evidence: ["bom_composition"],
  },
  li_ion_system: {
    label: "锂离子电池储能系统",
    tax_scope: "li_ion_system",
    boundary: false,
    required_evidence: ["bom_composition"],
  },
  hybrid_storage_module: {
    label: "混合储能模组（同时含锂离子电芯与固态试制电芯）",
    tax_scope: "hybrid_storage_module",
    // 所含试制电芯能否按成分拆分享受阶段性免税，属于边界判断，必须人工签署。
    boundary: true,
    required_evidence: ["bom_composition", "inspection_report"],
  },
};

// 全固态判定门槛：检验报告实测固态电解质占比。
export const SOLID_RATIO_THRESHOLD = 0.9;
// 半固态/混合体系灰区下沿。
export const SEMI_SOLID_RATIO_THRESHOLD = 0.5;
// 档案属性与检验报告实测值允许的偏差。
export const MEASUREMENT_TOLERANCE = 0.02;

// 依据技术属性给出候选分类。市场名称（market_names）刻意不在输入之列。
export function candidateCategories(attrs = {}) {
  const ratio = Number(attrs.solid_electrolyte_ratio ?? 0);
  const { form_factor, application, electrochemistry } = attrs;

  if (form_factor === "cell") {
    if (electrochemistry === "solid_state" && ratio >= SOLID_RATIO_THRESHOLD) {
      return ["solid_state_cell"];
    }
    // 半固态或混合电化学体系：既可主张固态试制，也可能被归回锂离子，需签署。
    if (electrochemistry === "hybrid" || ratio >= SEMI_SOLID_RATIO_THRESHOLD) {
      return ["solid_state_cell", "li_ion_cell"];
    }
    return ["li_ion_cell"];
  }

  if (form_factor === "module") {
    if (application === "storage" && attrs.contains_solid_state_trial === true) {
      return ["hybrid_storage_module"];
    }
    return ["li_ion_module"];
  }

  if (form_factor === "system") {
    return ["li_ion_system"];
  }

  return [];
}

export function scopeOfCategory(category) {
  return CATEGORIES[category]?.tax_scope ?? null;
}
