import {
  buildDemandProfile,
  buildHardwarePlan,
  normalizeProjectInput,
  round,
  buildIrradianceSeries,
  simulateEnergyScenario,
  getTouPrice,
  selectPressureMonth,
  MONTH_DAYS,
  MONTH_NAMES,
  SCENARIO_KEYS
} from "./scenario-core.js";

const TICKS_PER_DAY = 96;
const TICK_HOURS = 0.25;

const SCENARIO_PROFILE_BINDINGS = {
  offgrid_rule: {
    demandProfileKey: "initial",
    scenarioLogicLabel: "离网 + D0 初始需求"
  },
  offgrid_dispatch: {
    demandProfileKey: "priceGuided",
    scenarioLogicLabel: "离网 + D1 微网电价引导需求"
  },
  grid_rule: {
    demandProfileKey: "initial",
    scenarioLogicLabel: "入网 + D0 初始需求"
  },
  grid_dispatch: {
    demandProfileKey: "priceGuided",
    scenarioLogicLabel: "入网 + D1 微网电价引导需求"
  }
};

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

function summarizeMonthlyDemand(loadCurve) {
  const monthlyDemand = [];
  let offset = 0;

  for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
    const days = MONTH_DAYS[monthIndex] || 30;
    const ticks = days * TICKS_PER_DAY;
    const slice = loadCurve.slice(offset, offset + ticks);

    const energyKwh = slice.reduce((sum, kw) => {
      return sum + (Number.isFinite(Number(kw)) ? Number(kw) : 0) * TICK_HOURS;
    }, 0);

    const peakLoadKw = slice.reduce((max, kw) => {
      const value = Number.isFinite(Number(kw)) ? Number(kw) : 0;
      return Math.max(max, value);
    }, 0);

    monthlyDemand.push({
      monthIndex,
      monthName: MONTH_NAMES[monthIndex],
      days,
      demandKwh: round(energyKwh, 1),
      averageDailyKwh: round(energyKwh / days, 1),
      peakLoadKw: round(peakLoadKw, 1)
    });

    offset += ticks;
  }

  return monthlyDemand;
}

function sliceByMonth(series, monthIndex) {
  let offset = 0;
  for (let i = 0; i < monthIndex; i++) {
    offset += (MONTH_DAYS[i] || 30) * TICKS_PER_DAY;
  }

  const days = MONTH_DAYS[monthIndex] || 30;
  const ticks = days * TICKS_PER_DAY;
  return series.slice(offset, offset + ticks);
}

function sumPowerSeriesKwh(series) {
  return series.reduce((sum, kw) => {
    return sum + toFiniteNumber(kw, 0) * TICK_HOURS;
  }, 0);
}

function minSeriesValue(series, fallback = 0) {
  if (!series.length) return fallback;
  return series.reduce((min, value) => {
    return Math.min(min, toFiniteNumber(value, fallback));
  }, Number.POSITIVE_INFINITY);
}

function maxSeriesValue(series, fallback = 0) {
  if (!series.length) return fallback;
  return series.reduce((max, value) => {
    return Math.max(max, toFiniteNumber(value, fallback));
  }, 0);
}

function summarizeScenarioMonthlyMetrics(scenarioResult) {
  const chartData = scenarioResult.chartData || {};
  const monthlyMetrics = [];

  for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
    const days = MONTH_DAYS[monthIndex] || 30;

    const ev = sliceByMonth(chartData.ev || [], monthIndex);
    const pv = sliceByMonth(chartData.pv || [], monthIndex);
    const soc = sliceByMonth(chartData.soc || [], monthIndex);
    const grid = sliceByMonth(chartData.grid || [], monthIndex);
    const gridCost = sliceByMonth(chartData.gridCost || [], monthIndex);
    const internalDeficit = sliceByMonth(chartData.internalDeficit || [], monthIndex);
    const unserved = sliceByMonth(chartData.unserved || [], monthIndex);
    const curtailed = sliceByMonth(chartData.curtailed || [], monthIndex);

    const demandKwh = sumPowerSeriesKwh(ev);
    const pvGenerationKwh = sumPowerSeriesKwh(pv);
    const gridImportKwh = sumPowerSeriesKwh(grid);
    const internalDeficitKwh = sumPowerSeriesKwh(internalDeficit);
    const unservedEnergyKwh = sumPowerSeriesKwh(unserved);
    const curtailmentKwh = sumPowerSeriesKwh(curtailed);
    const gridCostYuan = gridCost.reduce((sum, yuan) => {
      return sum + toFiniteNumber(yuan, 0);
    }, 0);

    const deliveredKwh = Math.max(0, demandKwh - unservedEnergyKwh);

    monthlyMetrics.push({
      monthIndex,
      monthName: MONTH_NAMES[monthIndex],
      days,

      demandKwh: round(demandKwh, 1),
      deliveredKwh: round(deliveredKwh, 1),
      serviceRate: demandKwh > 0 ? round(deliveredKwh / demandKwh, 5) : 1,

      pvGenerationKwh: round(pvGenerationKwh, 1),

      internalDeficitKwh: round(internalDeficitKwh, 1),
      internalDeficitHours: round(
        internalDeficit.filter((kw) => toFiniteNumber(kw, 0) > 1e-6).length * TICK_HOURS,
        1
      ),
      unservedEnergyKwh: round(unservedEnergyKwh, 1),
      deficitHours: round(
        unserved.filter((kw) => toFiniteNumber(kw, 0) > 1e-6).length * TICK_HOURS,
        1
      ),

      gridImportKwh: round(gridImportKwh, 1),
      gridCostYuan: round(gridCostYuan, 1),
      peakGridKw: round(maxSeriesValue(grid), 1),

      socMinPct: round(minSeriesValue(soc, 100), 1),

      curtailmentKwh: round(curtailmentKwh, 1),
      curtailmentRatePct: pvGenerationKwh > 0
        ? round(curtailmentKwh / pvGenerationKwh * 100, 2)
        : 0,

      pvSelfUseRate: pvGenerationKwh > 0
        ? round((pvGenerationKwh - curtailmentKwh) / pvGenerationKwh, 5)
        : 0
    });
  }

  return monthlyMetrics;
}

