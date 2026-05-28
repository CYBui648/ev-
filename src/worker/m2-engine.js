import {
  buildDemandProfile,
  buildHardwarePlan,
  normalizeProjectInput,
  round,
  runScenarioSet,
  selectPressureMonth,
  MONTH_DAYS,
  MONTH_NAMES,
  SCENARIO_KEYS
} from "./scenario-core.js";

function requireM1(context) {
  const m1 = context.previousResults?.m1;
  if (!m1?.hardwarePlan) {
    throw new Error("M2 缺少 M1Result，无法读取 S0 基准配置。");
  }
  return m1;
}

function buildHardwareFromM1(m1, params) {
  return buildHardwarePlan({
    pvKw: m1.hardwarePlan.pvKw,
    storageKwh: m1.hardwarePlan.storageKwh,
    pcsKw: m1.hardwarePlan.pcsKw,
    n7kw: m1.hardwarePlan.n7kw,
    n30kw: m1.hardwarePlan.n30kw,
    transformerLimitKw: params.transformerLimitKw
  });
}

function buildComparison(scenarios) {
  const offgridRule = scenarios.offgrid_rule?.summary || {};
  const offgridDispatch = scenarios.offgrid_dispatch?.summary || {};
  const gridRule = scenarios.grid_rule?.summary || {};
  const gridDispatch = scenarios.grid_dispatch?.summary || {};
  const reliabilityRank = Object.values(scenarios).sort((a, b) =>
    (b.summary.serviceRate || 0) - (a.summary.serviceRate || 0)
  );
  const costRank = Object.values(scenarios).sort((a, b) =>
    (a.summary.totalCostWan ?? Infinity) - (b.summary.totalCostWan ?? Infinity)
  );

  return {
    dispatchGainOffgrid: {
      unservedReductionKwh: round((offgridRule.unservedEnergyKwh || 0) - (offgridDispatch.unservedEnergyKwh || 0), 1),
      deficitHourReduction: round((offgridRule.deficitHours || 0) - (offgridDispatch.deficitHours || 0), 1),
      serviceRateGain: round((offgridDispatch.serviceRate || 0) - (offgridRule.serviceRate || 0), 5)
    },
    dispatchGainGrid: {
      gridImportReductionKwh: round((gridRule.gridImportKwh || 0) - (gridDispatch.gridImportKwh || 0), 1),
      gridCostReductionYuan: round((gridRule.gridCostYuan || 0) - (gridDispatch.gridCostYuan || 0), 1),
      peakGridReductionKw: round((gridRule.peakGridKw || 0) - (gridDispatch.peakGridKw || 0), 1),
      serviceRateGain: round((gridDispatch.serviceRate || 0) - (gridRule.serviceRate || 0), 5)
    },
    gridAccessGain: {
      unservedReductionKwh: round((offgridRule.unservedEnergyKwh || 0) - (gridRule.unservedEnergyKwh || 0), 1),
      serviceRateGain: round((gridRule.serviceRate || 0) - (offgridRule.serviceRate || 0), 5),
      addedGridImportKwh: round(gridRule.gridImportKwh || 0, 1),
      addedGridCostYuan: round(gridRule.gridCostYuan || 0, 1)
    },
    bestScenarioByReliability: reliabilityRank[0]?.scenario?.key || null,
    bestScenarioByCost: costRank[0]?.scenario?.key || null
  };
}

function buildRiskHandoff(scenarios) {
  const offgridRule = scenarios.offgrid_rule?.summary || {};
  const gridRule = scenarios.grid_rule?.summary || {};
  return {
    offgridMainRisk:
      (offgridRule.unservedEnergyKwh || 0) > 1
        ? "离网侧存在未满足电量，M3 应重点评估 PV、储能与 PCS 扩容。"
        : "离网侧基准配置基本可运行，M3 可重点比较调度带来的硬件节省。",
    gridMainRisk:
      (gridRule.gridDependencyRate || 0) > 0.25
        ? "并网侧电网依赖较高，M3 应重点评估储能削峰与 PV 自用率提升。"
        : "并网侧电网依赖可控，M3 可重点比较综合成本。",
    hasOffgridReliabilityRisk: (offgridRule.unservedEnergyKwh || 0) > 1 || (offgridRule.socMinPct ?? 100) < 8,
    hasGridDependencyRisk: (gridRule.gridDependencyRate || 0) > 0.25 || (gridRule.peakGridKw || 0) > 0
  };
}

function buildCompatRiskReport(scenario) {
  const summary = scenario?.summary || {};
  return {
    realPeakKw: summary.peakLoadKw || 0,
    overflowCount: summary.peakGridKw > 0 ? 1 : 0,
    blackoutCount: summary.deficitHours || 0,
    queueUnmetKwh: 0,
    energyUnmetKwh: summary.unservedEnergyKwh || 0,
    unmetTotalKwh: summary.unservedEnergyKwh || 0,
    abandonedCount: 0,
    socMinPct: summary.socMinPct ?? 100
  };
}

