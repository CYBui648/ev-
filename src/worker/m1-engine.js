import {
  buildDemandProfile,
  buildHardwarePlan,
  buildIrradianceSeries,
  calcCapexWan,
  normalizeProjectInput,
  round,
  simulateEnergyScenario,
  MONTH_DAYS,
  MONTH_NAMES
} from "./scenario-core.js";

const TICK_HOURS = 0.25;
const TICKS_PER_DAY = 96;
const ANNUAL_DAYS = 365;
const M1_SEED = 20260513;
const DIRECT_EFFICIENCY = 0.92;

const SOC_MIN_PCT = 5;
const SERVICE_RATE_MIN = 0.995;
const UNSERVED_RATE_TOLERANCE = 0.002;

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function sumPowerSeriesKwh(series) {
  return (series || []).reduce((sum, kw) => {
    return sum + toFiniteNumber(kw, 0) * TICK_HOURS;
  }, 0);
}

function percentile(values, p) {
  const clean = (values || [])
    .map((value) => toFiniteNumber(value, 0))
    .filter((value) => Number.isFinite(value));

  if (!clean.length) return 0;

  const sorted = [...clean].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((sorted.length - 1) * p))
  );

  return sorted[index];
}

function uniqueNumbers(values) {
  return [...new Set(
    values
      .map((value) => Math.max(0, Math.round(value)))
      .filter((value) => Number.isFinite(value))
  )].sort((a, b) => a - b);
}

function scaledValues(baseValue, factors, {
  minValue = 0,
  maxValue = Infinity,
  roundTo = 1
} = {}) {
  const base = Math.max(0, toFiniteNumber(baseValue, 0));

  const values = factors.map((factor) => {
    const raw = base * factor;
    const rounded = roundTo > 1
      ? Math.round(raw / roundTo) * roundTo
      : Math.round(raw);

    return Math.max(minValue, Math.min(maxValue, rounded));
  });

  return uniqueNumbers(values);
}

function calcLcoeYuanPerKwh(
  capexWan,
  annualDemandKwh,
  annualGridCostYuan = 0,
  opexRate = 0.015
) {
  const annualizedCostYuan =
    capexWan * 10000 * 0.085 +
    capexWan * 10000 * opexRate +
    annualGridCostYuan;

  return annualDemandKwh > 0 ? annualizedCostYuan / annualDemandKwh : 0;
}

function calcAnnualCostWan(capexWan, annualGridCostYuan = 0, opexRate = 0.015) {
  const annualizedCapexWan = capexWan * 0.085;
  const annualOpexWan = capexWan * opexRate;
  const gridCostWan = annualGridCostYuan / 10000;

  return {
    annualizedCapexWan,
    annualOpexWan,
    gridCostWan,
    annualTotalCostWan: annualizedCapexWan + annualOpexWan + gridCostWan
  };
}

function buildAnnualDemandForM1(params) {
  return buildDemandProfile(params, {
    days: ANNUAL_DAYS,
    seed: M1_SEED
  });
}

function buildAnnualIrradianceForM1(params, ticks) {
  return buildIrradianceSeries(params, ticks, {
    monthIndex: 0,
    useGTilt: params.gTiltData?.length >= 8760,
    annualMode: true
  });
}

function calcPvYieldPerKwKwh(irradiance, params) {
  const pvEfficiency = toFiniteNumber(params.pvEfficiency, 0.72);

  return (irradiance || []).reduce((sum, g) => {
    return sum + Math.max(0, toFiniteNumber(g, 0)) * pvEfficiency * DIRECT_EFFICIENCY * TICK_HOURS;
  }, 0);
}