function sumLoadCurveKwh(loadCurve) {
  return loadCurve.reduce((sum, kw) => {
    const value = Number.isFinite(Number(kw)) ? Number(kw) : 0;
    return sum + value * TICK_HOURS;
  }, 0);
}

function countEventsByTag(events, tag) {
  return events.filter((event) => event.tag === tag).length;
}

function buildInitialDemandProfile(demand) {
  const loadCurve = demand.loadCurve || [];
  const rawLoadCurve = demand.rawLoadCurve || [];
  const annualEnergyKwh = sumLoadCurveKwh(loadCurve);
  const rawEnergyKwh = sumLoadCurveKwh(rawLoadCurve);
  const monthlyDemand = summarizeMonthlyDemand(loadCurve);

  return {
    key: "D0",
    label: "全年用户初始需求画像",
    description: "用户自然到达、自然充电、不做需求侧调度时形成的全年充电负荷。",

    horizonDays: demand.horizonDays,
    ticks: loadCurve.length,
    tickMinutes: 15,

    loadCurve,
    rawLoadCurve,

    annualEnergyKwh: round(annualEnergyKwh, 1),
    rawEnergyKwh: round(rawEnergyKwh, 1),
    averageDailyEnergyKwh: demand.horizonDays > 0
      ? round(annualEnergyKwh / demand.horizonDays, 1)
      : 0,
    peakLoadKw: round(demand.peakLoadKw, 1),
    rawPeakLoadKw: round(demand.rawPeakLoadKw, 1),

    eventCount: demand.events.length,
    fastCount: countEventsByTag(demand.events, "FAST"),
    slowCount: countEventsByTag(demand.events, "SLOW"),

    queueUnmetKwh: round(demand.queueUnmetKwh, 1),
    unmetByPileKwh: round(demand.unmetByPileKwh, 1),
    abandonedCount: demand.abandonedCount,
    averageSessionNeedKwh: round(demand.averageSessionNeedKwh, 1),

    monthlyDemand,

    dispatch: {
      enabled: false,
      strategy: "none",
      shiftedEnergyKwh: 0,
      peakReductionKw: 0,
      userDelayHours: 0,
      note: "D0 为自然需求画像，不包含需求侧调度。"
    }
  };
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeRatio(numerator, denominator) {
  const value = toFiniteNumber(numerator, 0);
  const base = toFiniteNumber(denominator, 0);
  return Math.abs(base) > 1e-9 ? value / base : 0;
}

function withEndToEndSummary(summary, profile) {
  const energyDemandKwh = toFiniteNumber(summary.demandKwh, 0);
  const rawDemandKwh = toFiniteNumber(profile.rawEnergyKwh, energyDemandKwh);
  const energyUnservedKwh = toFiniteNumber(summary.unservedEnergyKwh, 0);
  const pileUnservedKwh = Math.max(0, rawDemandKwh - energyDemandKwh);
  const endToEndUnservedKwh = pileUnservedKwh + energyUnservedKwh;
  const endToEndDeliveredKwh = Math.max(0, rawDemandKwh - endToEndUnservedKwh);
  const endToEndServiceRate = rawDemandKwh > 0
    ? endToEndDeliveredKwh / rawDemandKwh
    : 1;

  return {
    ...summary,
    rawDemandKwh: round(rawDemandKwh, 1),
    energyDemandKwh: round(energyDemandKwh, 1),
    pileUnservedKwh: round(pileUnservedKwh, 1),
    energyUnservedEnergyKwh: round(energyUnservedKwh, 1),
    energyServiceRate: round(toFiniteNumber(summary.serviceRate, 1), 5),
    endToEndUnservedKwh: round(endToEndUnservedKwh, 1),
    endToEndUnservedRate: round(safeRatio(endToEndUnservedKwh, rawDemandKwh), 5),
    endToEndServiceRate: round(endToEndServiceRate, 5),
    unservedEnergyKwh: round(endToEndUnservedKwh, 1),
    serviceRate: round(endToEndServiceRate, 5)
  };
}

function clampLocal(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getTickHour(tick) {
  return Math.floor((tick % TICKS_PER_DAY) / 4);
}

function getPeakLoadKw(loadCurve) {
  return loadCurve.reduce((max, kw) => {
    return Math.max(max, toFiniteNumber(kw, 0));
  }, 0);
}

function buildAnnualIrradianceForM2(params, ticks, monthIndex) {
  return buildIrradianceSeries(params, ticks, {
    monthIndex,
    useGTilt: params.gTiltData?.length >= 8760,
    annualMode: true
  });
}

function isMicrogridLowPriceWindow(tick, irradiance, pvSignal = null) {
  if (pvSignal?.isStrongPvWindow?.length) {
    return Boolean(pvSignal.isStrongPvWindow[tick]);
  }

  const hour = getTickHour(tick);
  const pv = toFiniteNumber(irradiance[tick], 0);
  return hour >= 10 && hour < 15 && pv > 0.05;
}

function calcPvAlignmentScore(loadCurve, irradiance) {
  const totalEnergy = sumLoadCurveKwh(loadCurve);
  if (totalEnergy <= 0) return 0;

  const weightedIrradiance = loadCurve.reduce((sum, kw, tick) => {
    const energy = toFiniteNumber(kw, 0) * TICK_HOURS;
    return sum + energy * toFiniteNumber(irradiance[tick], 0);
  }, 0);

  return weightedIrradiance / totalEnergy;
}

function summarizeMicrogridWindowEnergy(loadCurve, irradiance, pvSignal = null) {
  return loadCurve.reduce((acc, kw, tick) => {
    const energy = toFiniteNumber(kw, 0) * TICK_HOURS;

    if (isMicrogridLowPriceWindow(tick, irradiance, pvSignal)) {
      acc.lowPriceWindowKwh += energy;
    } else {
      acc.nonLowPriceWindowKwh += energy;
    }

    return acc;
  }, {
    lowPriceWindowKwh: 0,
    nonLowPriceWindowKwh: 0
  });
}

function percentileLocal(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((sorted.length - 1) * p))
  );
  return sorted[index];
}