export function runM2ScenarioCompare(context) {
  const m1 = requireM1(context);
  const params = normalizeProjectInput(context);

  // M2 主体改为全年仿真；压力月只保留为诊断字段
  const predictedPressureMonthIndex = selectPressureMonth(params);
  const annualDays = 365;

  const hardware = buildHardwareFromM1(m1, params);

  // D0：全年用户初始需求画像，暂不做需求侧调度
  const demand = buildDemandProfile(params, {
    days: annualDays,
    seed: 20260513,
    pilePlan: {
      n7kw: hardware.n7kw,
      n30kw: hardware.n30kw
    }
  });

  const scenarios = runScenarioSet({
    hardware,
    demand,
    params,
    monthIndex: predictedPressureMonthIndex,
    useGTilt: params.gTiltData?.length >= 8760,
    annualMode: true
  });

  const comparison = buildComparison(scenarios);

  return {
    contract: "M2AnnualScenarioCompareResult",

    summary: {
      title: "S0 全年四情景运行评价已完成",

      horizonType: "annual",
      annualDays,
      ticks: demand.loadCurve.length,
      tickMinutes: 15,

      predictedPressureMonthName: MONTH_NAMES[predictedPressureMonthIndex],
      predictedPressureMonthIndex,
      predictedPressureMonthDays: MONTH_DAYS[predictedPressureMonthIndex] || 30,

      // 兼容旧版 UI：后续 M2 UI 重构时删除
      monthName: "全年",
      monthIndex: predictedPressureMonthIndex,
      pressureMonthDays: annualDays,

      transformerLimitKw: params.transformerLimitKw,
      usesM1Hardware: true,
      scenarioCount: SCENARIO_KEYS.length
    },

    horizon: {
      type: "annual",
      days: annualDays,
      ticks: demand.loadCurve.length,
      tickMinutes: 15,
      expectedTicks: annualDays * 96
    },

    weatherSummary: {
      ...params.weatherSummary,

      simulationWeatherMode: params.gTiltData?.length
        ? "annual_native_gtilt"
        : "annual_fallback_synthetic",

      predictedPressureMonthMethod: params.monthMode === "manual"
        ? "manual"
        : "school_pressure_score",
      predictedPressureMonthIndex,
      predictedPressureMonthName: MONTH_NAMES[predictedPressureMonthIndex],
      predictedPressureMonthDailyHPS:
        params.weather?.monthlyHPS?.[predictedPressureMonthIndex] ?? null,

      // 兼容旧版 UI：后续 M2 UI 重构时删除
      selectedMonthMethod: params.monthMode === "manual"
        ? "manual"
        : "school_pressure_score",
      selectedMonthIndex: predictedPressureMonthIndex,
      selectedMonthName: MONTH_NAMES[predictedPressureMonthIndex],
      selectedMonthDailyHPS:
        params.weather?.monthlyHPS?.[predictedPressureMonthIndex] ?? null
    },

    hardwareSnapshot: hardware,

    demandSnapshot: {
      profileKey: "D0",
      profileLabel: "全年用户初始需求画像",
      horizonDays: annualDays,
      ticks: demand.loadCurve.length,

      annualEnergyKwh: round(demand.totalEnergyKwh, 1),
      averageDailyEnergyKwh: round(demand.totalEnergyKwh / annualDays, 1),
      peakLoadKw: round(demand.peakLoadKw, 1),

      eventCount: demand.events.length,
      queueUnmetKwh: round(demand.queueUnmetKwh, 1),
      abandonedCount: demand.abandonedCount
    },

    scenarios,
    comparison,

    riskReport: buildCompatRiskReport(scenarios.offgrid_rule),

    energyLedger: {
      demandEnergyKwh: scenarios.offgrid_rule.summary.demandKwh,
      deliveredEnergyKwh: scenarios.offgrid_rule.summary.deliveredKwh,
      eBuyValleyKwh: scenarios.grid_rule.summary.gridValleyKwh,
      eBuyFlatKwh: scenarios.grid_rule.summary.gridFlatKwh,
      eBuyPeakKwh: scenarios.grid_rule.summary.gridPeakKwh,
      gridCostYuan: scenarios.grid_rule.summary.gridCostYuan,
      curtailmentRatePct: scenarios.offgrid_rule.summary.curtailmentRatePct
    },

    handoffToM3: buildRiskHandoff(scenarios),

    chartData: scenarios.offgrid_rule.chartData,

    sourceParams: {
      horizonType: "annual",
      annualDays,
      predictedPressureMonthIndex,
      predictedPressureMonthLabel: MONTH_NAMES[predictedPressureMonthIndex],
      transformerLimitKw: params.transformerLimitKw,
      teacherRatio: params.teacherRatio,
      anxietyRatio: params.anxietyRatio
    },

    upstreamM1Summary: {
      pvKw: m1.hardwarePlan.pvKw,
      storageKwh: m1.hardwarePlan.storageKwh,
      pcsKw: m1.hardwarePlan.pcsKw
    }
  };
}

export function runM2StressTest(context) {
  return runM2ScenarioCompare(context);
}