function estimateAnchorConfig(params, demand, irradiance) {
  const annualDemandKwh = Math.max(1, sumPowerSeriesKwh(demand.loadCurve));
  const avgDailyDemandKwh = annualDemandKwh / ANNUAL_DAYS;
  const p95LoadKw = percentile(demand.loadCurve, 0.95);
  const peakLoadKw = Math.max(10, demand.peakLoadKw || p95LoadKw);
  const pvYieldPerKwKwh = Math.max(1, calcPvYieldPerKwKwh(irradiance, params));

  const roofPvMax = params.roofArea > 0
    ? params.roofArea / 6.5
    : Math.max(40, annualDemandKwh / pvYieldPerKwKwh * 2);

  const sizingRenewableTarget = Math.max(0.65, params.renewableTarget || 0.5);

  const pvAnchor = Math.min(
    roofPvMax,
    Math.max(
      60,
      annualDemandKwh * sizingRenewableTarget / pvYieldPerKwKwh
    )
  );

  const storageAnchor = Math.max(
    80,
    avgDailyDemandKwh * 1.35
  );

  const pcsAnchor = Math.max(
    30,
    p95LoadKw * 1.05,
    peakLoadKw * 0.75,
    storageAnchor / 2.5
  );

  return buildHardwarePlan({
    pvKw: Math.ceil(pvAnchor / 10) * 10,
    storageKwh: Math.ceil(storageAnchor / 50) * 50,
    pcsKw: Math.ceil(pcsAnchor / 10) * 10,
    n7kw: demand.pilePlan?.n7kw || 0,
    n30kw: demand.pilePlan?.n30kw || 0,
    transformerLimitKw: params.transformerLimitKw
  });
}

function generateM1Candidates(anchor, params) {
  const roofPvMax = params.roofArea > 0
    ? params.roofArea / 6.5
    : anchor.pvKw * 2;

  const pvValues = scaledValues(anchor.pvKw, [1.00, 1.15, 1.30, 1.50, 1.75], {
    minValue: Math.min(20, anchor.pvKw),
    maxValue: roofPvMax,
    roundTo: 10
  });

  const storageValues = scaledValues(anchor.storageKwh, [1.00, 1.25, 1.50, 1.75, 2.00], {
    minValue: anchor.storageKwh > 0 ? 50 : 0,
    roundTo: 50
  });

  const pcsValues = scaledValues(anchor.pcsKw, [1.00, 1.15, 1.30, 1.50, 1.75], {
    minValue: anchor.pcsKw > 0 ? 20 : 0,
    roundTo: 10
  });

  const candidates = [];

  pvValues.forEach((pvKw) => {
    storageValues.forEach((storageKwh) => {
      pcsValues.forEach((pcsKw) => {
        candidates.push(buildHardwarePlan({
          pvKw,
          storageKwh,
          pcsKw,
          n7kw: anchor.n7kw,
          n30kw: anchor.n30kw,
          transformerLimitKw: params.transformerLimitKw
        }));
      });
    });
  });

  return candidates;
}

function feasibilityForM1(summary) {
  const serviceRate = toFiniteNumber(summary.serviceRate, 0);
  const unservedEnergyKwh = toFiniteNumber(summary.unservedEnergyKwh, 0);
  const demandKwh = toFiniteNumber(summary.demandKwh, 0);
  const socMinPct = toFiniteNumber(summary.socMinPct, 0);

  const unservedToleranceKwh = Math.max(1, demandKwh * UNSERVED_RATE_TOLERANCE);
  const serviceShortfall = Math.max(0, SERVICE_RATE_MIN - serviceRate);
  const unservedViolationKwh = Math.max(0, unservedEnergyKwh - unservedToleranceKwh);
  const socViolationPct = Math.max(0, SOC_MIN_PCT - socMinPct);

  const feasible =
    serviceRate >= SERVICE_RATE_MIN &&
    unservedEnergyKwh <= unservedToleranceKwh &&
    socMinPct >= SOC_MIN_PCT;

  const violationScore =
    serviceShortfall * 10000 +
    unservedViolationKwh * 10 +
    socViolationPct * 100;

  return {
    feasible,
    serviceOk: serviceRate >= SERVICE_RATE_MIN,
    unservedOk: unservedEnergyKwh <= unservedToleranceKwh,
    socOk: socMinPct >= SOC_MIN_PCT,

    serviceRateMin: SERVICE_RATE_MIN,
    socMinPctMin: SOC_MIN_PCT,
    unservedToleranceKwh: round(unservedToleranceKwh, 1),

    serviceShortfall: round(serviceShortfall, 6),
    unservedViolationKwh: round(unservedViolationKwh, 3),
    socViolationPct: round(socViolationPct, 3),
    violationScore: round(violationScore, 3)
  };
}