function buildStrongPvSignal(irradiance) {
  const isStrongPvWindow = Array(irradiance.length).fill(false);
  const pvStrength = Array(irradiance.length).fill(0);
  const dailyPeak = Array(irradiance.length).fill(0);
  const dailyThreshold = Array(irradiance.length).fill(0);

  for (let dayStart = 0; dayStart < irradiance.length; dayStart += TICKS_PER_DAY) {
    const dayEnd = Math.min(dayStart + TICKS_PER_DAY, irradiance.length);

    const dayValues = irradiance
      .slice(dayStart, dayEnd)
      .map((value) => Math.max(0, toFiniteNumber(value, 0)));

    const peak = dayValues.reduce((max, value) => Math.max(max, value), 0);
    const daylightValues = dayValues.filter((value) => value > 0.02);

    if (peak <= 0.05 || daylightValues.length === 0) {
      continue;
    }

    const p70 = percentileLocal(daylightValues, 0.70);

    const threshold = Math.max(
      0.05,
      Math.min(peak * 0.80, Math.max(peak * 0.60, p70))
    );

    for (let localTick = 0; localTick < dayValues.length; localTick++) {
      const tick = dayStart + localTick;
      const pv = dayValues[localTick];

      dailyPeak[tick] = peak;
      dailyThreshold[tick] = threshold;
      pvStrength[tick] = peak > 0 ? pv / peak : 0;
      isStrongPvWindow[tick] = pv >= threshold;
    }
  }

  return {
    method: "daily_dynamic_strong_pv_window",
    isStrongPvWindow,
    pvStrength,
    dailyPeak,
    dailyThreshold
  };
}

function summarizeTouEnergy(loadCurve, params) {
  const touPrice = params.climate?.gridTouPrice;

  return loadCurve.reduce((acc, kw, tick) => {
    const hour = getTickHour(tick);
    const price = getTouPrice(hour, touPrice);
    const energy = toFiniteNumber(kw, 0) * TICK_HOURS;

    const valley = touPrice?.valley ?? 0.30;
    const peak = touPrice?.peak ?? 1.10;

    if (price <= valley + 1e-9) acc.valleyKwh += energy;
    else if (price >= peak - 1e-9) acc.peakKwh += energy;
    else acc.flatKwh += energy;

    return acc;
  }, {
    valleyKwh: 0,
    flatKwh: 0,
    peakKwh: 0
  });
}

function normalizeDispatchEvent(event, totalTicks) {
  const powerKw = toFiniteNumber(
    event.powerKw,
    event.tag === "FAST" ? 30 : 7
  );

  const energyNeed = Math.max(0, toFiniteNumber(event.energyNeed, 0));

  const startTick = clampLocal(
    Math.floor(toFiniteNumber(event.arriveHour, 0) * 4),
    0,
    totalTicks - 1
  );

  const leaveTick = clampLocal(
    Math.ceil(toFiniteNumber(event.leaveHour, 0) * 4),
    startTick + 1,
    totalTicks
  );

  const requiredTicks = powerKw > 0
    ? Math.ceil(energyNeed / (powerKw * TICK_HOURS))
    : 0;

  const dwellTicks = Math.max(0, leaveTick - startTick);
  const slackTicks = Math.max(0, dwellTicks - requiredTicks);

  return {
    ...event,
    powerKw,
    energyNeed,
    startTick,
    leaveTick,
    requiredTicks,
    dwellTicks,
    slackTicks
  };
}

function isPriceResponsiveEvent(event) {
  if (event.tag !== "SLOW") return false;
  if (event.energyNeed <= 0) return false;
  if (event.slackTicks < 4) return false;
  if (event.dwellTicks < Math.max(12, event.requiredTicks + 4)) return false;
  return true;
}

function buildPvOnlyRank({ tick, irradiance, pvSignal = null }) {
  const hour = getTickHour(tick);
  const pv = toFiniteNumber(irradiance[tick], 0);

  const inStrongPvWindow = pvSignal?.isStrongPvWindow?.length
    ? Boolean(pvSignal.isStrongPvWindow[tick])
    : isMicrogridLowPriceWindow(tick, irradiance);

  const pvStrength = toFiniteNumber(
    pvSignal?.pvStrength?.[tick],
    pv
  );

  const noonDistance = Math.abs(hour - 12);

  return {
    inStrongPvWindow: inStrongPvWindow ? 1 : 0,
    pvStrength,
    pv,
    noonDistance,
    tick
  };
}

function comparePvOnlyRank(a, b) {
  const rankA = a.rank;
  const rankB = b.rank;

  // 1. 优先进入动态强光伏窗口
  if (rankA.inStrongPvWindow !== rankB.inStrongPvWindow) {
    return rankB.inStrongPvWindow - rankA.inStrongPvWindow;
  }

  // 2. 当天相对光伏强度越高越优先
  if (Math.abs(rankA.pvStrength - rankB.pvStrength) > 1e-6) {
    return rankB.pvStrength - rankA.pvStrength;
  }

  // 3. 绝对光伏出力越高越优先
  if (Math.abs(rankA.pv - rankB.pv) > 1e-6) {
    return rankB.pv - rankA.pv;
  }

  // 4. 越接近中午越优先，作为兜底
  if (rankA.noonDistance !== rankB.noonDistance) {
    return rankA.noonDistance - rankB.noonDistance;
  }

  // 5. 稳定排序
  return rankA.tick - rankB.tick;
}

