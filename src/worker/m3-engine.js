import {
  buildHardwarePlan,
  calcCapexWan,
  normalizeProjectInput,
  round,
  simulateEnergyScenario,
  buildIrradianceSeries,
  SCENARIO_DEFINITIONS,
  SCENARIO_KEYS
} from "./scenario-core.js";

function requireBaseline(context) {
  const m1 = context.previousResults?.m1;
  if (!m1?.hardwarePlan) throw new Error("M3 缺少 M1Result，无法读取 S0 基准配置。");
  return m1;
}

function requireM2(context) {
  const m2 = context.previousResults?.m2;

  if (!m2?.demandProfiles?.initial?.loadCurve?.length) {
    throw new Error("M3 缺少 M2 D0 初始需求画像，无法执行情景化配置优化。");
  }

  if (!m2?.demandProfiles?.priceGuided?.loadCurve?.length) {
    throw new Error("M3 缺少 M2 D1 微网电价引导需求画像，无法执行调度情景优化。");
  }

  return m2;
}

const SCENARIO_PROFILE_BINDINGS = {
  offgrid_rule: {
    demandProfileKey: "initial",
    optimizationLabel: "离网不调度最小可行配置"
  },
  offgrid_dispatch: {
    demandProfileKey: "priceGuided",
    optimizationLabel: "离网调度最小可行配置"
  },
  grid_rule: {
    demandProfileKey: "initial",
    optimizationLabel: "并网不调度最低综合成本配置"
  },
  grid_dispatch: {
    demandProfileKey: "priceGuided",
    optimizationLabel: "并网调度最低综合成本配置"
  }
};

function buildBaselineHardware(m1, params) {
  return buildHardwarePlan({
    pvKw: m1.hardwarePlan.pvKw,
    storageKwh: m1.hardwarePlan.storageKwh,
    pcsKw: m1.hardwarePlan.pcsKw,
    n7kw: m1.hardwarePlan.n7kw,
    n30kw: m1.hardwarePlan.n30kw,
    transformerLimitKw: params.transformerLimitKw
  });
}

function buildAnnualIrradianceForM3(params, ticks) {
  return buildIrradianceSeries(params, ticks, {
    monthIndex: 0,
    useGTilt: params.gTiltData?.length >= 8760,
    annualMode: true
  });
}

function uniqueNumbers(values) {
  return [...new Set(values.map((value) => Math.max(0, Math.round(value))))].sort((a, b) => a - b);
}

function scaledValues(baseValue, factors, {
  minValue = 0,
  maxValue = Infinity,
  roundTo = 1
} = {}) {
  const values = factors.map((factor) => {
    const raw = baseValue * factor;
    const rounded = roundTo > 1
      ? Math.round(raw / roundTo) * roundTo
      : Math.round(raw);

    return Math.max(minValue, Math.min(maxValue, rounded));
  });

  return uniqueNumbers(values);
}

function buildPileValues(baseCount, factors) {
  if (baseCount <= 0) return [0];

  const minCount = Math.max(1, Math.floor(baseCount * Math.min(...factors)));
  const values = factors.map((factor) => {
    return Math.max(minCount, Math.round(baseCount * factor));
  });

  return uniqueNumbers(values);
}

function hasSizingPressure(m2, targets = []) {
  const hints = m2?.handoffToM3?.sizingHints || m2?.sizingHints || [];
  return hints.some((hint) => {
    if (!targets.length) return hint.priority === "high";
    return targets.includes(hint.target);
  });
}

const SOC_MIN_PCT = 5;
const OFFGRID_SERVICE_RATE_MIN = 0.99;
const GRID_SERVICE_RATE_MIN = 0.995;
const UNSERVED_TOLERANCE_KWH = 1;

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getTransformerLimitKw(params) {
  const value = Number(params?.transformerLimitKw);
  return Number.isFinite(value) && value > 0 ? value : Infinity;
}

function calcAnnualCostWan(candidate, summary, params) {
  const capexWan = candidate.capex.capexWan;
  const annualizedCapexWan = capexWan * 0.085;
  const annualOpexWan = capexWan * (params.opexRate ?? 0.015);
  const gridCostWan = toFiniteNumber(summary.gridCostYuan, 0) / 10000;

  return {
    capexWan,
    annualizedCapexWan,
    annualOpexWan,
    gridCostWan,
    annualTotalCostWan: annualizedCapexWan + annualOpexWan + gridCostWan
  };
}