function buildCandidateScore(candidate, simulation, params) {
  const summary = simulation.summary;
  const capex = calcCapexWan(candidate, params);
  const annualCost = calcAnnualCostWan(
    capex.capexWan,
    summary.gridCostYuan || 0,
    params.opexRate
  );

  const demandKwh = toFiniteNumber(summary.demandKwh, 0);
  const pvToLoadKwh = toFiniteNumber(summary.pvToLoadKwh, 0);
  const batteryToLoadKwh = toFiniteNumber(summary.batteryToLoadKwh, 0);
  const pvGenerationKwh = toFiniteNumber(summary.pvGenerationKwh, 0);
  const renewableUsedKwh = pvToLoadKwh + batteryToLoadKwh;

  const renewableSupplyRate = ratio(renewableUsedKwh, demandKwh);
  const pvSelfUseRate = ratio(renewableUsedKwh, pvGenerationKwh);
  const lcoeYuanPerKwh = calcLcoeYuanPerKwh(
    capex.capexWan,
    demandKwh,
    summary.gridCostYuan || 0,
    params.opexRate
  );

  return {
    capex,
    annualCost,

    demandKwh,
    unservedEnergyKwh: toFiniteNumber(summary.unservedEnergyKwh, 0),
    unservedRate: ratio(summary.unservedEnergyKwh || 0, demandKwh),
    serviceRate: toFiniteNumber(summary.serviceRate, 0),
    deficitHours: toFiniteNumber(summary.deficitHours, 0),
    socMinPct: toFiniteNumber(summary.socMinPct, 0),

    pvGenerationKwh,
    pvToLoadKwh,
    batteryToLoadKwh,
    curtailmentKwh: toFiniteNumber(summary.curtailmentKwh, 0),
    curtailmentRatePct: toFiniteNumber(summary.curtailmentRatePct, 0),

    pvSelfUseRate,
    renewableSupplyRate,
    renewableShortfall: Math.max(0, (params.renewableTarget || 0) - renewableSupplyRate),

    lcoeYuanPerKwh,
    annualTotalCostWan: annualCost.annualTotalCostWan
  };
}

function evaluateM1Candidate(candidate, demand, irradiance, params) {
  const simulation = simulateEnergyScenario({
    hardware: candidate,
    loadCurve: demand.loadCurve,
    irradiance,
    params,
    scenarioKey: "offgrid_rule"
  });

  const score = buildCandidateScore(candidate, simulation, params);
  const feasibility = feasibilityForM1(simulation.summary);

  return {
    candidate,
    simulation,
    score,
    feasibility
  };
}

function isBetterM1Candidate(next, best) {
  if (!best) return true;

  const nf = next.feasibility.feasible;
  const bf = best.feasibility.feasible;

  if (nf && !bf) return true;
  if (!nf && bf) return false;

  if (!nf && !bf) {
    if (next.feasibility.violationScore < best.feasibility.violationScore - 1e-6) return true;
    if (next.feasibility.violationScore > best.feasibility.violationScore + 1e-6) return false;
  }

  if (nf && bf) {
    if (next.score.socMinPct > best.score.socMinPct + 0.2) return true;
    if (next.score.socMinPct < best.score.socMinPct - 0.2) return false;

    if (next.score.unservedEnergyKwh < best.score.unservedEnergyKwh - 1) return true;
    if (next.score.unservedEnergyKwh > best.score.unservedEnergyKwh + 1) return false;

    if (next.score.serviceRate > best.score.serviceRate + 0.0005) return true;
    if (next.score.serviceRate < best.score.serviceRate - 0.0005) return false;
  }

  const nextLcoe = next.score.lcoeYuanPerKwh;
  const bestLcoe = best.score.lcoeYuanPerKwh;

  if (nextLcoe < bestLcoe - 0.001) return true;
  if (nextLcoe > bestLcoe + 0.001) return false;

  if (next.score.annualTotalCostWan < best.score.annualTotalCostWan - 0.01) return true;
  if (next.score.annualTotalCostWan > best.score.annualTotalCostWan + 0.01) return false;

  return next.score.capex.capexWan < best.score.capex.capexWan;
}