function schedulePriceGuidedEvent({
  event,
  priceResponsive,
  loadCurve,
  fastOccupancy,
  slowOccupancy,
  hardware,
  irradiance,
  params,
  systemSignal = null,
  pvSignal = null
}) {
  const isFast = event.tag === "FAST";
  const occupancy = isFast ? fastOccupancy : slowOccupancy;
  const capacity = isFast ? hardware.n30kw : hardware.n7kw;

  if (capacity <= 0 || event.energyNeed <= 0 || event.powerKw <= 0) {
    return {
      deliveredKwh: 0,
      unmetKwh: event.energyNeed,
      shiftedKwh: 0,
      delayHours: 0,
      shiftedEvent: false
    };
  }

  const candidates = [];

  for (let tick = event.startTick; tick < event.leaveTick; tick++) {
    if ((occupancy[tick] || 0) < capacity) {
      candidates.push(tick);
    }
  }

  if (priceResponsive) {
    candidates.sort((a, b) => {
      const itemA = {
        tick: a,
        rank: buildPvOnlyRank({
          tick: a,
          irradiance,
          pvSignal
        })
      };

      const itemB = {
        tick: b,
        rank: buildPvOnlyRank({
          tick: b,
          irradiance,
          pvSignal
        })
      };

      return comparePvOnlyRank(itemA, itemB);
    });
  } else {
    candidates.sort((a, b) => a - b);
  }

  let remaining = event.energyNeed;
  let deliveredKwh = 0;
  const chosenTicks = [];

  for (const tick of candidates) {
    if (remaining <= 1e-6) break;

    const deliveredThisTick = Math.min(
      remaining,
      event.powerKw * TICK_HOURS
    );

    loadCurve[tick] += deliveredThisTick / TICK_HOURS;
    occupancy[tick] += 1;

    remaining -= deliveredThisTick;
    deliveredKwh += deliveredThisTick;
    chosenTicks.push(tick);
  }

  const unmetKwh = Math.max(0, remaining);

  if (!priceResponsive || chosenTicks.length === 0) {
    return {
      deliveredKwh,
      unmetKwh,
      shiftedKwh: 0,
      delayHours: 0,
      shiftedEvent: false
    };
  }

  const actualMeanTick =
    chosenTicks.reduce((sum, tick) => sum + tick, 0) / chosenTicks.length;

  const naturalMeanTick =
    event.startTick + Math.min(event.requiredTicks, chosenTicks.length) / 2;

  const delayHours = Math.max(0, actualMeanTick - naturalMeanTick) * TICK_HOURS;
  const shiftedEvent = delayHours >= 0.25;

  return {
    deliveredKwh,
    unmetKwh,
    shiftedKwh: shiftedEvent ? deliveredKwh : 0,
    delayHours,
    shiftedEvent
  };
}