function generateM3Candidates(baseline, params, referenceProfile, m2 = null) {
  const roofPvMax = params.roofArea > 0 ? params.roofArea / 6.5 : baseline.pvKw * 2.2;

  const needEnergyReinforce = hasSizingPressure(m2, ["pv_storage_pcs", "storage"]);
  const needGridReinforce = hasSizingPressure(m2, ["grid_dependency", "grid_peak"]);
  const needPvAbsorptionCheck = hasSizingPressure(m2, ["pv_absorption"]);

  const pvFactors = needEnergyReinforce
    ? [0.55, 0.70, 0.85, 1.00, 1.15, 1.35, 1.60]
    : [0.45, 0.60, 0.75, 0.90, 1.00, 1.15];

  const storageFactors = needEnergyReinforce || needPvAbsorptionCheck
    ? [0.35, 0.50, 0.65, 0.80, 1.00, 1.20, 1.50]
    : [0.30, 0.45, 0.60, 0.75, 0.90, 1.00, 1.20];

  const pcsFactors = needEnergyReinforce || needGridReinforce
    ? [0.45, 0.60, 0.75, 0.90, 1.00, 1.15, 1.35]
    : [0.40, 0.55, 0.70, 0.85, 1.00, 1.15];

  const pileFactors = [0.60, 0.75, 0.90, 1.00];

  const pvValues = scaledValues(baseline.pvKw, pvFactors, {
    minValue: Math.min(10, baseline.pvKw),
    maxValue: roofPvMax,
    roundTo: 10
  }).filter((value) => value <= roofPvMax + 1);

  const storageValues = scaledValues(baseline.storageKwh, storageFactors, {
    minValue: baseline.storageKwh > 0 ? 20 : 0,
    roundTo: 50
  });

  const pcsValues = scaledValues(baseline.pcsKw, pcsFactors, {
    minValue: baseline.pcsKw > 0 ? 10 : 0,
    roundTo: 10
  });

  const n7Values = buildPileValues(baseline.n7kw, pileFactors);
  const n30Values = buildPileValues(baseline.n30kw, pileFactors);

  const pilePairs = [];

  n7Values.forEach((n7kw) => {
    n30Values.forEach((n30kw) => {
      if (n7kw + n30kw <= 0) return;
      pilePairs.push([n7kw, n30kw]);
    });
  });

  const baselineCapex = calcCapexWan(baseline, params).capexWan;
  const candidates = [];
  let id = 0;

  pvValues.forEach((pvKw) => {
    storageValues.forEach((storageKwh) => {
      pcsValues.forEach((pcsKw) => {
        pilePairs.forEach(([n7kw, n30kw]) => {
          const hardware = buildHardwarePlan({
            pvKw,
            storageKwh,
            pcsKw,
            n7kw,
            n30kw,
            transformerLimitKw: params.transformerLimitKw
          });

          const capex = calcCapexWan(hardware, params);

          const deltas = {
            deltaPvKw: round(hardware.pvKw - baseline.pvKw, 1),
            deltaStorageKwh: round(hardware.storageKwh - baseline.storageKwh, 1),
            deltaPcsKw: round(hardware.pcsKw - baseline.pcsKw, 1),
            deltaN7kw: hardware.n7kw - baseline.n7kw,
            deltaN30kw: hardware.n30kw - baseline.n30kw
          };

          candidates.push({
            candidateId: `C${String(++id).padStart(3, "0")}`,
            hardwarePlan: hardware,
            capex,
            deltas,
            extraCapexWan: round(capex.capexWan - baselineCapex, 2),
            searchMeta: {
              mode: needEnergyReinforce || needGridReinforce
                ? "reduction_with_reinforcement"
                : "redundancy_reduction",
              pvFactor: baseline.pvKw > 0 ? round(hardware.pvKw / baseline.pvKw, 3) : 0,
              storageFactor: baseline.storageKwh > 0 ? round(hardware.storageKwh / baseline.storageKwh, 3) : 0,
              pcsFactor: baseline.pcsKw > 0 ? round(hardware.pcsKw / baseline.pcsKw, 3) : 0,
              n7Factor: baseline.n7kw > 0 ? round(hardware.n7kw / baseline.n7kw, 3) : 0,
              n30Factor: baseline.n30kw > 0 ? round(hardware.n30kw / baseline.n30kw, 3) : 0
            },
            demandPeakCoverage: referenceProfile.peakLoadKw > 0
              ? round(hardware.pcsKw / referenceProfile.peakLoadKw, 3)
              : 1
          });
        });
      });
    });
  });

  return candidates;
}