function chooseInitialSizing(params, demand, irradiance) {
  const anchor = estimateAnchorConfig(params, demand, irradiance);
  const candidates = generateM1Candidates(anchor, params);

  let best = null;

  candidates.forEach((candidate) => {
    const evaluated = evaluateM1Candidate(candidate, demand, irradiance, params);

    if (isBetterM1Candidate(evaluated, best)) {
      best = evaluated;
    }
  });

  return {
    ...best,
    anchor,
    candidates,
    candidateCount: candidates.length
  };
}

function sliceByMonth(series, monthIndex) {
  let offset = 0;

  for (let i = 0; i < monthIndex; i++) {
    offset += (MONTH_DAYS[i] || 30) * TICKS_PER_DAY;
  }

  const days = MONTH_DAYS[monthIndex] || 30;
  const ticks = days * TICKS_PER_DAY;

  return (series || []).slice(offset, offset + ticks);
}

function minSeriesValue(series, fallback = 0) {
  if (!series?.length) return fallback;

  return series.reduce((min, value) => {
    return Math.min(min, toFiniteNumber(value, fallback));
  }, Number.POSITIVE_INFINITY);
}

function maxSeriesValue(series, fallback = 0) {
  if (!series?.length) return fallback;

  return series.reduce((max, value) => {
    return Math.max(max, toFiniteNumber(value, fallback));
  }, 0);
}

function summarizeMonthlyFromAnnualSimulation(simulation) {
  const chartData = simulation.chartData || {};
  const monthlyChecks = [];

  for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
    const days = MONTH_DAYS[monthIndex] || 30;

    const ev = sliceByMonth(chartData.ev || [], monthIndex);
    const pv = sliceByMonth(chartData.pv || [], monthIndex);
    const soc = sliceByMonth(chartData.soc || [], monthIndex);
    const unserved = sliceByMonth(chartData.unserved || [], monthIndex);
    const curtailed = sliceByMonth(chartData.curtailed || [], monthIndex);

    const demandKwh = sumPowerSeriesKwh(ev);
    const pvGenerationKwh = sumPowerSeriesKwh(pv);
    const unservedKwh = sumPowerSeriesKwh(unserved);
    const curtailmentKwh = sumPowerSeriesKwh(curtailed);
    const deliveredKwh = Math.max(0, demandKwh - unservedKwh);
    const serviceRate = demandKwh > 0 ? deliveredKwh / demandKwh : 1;
    const socMinPct = minSeriesValue(soc, 100);

    monthlyChecks.push({
      monthIndex,
      monthName: MONTH_NAMES[monthIndex],
      days,
      weight: days / 365,

      demandKwhMonth: round(demandKwh, 1),
      unservedKwhMonth: round(unservedKwh, 1),

      // 兼容旧 UI 字段名，下一轮前端再改名
      demandKwhWeek: round(demandKwh, 1),
      unservedKwhWeek: round(unservedKwh, 1),

      unservedRate: round(ratio(unservedKwh, demandKwh), 5),
      serviceRate: round(serviceRate, 5),
      socMinPct: round(Number.isFinite(socMinPct) ? socMinPct : 0, 1),

      pvGenerationKwh: round(pvGenerationKwh, 1),
      curtailmentKwh: round(curtailmentKwh, 1),
      curtailmentRatePct: pvGenerationKwh > 0
        ? round(curtailmentKwh / pvGenerationKwh * 100, 2)
        : 0,

      peakLoadKw: round(maxSeriesValue(ev), 1)
    });
  }

  const worstMonth = monthlyChecks.reduce((worst, item) => {
    if (!worst) return item;

    if (item.unservedRate > worst.unservedRate + 1e-6) return item;
    if (item.unservedRate < worst.unservedRate - 1e-6) return worst;

    if (item.unservedKwhMonth > worst.unservedKwhMonth + 1e-6) return item;
    if (item.unservedKwhMonth < worst.unservedKwhMonth - 1e-6) return worst;

    if (item.socMinPct < worst.socMinPct) return item;

    return worst;
  }, null);

  const summary = simulation.summary || {};

  return {
    checkType: "annual_tmy_monthly_validation",
    monthlyChecks,

    annualDemandKwh: round(summary.demandKwh, 1),
    annualEquivalentUnservedKwh: round(summary.unservedEnergyKwh, 1),
    unservedRate: round(ratio(summary.unservedEnergyKwh || 0, summary.demandKwh || 0), 5),
    serviceRate: round(summary.serviceRate, 5),
    deficitHours: round(summary.deficitHours, 1),
    socMinPct: round(summary.socMinPct, 1),

    worstMonthIndex: worstMonth?.monthIndex ?? 0,
    worstMonthName: worstMonth?.monthName || MONTH_NAMES[0],
    worstMonthUnservedKwh: round(worstMonth?.unservedKwhMonth || 0, 1),
    worstMonthUnservedRate: round(worstMonth?.unservedRate || 0, 5),
    worstMonthDeficitHours: 0,
    worstMonthSocMinPct: round(worstMonth?.socMinPct || 0, 1),

    pvGenerationAnnualKwh: round(summary.pvGenerationKwh, 1),
    curtailmentKwh: round(summary.curtailmentKwh, 1),
    curtailmentRatePct: round(summary.curtailmentRatePct, 2),
    pvSelfUseRate: round(summary.pvSelfUseRate, 5),

    renewableSupplyRate: round(
      ratio((summary.pvToLoadKwh || 0) + (summary.batteryToLoadKwh || 0), summary.demandKwh || 0),
      5
    )
  };
}