function buildPriceGuidedDemandProfileFromEvents({
  initialProfile,
  demand,
  hardware,
  params,
  irradiance,
  systemSignal = null
}) {
  const totalTicks = initialProfile.ticks;

  const pvSignal = buildStrongPvSignal(irradiance);

  const loadCurve = Array(totalTicks).fill(0);
  const fastOccupancy = Array(totalTicks).fill(0);
  const slowOccupancy = Array(totalTicks).fill(0);

  const normalizedEvents = (demand.events || [])
    .map((event) => normalizeDispatchEvent(event, totalTicks))
    .filter((event) => event.energyNeed > 0 && event.requiredTicks > 0);

  const fixedEvents = [];
  const responsiveEvents = [];

  normalizedEvents.forEach((event) => {
    if (isPriceResponsiveEvent(event)) responsiveEvents.push(event);
    else fixedEvents.push(event);
  });

  fixedEvents.sort((a, b) => a.startTick - b.startTick);

  responsiveEvents.sort((a, b) => {
    return a.slackTicks - b.slackTicks || a.startTick - b.startTick;
  });

  let deliveredEnergyKwh = 0;
  let unmetByDispatchKwh = 0;
  let shiftedEnergyKwh = 0;
  let userDelayHours = 0;
  let shiftedEventCount = 0;

  fixedEvents.forEach((event) => {
    const result = schedulePriceGuidedEvent({
      event,
      priceResponsive: false,
      loadCurve,
      fastOccupancy,
      slowOccupancy,
      hardware,
      irradiance,
      params,
      systemSignal,
      pvSignal
    });

    deliveredEnergyKwh += result.deliveredKwh;
    unmetByDispatchKwh += result.unmetKwh;
  });

  responsiveEvents.forEach((event) => {
    const result = schedulePriceGuidedEvent({
      event,
      priceResponsive: true,
      loadCurve,
      fastOccupancy,
      slowOccupancy,
      hardware,
      irradiance,
      params,
      systemSignal,
      pvSignal
    });

    deliveredEnergyKwh += result.deliveredKwh;
    unmetByDispatchKwh += result.unmetKwh;
    shiftedEnergyKwh += result.shiftedKwh;
    userDelayHours += result.delayHours;
    if (result.shiftedEvent) shiftedEventCount += 1;
  });

  const baseAnnualEnergyKwh = sumLoadCurveKwh(initialProfile.loadCurve);
  const unnormalizedAnnualEnergyKwh = sumLoadCurveKwh(loadCurve);
  const energyNormalizationFactor = unnormalizedAnnualEnergyKwh > 0
    ? baseAnnualEnergyKwh / unnormalizedAnnualEnergyKwh
    : 1;

  if (Number.isFinite(energyNormalizationFactor) && Math.abs(energyNormalizationFactor - 1) > 1e-6) {
    for (let tick = 0; tick < loadCurve.length; tick++) {
      loadCurve[tick] *= energyNormalizationFactor;
    }

    deliveredEnergyKwh *= energyNormalizationFactor;
    shiftedEnergyKwh *= energyNormalizationFactor;
    unmetByDispatchKwh *= energyNormalizationFactor;
  }

  const annualEnergyKwh = sumLoadCurveKwh(loadCurve);
  const peakLoadKw = getPeakLoadKw(loadCurve);
  const monthlyDemand = summarizeMonthlyDemand(loadCurve);

  const basePvAlignment = calcPvAlignmentScore(initialProfile.loadCurve, irradiance);
  const nextPvAlignment = calcPvAlignmentScore(loadCurve, irradiance);

  const baseWindowEnergy = summarizeMicrogridWindowEnergy(initialProfile.loadCurve, irradiance, pvSignal);
  const nextWindowEnergy = summarizeMicrogridWindowEnergy(loadCurve, irradiance, pvSignal);

  const baseTou = summarizeTouEnergy(initialProfile.loadCurve, params);
  const nextTou = summarizeTouEnergy(loadCurve, params);

  return {
    ...initialProfile,

    key: "D1_price_guided",
    label: "光伏驱动需求重排后的全年需求画像",
    description:
      "识别逐日光伏强出力时段，将可调慢充需求优先排入强光伏窗口；不直接考虑 SOC、缺口、弃光、外部电价，系统影响由后续四情景仿真评价。",

    loadCurve,
    rawLoadCurve: [...initialProfile.rawLoadCurve],

    annualEnergyKwh: round(annualEnergyKwh, 1),
    averageDailyEnergyKwh: initialProfile.horizonDays > 0
      ? round(annualEnergyKwh / initialProfile.horizonDays, 1)
      : 0,
    peakLoadKw: round(peakLoadKw, 1),

    queueUnmetKwh: round(unmetByDispatchKwh, 1),
    unmetByPileKwh: round(unmetByDispatchKwh, 1),

    monthlyDemand,

    dispatch: {
      enabled: true,
      strategy: "pv_driven_demand_reshaping",
      systemSignalBasis: "none_pv_only",

      strongPvWindowMethod: pvSignal.method,
      strongPvWindowNote:
        "微网低价窗口由逐日光伏强出力时段动态识别，不再固定为 10:00—15:00。",

      fixedEventCount: fixedEvents.length,
      responsiveEventCount: responsiveEvents.length,
      shiftedEventCount,

      deliveredEnergyKwh: round(deliveredEnergyKwh, 1),
      unmetByDispatchKwh: round(unmetByDispatchKwh, 1),
      energyNormalizationFactor: round(energyNormalizationFactor, 5),

      shiftedEnergyKwh: round(shiftedEnergyKwh, 1),
      peakReductionKw: round(initialProfile.peakLoadKw - peakLoadKw, 1),
      userDelayHours: round(userDelayHours, 1),

      pvAlignmentGain: round(nextPvAlignment - basePvAlignment, 5),

      microgridLowPriceWindowKwh: round(nextWindowEnergy.lowPriceWindowKwh, 1),
      microgridLowPriceWindowGainKwh: round(
        nextWindowEnergy.lowPriceWindowKwh - baseWindowEnergy.lowPriceWindowKwh,
        1
      ),

      peakAvoidedKwh: round(baseTou.peakKwh - nextTou.peakKwh, 1),
      valleyShiftKwh: round(nextTou.valleyKwh - baseTou.valleyKwh, 1),

      note:
        "D1 为光伏驱动的需求重排画像：识别逐日光伏强出力时段，将可调慢充需求优先排入强光伏窗口；不直接考虑 SOC、缺口、弃光、外部电价。系统影响由后续四情景仿真评价。"
    }
  };
}

function pickWorstMonth(monthlyMetrics, field, mode = "max") {
  if (!monthlyMetrics?.length) return null;

  const sorted = [...monthlyMetrics].sort((a, b) => {
    const av = toFiniteNumber(a[field], 0);
    const bv = toFiniteNumber(b[field], 0);
    return mode === "min" ? av - bv : bv - av;
  });

  const item = sorted[0];

  return {
    monthIndex: item.monthIndex,
    monthName: item.monthName,
    field,
    value: item[field]
  };
}

function buildPressureMonthAnalysis({
  predictedPressureMonthIndex,
  scenarios,
  pressureMonthMethod = "school_pressure_score"
}) {
  const offgridRule = scenarios.offgrid_rule?.monthlyMetrics || [];
  const gridRule = scenarios.grid_rule?.monthlyMetrics || [];

  const actualWorstMonthByUnserved = pickWorstMonth(
    offgridRule,
    "unservedEnergyKwh",
    "max"
  );

  const actualWorstMonthBySoc = pickWorstMonth(
    offgridRule,
    "socMinPct",
    "min"
  );

  const actualWorstMonthByGridImport = pickWorstMonth(
    gridRule,
    "gridImportKwh",
    "max"
  );

  const actualWorstMonthByCurtailment = pickWorstMonth(
    offgridRule,
    "curtailmentKwh",
    "max"
  );

  const predictedPressureMonth = {
    monthIndex: predictedPressureMonthIndex,
    monthName: MONTH_NAMES[predictedPressureMonthIndex],
    method: pressureMonthMethod
  };

  return {
    predictedPressureMonth,
    actualWorstMonthByUnserved,
    actualWorstMonthBySoc,
    actualWorstMonthByGridImport,
    actualWorstMonthByCurtailment,

    consistency: {
      predictedMatchesUnserved:
        predictedPressureMonthIndex === actualWorstMonthByUnserved?.monthIndex,
      predictedMatchesSoc:
        predictedPressureMonthIndex === actualWorstMonthBySoc?.monthIndex,
      predictedMatchesGridImport:
        predictedPressureMonthIndex === actualWorstMonthByGridImport?.monthIndex
    }
  };
}