function feasibilityForScenario(scenarioKey, summary, params) {
  const isOffgrid = scenarioKey.startsWith("offgrid_");
  const serviceRate = toFiniteNumber(summary.serviceRate, 0);
  const unservedEnergyKwh = toFiniteNumber(summary.unservedEnergyKwh, 0);
  const socMinPct = toFiniteNumber(summary.socMinPct, 0);
  const gridImportKwh = toFiniteNumber(summary.gridImportKwh, 0);
  const peakGridKw = toFiniteNumber(summary.peakGridKw, 0);
  const transformerLimitKw = getTransformerLimitKw(params);

  const serviceRateMin = isOffgrid
    ? OFFGRID_SERVICE_RATE_MIN
    : GRID_SERVICE_RATE_MIN;

  const serviceOk = serviceRate >= serviceRateMin;
  const unservedOk = unservedEnergyKwh <= UNSERVED_TOLERANCE_KWH;
  const socOk = socMinPct >= SOC_MIN_PCT;

  const gridImportViolationKwh = isOffgrid
    ? Math.max(0, gridImportKwh)
    : 0;

  const gridPeakViolationKw = isOffgrid
    ? 0
    : Math.max(0, peakGridKw - transformerLimitKw);

  const gridOk = isOffgrid
    ? gridImportViolationKwh <= 1e-6
    : gridPeakViolationKw <= 1e-6;

  const serviceShortfall = Math.max(0, serviceRateMin - serviceRate);
  const unservedViolationKwh = Math.max(
    0,
    unservedEnergyKwh - UNSERVED_TOLERANCE_KWH
  );
  const socViolationPct = Math.max(0, SOC_MIN_PCT - socMinPct);

  const violationScore =
    serviceShortfall * 10000 +
    unservedViolationKwh * 10 +
    socViolationPct * 100 +
    gridImportViolationKwh * 10 +
    gridPeakViolationKw;

  return {
    feasible: serviceOk && unservedOk && socOk && gridOk,

    serviceOk,
    unservedOk,
    socOk,
    gridOk,

    serviceRateMin,
    socMinPctMin: SOC_MIN_PCT,
    unservedToleranceKwh: UNSERVED_TOLERANCE_KWH,
    transformerLimitKw: Number.isFinite(transformerLimitKw)
      ? transformerLimitKw
      : null,

    serviceShortfall: round(serviceShortfall, 6),
    unservedViolationKwh: round(unservedViolationKwh, 3),
    socViolationPct: round(socViolationPct, 3),
    gridImportViolationKwh: round(gridImportViolationKwh, 3),
    gridPeakViolationKw: round(gridPeakViolationKw, 3),
    violationScore: round(violationScore, 3)
  };
}

function scenarioObjective(scenarioKey, candidate, simulation, feasibility, params) {
  const summary = simulation.summary;
  const annualCost = calcAnnualCostWan(candidate, summary, params);

  if (feasibility.feasible) {
    return annualCost.annualTotalCostWan;
  }

  const infeasiblePenaltyWan =
    feasibility.unservedViolationKwh * 0.05 +
    feasibility.gridImportViolationKwh * 0.05 +
    feasibility.gridPeakViolationKw * 0.02 +
    feasibility.socViolationPct * 5 +
    feasibility.serviceShortfall * 5000;

  return annualCost.annualTotalCostWan + infeasiblePenaltyWan;
}

function isBetterEvaluation(next, best, scenarioKey) {
  if (!best) return true;

  const nf = next.feasibility.feasible;
  const bf = best.feasibility.feasible;

  if (nf && !bf) return true;
  if (!nf && bf) return false;

  if (!nf && !bf) {
    if (next.feasibility.violationScore < best.feasibility.violationScore - 1e-6) {
      return true;
    }

    if (next.feasibility.violationScore > best.feasibility.violationScore + 1e-6) {
      return false;
    }

    return next.costMetrics.objectiveWan < best.costMetrics.objectiveWan;
  }

  const nextCost = next.costMetrics.annualTotalCostWan;
  const bestCost = best.costMetrics.annualTotalCostWan;

  if (nextCost < bestCost - 0.01) return true;
  if (nextCost > bestCost + 0.01) return false;

  if (next.costMetrics.capexWan < best.costMetrics.capexWan - 0.01) return true;
  if (next.costMetrics.capexWan > best.costMetrics.capexWan + 0.01) return false;

  if (scenarioKey.startsWith("offgrid_")) {
    if (next.riskMetrics.unservedEnergyKwh < best.riskMetrics.unservedEnergyKwh - 0.1) {
      return true;
    }

    if (next.riskMetrics.unservedEnergyKwh > best.riskMetrics.unservedEnergyKwh + 0.1) {
      return false;
    }

    return next.riskMetrics.socMinPct > best.riskMetrics.socMinPct + 0.1;
  }

  if (next.gridMetrics.gridImportKwh < best.gridMetrics.gridImportKwh - 0.1) {
    return true;
  }

  if (next.gridMetrics.gridImportKwh > best.gridMetrics.gridImportKwh + 0.1) {
    return false;
  }

  return next.energyMetrics.curtailmentRatePct < best.energyMetrics.curtailmentRatePct - 0.01;
}