function buildM1ChartData(demand, simulation) {
  return {
    pv: simulation.chartData.pv,
    ev: demand.loadCurve,
    rawDemand: demand.rawLoadCurve,
    soc: simulation.chartData.soc,
    fastOcc: demand.fastOccupancy,
    slowOcc: demand.slowOccupancy,
    rawFastOcc: demand.rawFastOccupancy,
    rawSlowOcc: demand.rawSlowOccupancy
  };
}

function buildDemandProfileSummary(demand) {
  return {
    ...demand,

    key: "D0",
    label: "全年用户初始需求画像",
    description: "M1 使用全年用户自然充电需求 D0 进行 S0 初始定容。",

    annualizedForTmy: true,
    annualDemandKwh: round(sumPowerSeriesKwh(demand.loadCurve), 1),
    annualTicks: demand.loadCurve?.length || 0,
    tickMinutes: 15,

    totalWeekKwh: null,
    sourceProfile: "annual_d0"
  };
}

export function runM1Plan(context) {
  const params = normalizeProjectInput(context);

  const demand = buildAnnualDemandForM1(params);
  const irradiance = buildAnnualIrradianceForM1(params, demand.loadCurve.length);

  const selected = chooseInitialSizing(params, demand, irradiance);

  const hardware = selected.candidate;
  const simulation = selected.simulation;
  const summary = simulation.summary;
  const score = selected.score;
  const feasibility = selected.feasibility;

  const capex = calcCapexWan(hardware, params);
  const lcoe = score.lcoeYuanPerKwh;
  const monthlyValidation = summarizeMonthlyFromAnnualSimulation(simulation);

  const baselineWeatherType = params.gTiltData?.length >= 8760
    ? "annual_native_tmy"
    : "annual_synthetic_weather";

  const weatherModeLabel = params.gTiltData?.length >= 8760
    ? "8760 小时 TMY 原生全年气象"
    : "城市气象参数生成的全年序列";

  return {
    contract: "M1Result",
    baseConfigType: "s0_initial_sizing_annual_d0_tmy",

    summary: {
      title: "S0 全年数据驱动初始配置已生成",
      city: params.climate.city,
      climateZone: params.climate.zone,
      candidateCount: selected.candidateCount,
      renewableTarget: params.renewableTarget,

      horizonDays: demand.horizonDays,
      ticks: demand.loadCurve.length,
      weatherMode: baselineWeatherType,
      weatherModeLabel,
      sizingMethod: "anchor_local_search",
      selectionRule: "M1 以全年 D0 与 TMY 生成偏稳健的 S0 初始配置，优先保证离网服务率、SOC 安全和低未满足电量；M3 再以 S0 为参照削减冗余或必要补强。"
    },

    hardwarePlan: {
      ...hardware,
      pvAreaM2: round(hardware.pvKw * 6.5, 1)
    },

    anchorPlan: {
      ...selected.anchor,
      pvAreaM2: round(selected.anchor.pvKw * 6.5, 1)
    },

    economics: {
      ...capex,
      annualizedCapexWan: round(score.annualCost.annualizedCapexWan, 2),
      annualOpexWan: round(score.annualCost.annualOpexWan, 2),
      annualTotalCostWan: round(score.annualCost.annualTotalCostWan, 2),
      lcoeYuanPerKwh: round(lcoe, 3)
    },

    baselineMatch: {
      baselineWeatherType,
      baselineDemandType: "annual_d0",

      baselineDemandKwh: round(summary.demandKwh, 1),
      baselineUnservedKwh: round(summary.unservedEnergyKwh, 1),
      baselineUnservedRate: round(ratio(summary.unservedEnergyKwh || 0, summary.demandKwh || 0), 5),

      annualDemandKwh: round(summary.demandKwh, 1),
      annualEquivalentUnservedKwh: round(summary.unservedEnergyKwh, 1),
      annualUnservedRate: round(ratio(summary.unservedEnergyKwh || 0, summary.demandKwh || 0), 5),

      serviceRate: round(summary.serviceRate, 5),
      deficitHours: round(summary.deficitHours, 1),
      socMinPct: round(summary.socMinPct, 1),

      pvSelfUseRate: round(summary.pvSelfUseRate, 5),
      renewableSupplyRate: round(score.renewableSupplyRate, 5),
      renewableShortfall: round(score.renewableShortfall, 5),
      curtailmentRatePct: round(summary.curtailmentRatePct, 2),

      capexWan: capex.capexWan,
      annualTotalCostWan: round(score.annualTotalCostWan, 2),
      lcoeYuanPerKwh: round(lcoe, 3),

      feasible: feasibility.feasible,
      feasibility
    },

    offgridBaselineCheck: {
      checkType: "annual_d0_tmy_offgrid_initial_sizing",
      baselineWeatherType,

      annualEquivalentUnservedKwh: round(summary.unservedEnergyKwh, 1),
      unservedKwh: round(summary.unservedEnergyKwh, 1),
      unservedRate: round(ratio(summary.unservedEnergyKwh || 0, summary.demandKwh || 0), 5),

      deficitHours: round(summary.deficitHours, 1),
      serviceRate: round(summary.serviceRate, 5),
      socMinPct: round(summary.socMinPct, 1),

      pvGenerationAnnualKwh: round(summary.pvGenerationKwh, 1),
      pvDirectToLoadKwh: round(summary.pvToLoadKwh, 1),
      batteryToLoadKwh: round(summary.batteryToLoadKwh, 1),
      curtailmentKwh: round(summary.curtailmentKwh, 1),
      curtailmentRatePct: round(summary.curtailmentRatePct, 2),

      pvSelfUseRate: round(summary.pvSelfUseRate, 5),
      renewableSupplyRate: round(score.renewableSupplyRate, 5),
      renewableShare: round(score.renewableSupplyRate, 5),

      totalLoadEnergyAnnualKwh: round(summary.demandKwh, 1),
      lcoeYuanPerKwh: round(lcoe, 3),

      feasible: feasibility.feasible,
      feasibility
    },

    monthlyAdaptationCheck: monthlyValidation,

    demandProfile: buildDemandProfileSummary(demand),

    chartData: buildM1ChartData(demand, simulation),

    weatherSummary: {
      ...params.weatherSummary,
      simulationWeatherMode: baselineWeatherType,
      simulationWeatherModeLabel: weatherModeLabel
    }
  };
}