function buildRiskDiagnosis({ scenarios, pressureMonthAnalysis }) {
  const offgridRule = scenarios.offgrid_rule?.summary || {};
  const offgridDispatch = scenarios.offgrid_dispatch?.summary || {};
  const gridRule = scenarios.grid_rule?.summary || {};
  const gridDispatch = scenarios.grid_dispatch?.summary || {};
  const d1 = scenarios.offgrid_dispatch?.demandProfile?.dispatch || {};

  const riskDrivers = [];

  if ((offgridRule.unservedEnergyKwh || 0) > 1) {
    riskDrivers.push({
      type: "offgrid_reliability",
      label: "离网可靠性风险",
      description: "离网自然需求下存在最终未满足电量，说明 S0 在全年真实运行中仍有供能缺口。",
      severity: offgridRule.unservedEnergyKwh > offgridRule.demandKwh * 0.05
        ? "high"
        : "medium"
    });
  }

  if ((offgridRule.socMinPct ?? 100) < 8) {
    riskDrivers.push({
      type: "storage_soc",
      label: "储能 SOC 安全裕度不足",
      description: "离网情景最低 SOC 偏低，说明连续低光照或夜间负荷可能导致储能深放电。",
      severity: (offgridRule.socMinPct ?? 100) < 3 ? "high" : "medium"
    });
  }

  if ((gridRule.gridDependencyRate || 0) > 0.25) {
    riskDrivers.push({
      type: "grid_dependency",
      label: "电网依赖偏高",
      description: "并网自然需求下电网购电占比较高，说明 S0 对外部电源兜底依赖较明显。",
      severity: gridRule.gridDependencyRate > 0.4 ? "high" : "medium"
    });
  }

  if ((gridRule.peakGridKw || 0) > 0) {
    riskDrivers.push({
      type: "grid_peak",
      label: "电网峰值压力",
      description: "并网情景存在峰值购电功率，需要关注变压器容量与削峰能力。",
      severity: gridRule.peakGridKw > 0.8 * (gridRule.peakLoadKw || 1)
        ? "high"
        : "medium"
    });
  }

  if ((offgridRule.curtailmentRatePct || 0) > 15) {
    riskDrivers.push({
      type: "pv_curtailment",
      label: "弃光率偏高",
      description: "离网情景弃光率偏高，说明 PV 与负荷/储能吸纳之间存在错配。",
      severity: offgridRule.curtailmentRatePct > 30 ? "high" : "medium"
    });
  }

  const optimizationFocus = [];

  if ((offgridRule.unservedEnergyKwh || 0) > 1) {
    optimizationFocus.push("优先评估 PV、储能容量与 PCS 功率是否需要扩容。");
  }

  if ((d1.shiftedEnergyKwh || 0) > 0) {
    optimizationFocus.push("保留微网电价引导调度，评估其对削峰、PV 消纳和缺口缓解的贡献。");
  }

  if ((gridRule.gridCostYuan || 0) > (gridDispatch.gridCostYuan || 0)) {
    optimizationFocus.push("并网情景可继续优化削峰与低价窗口充电，降低购电成本。");
  }

  if ((offgridRule.curtailmentRatePct || 0) > 15) {
    optimizationFocus.push("若弃光偏高，M3 可评估增加储能吸纳或强化可调负荷转移。");
  }

  return {
    riskDrivers,
    optimizationFocus,
    scenarioPriorities: {
      reliabilityFirst: offgridRule.unservedEnergyKwh > 1 || (offgridRule.socMinPct ?? 100) < 8,
      economyFirst: gridRule.gridCostYuan > 0 || gridRule.gridDependencyRate > 0.25,
      dispatchUseful:
        (offgridRule.unservedEnergyKwh || 0) > (offgridDispatch.unservedEnergyKwh || 0) ||
        (gridRule.gridCostYuan || 0) > (gridDispatch.gridCostYuan || 0)
    },
    pressureMonthAnalysis
  };
}

function pickScenarioSummary(scenarioResult) {
  const summary = scenarioResult?.summary || {};
  const monthlyMetrics = scenarioResult?.monthlyMetrics || [];

  return {
    scenarioKey: summary.scenarioKey,
    scenarioLabel: summary.scenarioLabel,
    scenarioLogicLabel: summary.scenarioLogicLabel,

    gridConnected: Boolean(summary.gridConnected),
    systemDispatchEnabled: Boolean(summary.systemDispatchEnabled),
    demandDispatchEnabled: Boolean(summary.demandDispatchEnabled),

    demandProfileKey: summary.demandProfileKey,
    demandProfileLabel: summary.demandProfileLabel,

    demandKwh: summary.demandKwh || 0,
    deliveredKwh: summary.deliveredKwh || 0,
    serviceRate: summary.serviceRate || 0,

    internalDeficitKwh: summary.internalDeficitKwh || 0,
    unservedEnergyKwh: summary.unservedEnergyKwh || 0,
    endToEndUnservedKwh: summary.endToEndUnservedKwh || summary.unservedEnergyKwh || 0,
    energyUnservedEnergyKwh: summary.energyUnservedEnergyKwh || 0,
    pileUnservedKwh: summary.pileUnservedKwh || 0,
    endToEndServiceRate: summary.endToEndServiceRate || summary.serviceRate || 0,
    energyServiceRate: summary.energyServiceRate ?? null,
    deficitHours: summary.deficitHours || 0,

    gridImportKwh: summary.gridImportKwh || 0,
    gridDependencyRate: summary.gridDependencyRate || 0,
    gridCostYuan: summary.gridCostYuan || 0,
    peakGridKw: summary.peakGridKw || 0,

    socMinPct: summary.socMinPct ?? 100,

    pvGenerationKwh: summary.pvGenerationKwh || 0,
    curtailmentKwh: summary.curtailmentKwh || 0,
    curtailmentRatePct: summary.curtailmentRatePct || 0,
    pvSelfUseRate: summary.pvSelfUseRate || 0,

    totalCostWan: summary.totalCostWan || 0,

    monthlyMetrics
  };
}