function evaluateCandidate(candidate, scenarioKey, demandProfile, irradiance, params) {
  const simulation = simulateEnergyScenario({
    hardware: candidate.hardwarePlan,
    loadCurve: demandProfile.loadCurve,
    irradiance,
    params,
    scenarioKey
  });
  const summary = simulation.summary;
  const feasibility = feasibilityForScenario(scenarioKey, summary, params);
  const objectiveWan = scenarioObjective(
    scenarioKey,
    candidate,
    simulation,
    feasibility,
    params
  );
  const annualCost = calcAnnualCostWan(candidate, summary, params);

  const validationMetrics = {
    unservedEnergyKwh: round(summary.unservedEnergyKwh, 1),
    deficitHours: round(summary.deficitHours, 1),
    serviceRate: round(summary.serviceRate, 5),
    socMinPct: round(summary.socMinPct, 1),
    peakLoadKw: round(summary.peakLoadKw, 1)
  };

  return {
    candidateId: candidate.candidateId,
    scenarioKey,
    demandProfile: {
      key: demandProfile.key,
      label: demandProfile.label,
      dispatch: demandProfile.dispatch
    },
    hardwarePlan: candidate.hardwarePlan,
    deltas: candidate.deltas,
    extraCapexWan: candidate.extraCapexWan,
    searchMeta: candidate.searchMeta,
    feasibility,
    validationMetrics,
    riskMetrics: validationMetrics,
    gridMetrics: {
      gridImportKwh: round(summary.gridImportKwh, 1),
      peakGridKw: round(summary.peakGridKw, 1),
      gridDependencyRate: round(summary.gridDependencyRate, 5),
      gridCostYuan: round(summary.gridCostYuan, 1)
    },
    energyMetrics: {
      pvGenerationKwh: round(summary.pvGenerationKwh, 1),
      pvSelfUseRate: round(summary.pvSelfUseRate, 5),
      curtailmentRatePct: round(summary.curtailmentRatePct, 2)
    },
    costMetrics: {
      capexWan: round(annualCost.capexWan, 2),
      extraCapexWan: candidate.extraCapexWan,
      annualizedCapexWan: round(annualCost.annualizedCapexWan, 2),
      annualOpexWan: round(annualCost.annualOpexWan, 2),
      gridCostWan: round(annualCost.gridCostWan, 2),
      annualTotalCostWan: round(annualCost.annualTotalCostWan, 2),
      objectiveWan: round(objectiveWan, 2),
      totalCostProxyWan: round(objectiveWan, 2)
    },
    summary
  };
}

function optimizeScenario(scenarioKey, candidates, demandProfile, irradiance, params) {
  let recommended = null;
  const evaluatedCandidates = candidates.map((candidate) => {
    const evaluated = evaluateCandidate(candidate, scenarioKey, demandProfile, irradiance, params);
    if (isBetterEvaluation(evaluated, recommended, scenarioKey)) recommended = evaluated;
    return {
      candidateId: evaluated.candidateId,
      hardwarePlan: evaluated.hardwarePlan,
      deltas: evaluated.deltas,
      extraCapexWan: evaluated.extraCapexWan,
      searchMeta: evaluated.searchMeta,
      feasibility: evaluated.feasibility,
      validationMetrics: evaluated.validationMetrics,
      riskMetrics: evaluated.riskMetrics,
      gridMetrics: evaluated.gridMetrics,
      energyMetrics: evaluated.energyMetrics,
      costMetrics: evaluated.costMetrics
    };
  });

  return {
    scenarioKey,
    scenarioLabel: SCENARIO_DEFINITIONS[scenarioKey].label,
    optimizationTarget: getOptimizationTarget(scenarioKey),
    demandProfile: {
      key: demandProfile.key,
      label: demandProfile.label,
      dispatch: demandProfile.dispatch
    },
    feasibleCount: evaluatedCandidates.filter((item) => item.feasibility.feasible).length,
    recommendedConfig: recommended,
    evaluatedCandidates
  };
}

function getOptimizationTarget(scenarioKey) {
  return {
    offgrid_rule:
      "在离网且不进行需求调度的条件下，寻找满足全年服务率、SOC 安全线和未满足电量约束的最小可行配置。",
    offgrid_dispatch:
      "在离网且采用 D1 光伏强时段需求重排的条件下，评估调度对 PV、储能、PCS 和充电桩规模的削减作用。",
    grid_rule:
      "在并网且不进行需求调度的条件下，寻找硬件投资、年运维和全年购电成本综合最低的配置。",
    grid_dispatch:
      "在并网且采用 D1 光伏强时段需求重排的条件下，寻找年综合成本最低并满足并网容量约束的配置。"
  }[scenarioKey];
}

function getRecommended(result, key) {
  return result.scenarioOptimums?.[key]?.recommendedConfig || null;
}

function buildSavingVsBaseline(evaluation) {
  if (!evaluation) return null;

  const deltas = evaluation.deltas || {};

  return {
    capexSavingWan: round(-evaluation.extraCapexWan, 2),

    pvReductionKw: round(-toFiniteNumber(deltas.deltaPvKw, 0), 1),
    storageReductionKwh: round(-toFiniteNumber(deltas.deltaStorageKwh, 0), 1),
    pcsReductionKw: round(-toFiniteNumber(deltas.deltaPcsKw, 0), 1),
    n7Reduction: -toFiniteNumber(deltas.deltaN7kw, 0),
    n30Reduction: -toFiniteNumber(deltas.deltaN30kw, 0),

    pvChangeKw: round(toFiniteNumber(deltas.deltaPvKw, 0), 1),
    storageChangeKwh: round(toFiniteNumber(deltas.deltaStorageKwh, 0), 1),
    pcsChangeKw: round(toFiniteNumber(deltas.deltaPcsKw, 0), 1),
    n7Change: toFiniteNumber(deltas.deltaN7kw, 0),
    n30Change: toFiniteNumber(deltas.deltaN30kw, 0),

    note: evaluation.extraCapexWan < 0
      ? "相对 S0 存在投资节省"
      : evaluation.extraCapexWan > 0
        ? "相对 S0 需要追加投资"
        : "与 S0 投资基本一致"
  };
}

function buildConditionItem(label, evaluation) {
  if (!evaluation) {
    return {
      label,
      scenarioKey: null,
      feasible: false,
      annualTotalCostWan: null,
      capexWan: null,
      note: "该工程条件下暂无推荐结果。"
    };
  }

  return {
    label,
    scenarioKey: evaluation.scenarioKey,
    feasible: Boolean(evaluation.feasibility?.feasible),
    annualTotalCostWan: evaluation.costMetrics?.annualTotalCostWan ?? null,
    capexWan: evaluation.costMetrics?.capexWan ?? null,
    serviceRate: evaluation.validationMetrics?.serviceRate ?? null,
    socMinPct: evaluation.validationMetrics?.socMinPct ?? null,
    note: evaluation.feasibility?.feasible
      ? "该情景存在满足约束的最优配置。"
      : "该情景当前候选集中未找到完全可行配置，结果为违约程度最低的兜底方案。"
  };
}

function buildRecommendedByCondition({
  offgridRule,
  offgridDispatch,
  gridRule,
  gridDispatch,
  lowestTotalCost
}) {
  return {
    noGrid_noDispatch: buildConditionItem("不接电网 / 不接受调度", offgridRule),
    noGrid_withDispatch: buildConditionItem("不接电网 / 接受调度", offgridDispatch),
    grid_noDispatch: buildConditionItem("接入电网 / 不接受调度", gridRule),
    grid_withDispatch: buildConditionItem("接入电网 / 接受调度", gridDispatch),
    lowestAnnualCost: buildConditionItem("最低年综合成本", lowestTotalCost),
    note: "工程推荐应根据是否允许接入电网、是否接受需求调度分别选择，不再默认推荐单一情景。"
  };
}