function buildMonthlyRiskPointers(pressureMonthAnalysis) {
  return {
    predictedPressureMonth: pressureMonthAnalysis?.predictedPressureMonth || null,

    reliabilityRiskMonth: pressureMonthAnalysis?.actualWorstMonthByUnserved || null,
    socRiskMonth: pressureMonthAnalysis?.actualWorstMonthBySoc || null,
    gridImportRiskMonth: pressureMonthAnalysis?.actualWorstMonthByGridImport || null,
    curtailmentRiskMonth: pressureMonthAnalysis?.actualWorstMonthByCurtailment || null,

    consistency: pressureMonthAnalysis?.consistency || {}
  };
}

function buildSizingHints({ scenarios, demandProfiles }) {
  const offgridRule = scenarios.offgrid_rule?.summary || {};
  const offgridDispatch = scenarios.offgrid_dispatch?.summary || {};
  const gridRule = scenarios.grid_rule?.summary || {};
  const gridDispatch = scenarios.grid_dispatch?.summary || {};
  const d1 = demandProfiles.priceGuided?.dispatch || {};

  const hints = [];

  if ((offgridRule.unservedEnergyKwh || 0) > 1) {
    hints.push({
      target: "pv_storage_pcs",
      priority: "high",
      reason: "离网自然需求下存在未满足电量，说明 S0 供能能力不足。",
      suggestedAction: "M3 应优先搜索 PV、储能容量和 PCS 功率的组合扩容。"
    });
  }

  if ((offgridRule.socMinPct ?? 100) < 8) {
    hints.push({
      target: "storage",
      priority: "high",
      reason: "离网情景最低 SOC 偏低，存在储能深放电风险。",
      suggestedAction: "M3 应提高储能容量或调整 PCS 与调度策略，增加 SOC 安全裕度。"
    });
  }

  if ((gridRule.gridDependencyRate || 0) > 0.25) {
    hints.push({
      target: "grid_dependency",
      priority: "medium",
      reason: "并网自然需求下电网依赖偏高。",
      suggestedAction: "M3 应评估增加 PV / 储能或强化需求转移，以降低电网购电比例。"
    });
  }

  if ((gridRule.peakGridKw || 0) > 0) {
    hints.push({
      target: "grid_peak",
      priority: "medium",
      reason: "并网情景存在峰值购电功率。",
      suggestedAction: "M3 应关注 PCS、储能放电能力和微网电价引导对削峰的贡献。"
    });
  }

  if ((offgridRule.curtailmentRatePct || 0) > 15) {
    hints.push({
      target: "pv_absorption",
      priority: "medium",
      reason: "弃光率偏高，说明 PV 与负荷/储能吸纳存在错配。",
      suggestedAction: "M3 应评估增加储能吸纳、提高可调负荷转移能力，或避免 PV 过度扩容。"
    });
  }

  if ((d1.shiftedEnergyKwh || 0) > 0) {
    hints.push({
      target: "demand_dispatch",
      priority: "medium",
      reason: "D1 微网电价引导已产生负荷转移。",
      suggestedAction: "M3 应保留 D1_price_guided 作为可选运行策略，并评估其对配置规模的替代价值。"
    });
  }

  if (
    (offgridRule.unservedEnergyKwh || 0) <= (offgridDispatch.unservedEnergyKwh || 0) &&
    (gridRule.gridCostYuan || 0) <= (gridDispatch.gridCostYuan || 0) &&
    (d1.shiftedEnergyKwh || 0) > 0
  ) {
    hints.push({
      target: "dispatch_constraint",
      priority: "low",
      reason: "D1 已产生转移，但四情景收益不明显。",
      suggestedAction: "M3 应检查微网低价窗口和可响应车辆比例，避免调度只增加延迟但收益不足。"
    });
  }

  return hints;
}

function buildM3Handoff({
  m1,
  hardware,
  demandProfiles,
  scenarios,
  comparison,
  pressureMonthAnalysis,
  riskDiagnosis
}) {
  const legacyCompat = buildRiskHandoff(scenarios);

  return {
    contract: "M2ToM3Handoff",
    version: "m2-annual-v1",
    sourceModule: "M2AnnualScenarioCompareResult",

    baseConfig: {
      source: "M1_S0",
      pvKw: hardware.pvKw,
      storageKwh: hardware.storageKwh,
      pcsKw: hardware.pcsKw,
      n7kw: hardware.n7kw,
      n30kw: hardware.n30kw,
      transformerLimitKw: hardware.transformerLimitKw,

      upstreamM1Summary: {
        pvKw: m1.hardwarePlan.pvKw,
        storageKwh: m1.hardwarePlan.storageKwh,
        pcsKw: m1.hardwarePlan.pcsKw
      }
    },

    demandDispatch: {
      initialProfileKey: demandProfiles.initial?.key,
      dispatchedProfileKey: demandProfiles.priceGuided?.key,
      dispatchedProfileLabel: demandProfiles.priceGuided?.label,
      strategy: demandProfiles.priceGuided?.dispatch?.strategy,
      enabled: Boolean(demandProfiles.priceGuided?.dispatch?.enabled),

      shiftedEnergyKwh: demandProfiles.priceGuided?.dispatch?.shiftedEnergyKwh || 0,
      peakReductionKw: demandProfiles.priceGuided?.dispatch?.peakReductionKw || 0,
      userDelayHours: demandProfiles.priceGuided?.dispatch?.userDelayHours || 0,
      pvAlignmentGain: demandProfiles.priceGuided?.dispatch?.pvAlignmentGain || 0,
      microgridLowPriceWindowGainKwh:
        demandProfiles.priceGuided?.dispatch?.microgridLowPriceWindowGainKwh || 0,

      note: demandProfiles.priceGuided?.dispatch?.note || ""
    },

    scenarioSummaries: {
      offgridInitial: pickScenarioSummary(scenarios.offgrid_rule),
      offgridPriceGuided: pickScenarioSummary(scenarios.offgrid_dispatch),
      gridInitial: pickScenarioSummary(scenarios.grid_rule),
      gridPriceGuided: pickScenarioSummary(scenarios.grid_dispatch)
    },

    comparison,

    riskDrivers: riskDiagnosis.riskDrivers,
    optimizationFocus: riskDiagnosis.optimizationFocus,
    scenarioPriorities: riskDiagnosis.scenarioPriorities,

    sizingHints: buildSizingHints({
      scenarios,
      demandProfiles
    }),

    monthlyRiskPointers: buildMonthlyRiskPointers(pressureMonthAnalysis),

    pressureMonthAnalysis,

    legacyCompat,

    recommendedNextStep:
      "M3 应基于 M2 的四情景全年评价结果，围绕 S0 配置开展情景化配置优化，并对推荐配置进行全年复验。"
  };
}