function buildComparison(result) {
  const offgridRule = getRecommended(result, "offgrid_rule");
  const offgridDispatch = getRecommended(result, "offgrid_dispatch");
  const gridRule = getRecommended(result, "grid_rule");
  const gridDispatch = getRecommended(result, "grid_dispatch");

  const recommendations = [
    offgridRule,
    offgridDispatch,
    gridRule,
    gridDispatch
  ].filter(Boolean);

  const feasibleRecommendations = recommendations.filter(
    (item) => item.feasibility?.feasible
  );

  const rankingPool = feasibleRecommendations.length
    ? feasibleRecommendations
    : recommendations;

  const lowestCapex = [...rankingPool].sort(
    (a, b) => a.costMetrics.capexWan - b.costMetrics.capexWan
  )[0] || null;

  const lowestTotalCost = [...rankingPool].sort(
    (a, b) => a.costMetrics.annualTotalCostWan - b.costMetrics.annualTotalCostWan
  )[0] || null;

  const highestReliability = [...rankingPool].sort(
    (a, b) => b.validationMetrics.serviceRate - a.validationMetrics.serviceRate
  )[0] || null;

  return {
    scenarioSavingsVsBaseline: {
      offgrid_rule: buildSavingVsBaseline(offgridRule),
      offgrid_dispatch: buildSavingVsBaseline(offgridDispatch),
      grid_rule: buildSavingVsBaseline(gridRule),
      grid_dispatch: buildSavingVsBaseline(gridDispatch)
    },

    dispatchValueOffgrid: offgridRule && offgridDispatch ? {
      capexSavingWan: round(offgridRule.costMetrics.capexWan - offgridDispatch.costMetrics.capexWan, 2),
      annualCostSavingWan: round(offgridRule.costMetrics.annualTotalCostWan - offgridDispatch.costMetrics.annualTotalCostWan, 2),
      storageSavingKwh: round(offgridRule.hardwarePlan.storageKwh - offgridDispatch.hardwarePlan.storageKwh, 1),
      pcsSavingKw: round(offgridRule.hardwarePlan.pcsKw - offgridDispatch.hardwarePlan.pcsKw, 1),
      n7Saving: offgridRule.hardwarePlan.n7kw - offgridDispatch.hardwarePlan.n7kw,
      n30Saving: offgridRule.hardwarePlan.n30kw - offgridDispatch.hardwarePlan.n30kw,
      unservedReductionKwh: round(offgridRule.validationMetrics.unservedEnergyKwh - offgridDispatch.validationMetrics.unservedEnergyKwh, 1)
    } : null,

    dispatchValueGrid: gridRule && gridDispatch ? {
      capexSavingWan: round(gridRule.costMetrics.capexWan - gridDispatch.costMetrics.capexWan, 2),
      annualCostSavingWan: round(gridRule.costMetrics.annualTotalCostWan - gridDispatch.costMetrics.annualTotalCostWan, 2),
      totalCostSavingWan: round(gridRule.costMetrics.annualTotalCostWan - gridDispatch.costMetrics.annualTotalCostWan, 2),
      gridImportReductionKwh: round(gridRule.gridMetrics.gridImportKwh - gridDispatch.gridMetrics.gridImportKwh, 1),
      gridCostReductionYuan: round(gridRule.gridMetrics.gridCostYuan - gridDispatch.gridMetrics.gridCostYuan, 1),
      peakGridReductionKw: round(gridRule.gridMetrics.peakGridKw - gridDispatch.gridMetrics.peakGridKw, 1)
    } : null,

    gridAccessValueRule: offgridRule && gridRule ? {
      capexSavingWan: round(offgridRule.costMetrics.capexWan - gridRule.costMetrics.capexWan, 2),
      annualCostSavingWan: round(offgridRule.costMetrics.annualTotalCostWan - gridRule.costMetrics.annualTotalCostWan, 2),
      storageSavingKwh: round(offgridRule.hardwarePlan.storageKwh - gridRule.hardwarePlan.storageKwh, 1),
      addedGridImportKwh: round(gridRule.gridMetrics.gridImportKwh, 1),
      addedGridCostYuan: round(gridRule.gridMetrics.gridCostYuan, 1)
    } : null,

    gridAccessValueDispatch: offgridDispatch && gridDispatch ? {
      capexSavingWan: round(offgridDispatch.costMetrics.capexWan - gridDispatch.costMetrics.capexWan, 2),
      annualCostSavingWan: round(offgridDispatch.costMetrics.annualTotalCostWan - gridDispatch.costMetrics.annualTotalCostWan, 2),
      storageSavingKwh: round(offgridDispatch.hardwarePlan.storageKwh - gridDispatch.hardwarePlan.storageKwh, 1),
      addedGridImportKwh: round(gridDispatch.gridMetrics.gridImportKwh, 1),
      addedGridCostYuan: round(gridDispatch.gridMetrics.gridCostYuan, 1)
    } : null,

    lowestCapexScenario: lowestCapex?.scenarioKey || null,
    lowestAnnualCostScenario: lowestTotalCost?.scenarioKey || null,
    lowestTotalCostScenario: lowestTotalCost?.scenarioKey || null,
    highestReliabilityScenario: highestReliability?.scenarioKey || null,

    recommendedByCondition: buildRecommendedByCondition({
      offgridRule,
      offgridDispatch,
      gridRule,
      gridDispatch,
      lowestTotalCost
    }),

    recommendedForEngineering: lowestTotalCost?.scenarioKey || null,

    note: "M3 输出四个工程条件下的情景化最优配置。最终采用哪一套方案，应由是否接入电网、是否接受需求调度和成本偏好共同决定。"
  };
}

function buildScenarioCard(scenarioKey, optimum, savings) {
  const recommended = optimum?.recommendedConfig || null;

  if (!recommended) {
    return {
      scenarioKey,
      title: SCENARIO_DEFINITIONS[scenarioKey]?.label || scenarioKey,
      feasible: false,
      empty: true,
      note: "该情景暂无推荐配置。"
    };
  }

  const hardware = recommended.hardwarePlan || {};
  const validation = recommended.validationMetrics || {};
  const grid = recommended.gridMetrics || {};
  const energy = recommended.energyMetrics || {};
  const cost = recommended.costMetrics || {};

  return {
    scenarioKey,
    title: SCENARIO_DEFINITIONS[scenarioKey]?.label || scenarioKey,
    optimizationLabel: optimum.optimizationLabel,
    optimizationTarget: optimum.optimizationTarget,

    feasible: Boolean(recommended.feasibility?.feasible),
    feasibleCount: optimum.feasibleCount,
    candidateCount: optimum.evaluatedCandidates?.length || 0,

    demandProfile: optimum.demandProfile,

    hardwarePlan: hardware,
    deltas: recommended.deltas,
    savingVsBaseline: savings,

    keyMetrics: {
      annualTotalCostWan: cost.annualTotalCostWan,
      capexWan: cost.capexWan,
      extraCapexWan: cost.extraCapexWan,
      gridCostWan: cost.gridCostWan,

      serviceRate: validation.serviceRate,
      unservedEnergyKwh: validation.unservedEnergyKwh,
      deficitHours: validation.deficitHours,
      socMinPct: validation.socMinPct,

      gridImportKwh: grid.gridImportKwh,
      peakGridKw: grid.peakGridKw,
      gridCostYuan: grid.gridCostYuan,

      pvGenerationKwh: energy.pvGenerationKwh,
      pvSelfUseRate: energy.pvSelfUseRate,
      curtailmentRatePct: energy.curtailmentRatePct
    },

    feasibility: recommended.feasibility,
    searchMeta: recommended.searchMeta,

    note: recommended.feasibility?.feasible
      ? "该方案为当前候选集中满足约束后的年综合成本最低配置。"
      : "该方案未完全满足约束，仅作为当前候选集中的最优兜底结果。"
  };
}

function buildScenarioCards(result) {
  const savings = result.comparison?.scenarioSavingsVsBaseline || {};

  return SCENARIO_KEYS.map((key) => {
    return buildScenarioCard(
      key,
      result.scenarioOptimums?.[key],
      savings[key]
    );
  });
}

function buildComparisonRows(result) {
  return buildScenarioCards(result).map((card) => {
    const metrics = card.keyMetrics || {};
    const saving = card.savingVsBaseline || {};

    return {
      scenarioKey: card.scenarioKey,
      scenarioLabel: card.title,
      feasible: card.feasible,

      capexWan: metrics.capexWan,
      annualTotalCostWan: metrics.annualTotalCostWan,
      extraCapexWan: metrics.extraCapexWan,
      capexSavingWan: saving.capexSavingWan,

      pvKw: card.hardwarePlan?.pvKw ?? null,
      storageKwh: card.hardwarePlan?.storageKwh ?? null,
      pcsKw: card.hardwarePlan?.pcsKw ?? null,
      n7kw: card.hardwarePlan?.n7kw ?? null,
      n30kw: card.hardwarePlan?.n30kw ?? null,

      pvReductionKw: saving.pvReductionKw,
      storageReductionKwh: saving.storageReductionKwh,
      pcsReductionKw: saving.pcsReductionKw,
      n7Reduction: saving.n7Reduction,
      n30Reduction: saving.n30Reduction,

      serviceRate: metrics.serviceRate,
      unservedEnergyKwh: metrics.unservedEnergyKwh,
      socMinPct: metrics.socMinPct,

      gridImportKwh: metrics.gridImportKwh,
      gridCostYuan: metrics.gridCostYuan,
      curtailmentRatePct: metrics.curtailmentRatePct
    };
  });
}