function assertDemandProfileReady(profile, expectedTicks, label) {
  if (!profile?.loadCurve?.length) {
    throw new Error(`M2 缺少 ${label} 的 loadCurve，无法执行全年四情景评价。`);
  }

  if (profile.loadCurve.length !== expectedTicks) {
    throw new Error(
      `M2 ${label} 曲线长度不一致：期望 ${expectedTicks}，实际 ${profile.loadCurve.length}。`
    );
  }
}

function runScenarioSetByDemandProfiles({
  hardware,
  demandProfiles,
  params,
  monthIndex,
  irradiance = null
}) {
  const initialProfile = demandProfiles.initial;
  const expectedTicks = initialProfile?.loadCurve?.length || 0;

  assertDemandProfileReady(demandProfiles.initial, expectedTicks, "D0 初始需求画像");
  assertDemandProfileReady(demandProfiles.priceGuided, expectedTicks, "D1 微网电价引导需求画像");

  const scenarioIrradiance = irradiance || buildAnnualIrradianceForM2(
    params,
    expectedTicks,
    monthIndex
  );

  return Object.fromEntries(
    SCENARIO_KEYS.map((scenarioKey) => {
      const binding = SCENARIO_PROFILE_BINDINGS[scenarioKey];

      if (!binding) {
        throw new Error(`M2 缺少情景 ${scenarioKey} 的需求画像绑定关系。`);
      }

      const profile = demandProfiles[binding.demandProfileKey];

      if (!profile) {
        throw new Error(`M2 情景 ${scenarioKey} 找不到需求画像：${binding.demandProfileKey}。`);
      }

      const result = simulateEnergyScenario({
        hardware,
        loadCurve: profile.loadCurve,
        irradiance: scenarioIrradiance,
        params,
        scenarioKey
      });
      const finalSummary = withEndToEndSummary(result.summary, profile);

      return [
        scenarioKey,
        {
          ...result,

          demandProfile: {
            key: profile.key,
            label: profile.label,
            dispatch: profile.dispatch
          },

          summary: {
            ...finalSummary,
            demandProfileKey: profile.key,
            demandProfileLabel: profile.label,
            scenarioLogicLabel: binding.scenarioLogicLabel,

            demandDispatchEnabled: Boolean(profile.dispatch?.enabled),
            systemDispatchEnabled: Boolean(result.summary.dispatchEnabled)
          }
        }
      ];
    })
  );
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

  const D0 = buildInitialDemandProfile(demand);

  const annualIrradiance = buildAnnualIrradianceForM2(
    params,
    D0.ticks,
    predictedPressureMonthIndex
  );

  const baselineOffgridRun = simulateEnergyScenario({
    hardware,
    loadCurve: D0.loadCurve,
    irradiance: annualIrradiance,
    params,
    scenarioKey: "offgrid_rule"
  });

  const D1 = buildPriceGuidedDemandProfileFromEvents({
    initialProfile: D0,
    demand,
    hardware,
    params,
    irradiance: annualIrradiance,
    systemSignal: null
  });

  const demandProfiles = {
    initial: D0,
    priceGuided: D1,

    // 兼容旧字段：后续 M2 UI 重构时删除
    offgridDispatched: D1,
    gridDispatched: D1
  };

  const scenarios = runScenarioSetByDemandProfiles({
    hardware,
    demandProfiles,
    params,
    monthIndex: predictedPressureMonthIndex,
    irradiance: annualIrradiance
  });

  Object.values(scenarios).forEach((scenario) => {
    scenario.monthlyMetrics = summarizeScenarioMonthlyMetrics(scenario);
  });

  const comparison = buildComparison(scenarios);

  const pressureMonthAnalysis = buildPressureMonthAnalysis({
    predictedPressureMonthIndex,
    scenarios,
    pressureMonthMethod: params.monthMode === "manual" ? "manual" : "school_pressure_score"
  });

  const riskDiagnosis = buildRiskDiagnosis({
    scenarios,
    pressureMonthAnalysis
  });

  const handoffToM3 = buildM3Handoff({
    m1,
    hardware,
    demandProfiles,
    scenarios,
    comparison,
    pressureMonthAnalysis,
    riskDiagnosis
  });

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

      simulationWeatherMode: params.gTiltData?.length >= 8760
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

    demandProfiles,

    demandSnapshot: {
      profileKey: D0.key,
      profileLabel: D0.label,
      horizonDays: D0.horizonDays,
      ticks: D0.ticks,

      annualEnergyKwh: D0.annualEnergyKwh,
      averageDailyEnergyKwh: D0.averageDailyEnergyKwh,
      peakLoadKw: D0.peakLoadKw,

      eventCount: D0.eventCount,
      fastCount: D0.fastCount,
      slowCount: D0.slowCount,
      queueUnmetKwh: D0.queueUnmetKwh,
      unmetByPileKwh: D0.unmetByPileKwh,
      abandonedCount: D0.abandonedCount
    },

    scenarios,
    comparison,

    pressureMonthAnalysis,
    riskDiagnosis,

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

    handoffToM3,

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