function buildRecommendationCards(result) {
  const recommended = result.comparison?.recommendedByCondition || {};

  return [
    recommended.noGrid_noDispatch,
    recommended.noGrid_withDispatch,
    recommended.grid_noDispatch,
    recommended.grid_withDispatch,
    recommended.lowestAnnualCost
  ].filter(Boolean);
}

export function runM3ScenarioOptimization(context) {
  const m1 = requireBaseline(context);
  const m2 = requireM2(context);
  const params = normalizeProjectInput(context);

  const baseline = buildBaselineHardware(m1, params);
  const demandProfiles = m2.demandProfiles;

  const referenceProfile = demandProfiles.initial;
  const ticks = referenceProfile.loadCurve.length;

  if (demandProfiles.priceGuided.loadCurve.length !== ticks) {
    throw new Error(
      `M3 D0/D1 曲线长度不一致：D0=${ticks}，D1=${demandProfiles.priceGuided.loadCurve.length}。`
    );
  }

  const irradiance = buildAnnualIrradianceForM3(params, ticks);
  const candidates = generateM3Candidates(baseline, params, referenceProfile, m2);

  const scenarioOptimums = Object.fromEntries(
    SCENARIO_KEYS.map((key) => {
      const binding = SCENARIO_PROFILE_BINDINGS[key];

      if (!binding) {
        throw new Error(`M3 缺少情景 ${key} 的需求画像绑定关系。`);
      }

      const profile = demandProfiles[binding.demandProfileKey];

      if (!profile?.loadCurve?.length) {
        throw new Error(`M3 情景 ${key} 找不到需求画像：${binding.demandProfileKey}。`);
      }

      return [
        key,
        {
          ...optimizeScenario(key, candidates, profile, irradiance, params),
          optimizationLabel: binding.optimizationLabel
        }
      ];
    })
  );

  const result = {
    contract: "M3ScenarioOptimizationResult",
    summary: {
      title: "四情景配置优化与横向比较已完成",
      candidateCount: candidates.length,
      scenarioCount: SCENARIO_KEYS.length,
      horizon: "annual",
      ticks,
      source: "M2_demand_profiles"
    },
    baseline: {
      hardwarePlan: baseline,
      m2ScenarioCompare: m2.comparison || null,
      m2ScenarioSummaries: Object.fromEntries(
        SCENARIO_KEYS.map((key) => [key, m2.scenarios?.[key]?.summary || null])
      )
    },

    configurationAssessment: {
      conclusion: "M3 已基于 M2 全年 D0/D1 需求画像完成四情景最小可行配置搜索。",
      optimizationMode: "minimum_feasible_configuration",
      baselineRole: "S0 作为上游基准配置与削减参照，不再作为默认最终推荐配置。",
      selectionRule: "先满足全年服务率、未满足电量、SOC 和并网容量约束，再选择年综合成本最低的候选配置。",
      scenarioBinding: SCENARIO_PROFILE_BINDINGS
    },

    demandProfileSummary: {
      initial: {
        key: demandProfiles.initial.key,
        label: demandProfiles.initial.label,
        annualEnergyKwh: demandProfiles.initial.annualEnergyKwh,
        peakLoadKw: demandProfiles.initial.peakLoadKw
      },
      priceGuided: {
        key: demandProfiles.priceGuided.key,
        label: demandProfiles.priceGuided.label,
        annualEnergyKwh: demandProfiles.priceGuided.annualEnergyKwh,
        peakLoadKw: demandProfiles.priceGuided.peakLoadKw,
        dispatch: demandProfiles.priceGuided.dispatch
      }
    },
    candidateCount: candidates.length,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      hardwarePlan: candidate.hardwarePlan,
      deltas: candidate.deltas,
      extraCapexWan: candidate.extraCapexWan,
      searchMeta: candidate.searchMeta
    })),
    scenarioOptimums,
    weatherContext: {
      source: params.weatherSummary?.source,
      sourceLabel: params.weatherSummary?.sourceLabel,
      annualMode: true
    }
  };

  result.comparison = buildComparison(result);

  result.uiPayload = {
    scenarioCards: buildScenarioCards(result),
    comparisonRows: buildComparisonRows(result),
    recommendationCards: buildRecommendationCards(result)
  };

  return result;
}

export function runM3DispatchDiagnosis(context) {
  return runM3ScenarioOptimization(context);
}
