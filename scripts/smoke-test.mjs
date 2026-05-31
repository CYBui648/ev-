import assert from "node:assert/strict";

import { runM1Plan } from "../src/worker/m1-engine.js";
import { runM2ScenarioCompare } from "../src/worker/m2-engine.js";
import { runM3ScenarioOptimization } from "../src/worker/m3-engine.js";
import { simulateEnergyScenario, normalizeProjectInput, buildDemandProfile, buildHardwarePlan, buildIrradianceSeries } from "../src/worker/scenario-core.js";

const gTiltData = Array.from({ length: 8760 }, (_, hour) => {
  const dayHour = hour % 24;
  return dayHour >= 7 && dayHour <= 17 ? 650 : 0;
});

const context = {
  input: {
    weather: {
      gTiltData,
      gTiltStatus: "测试 TMY 数据已加载",
      source: "TMY 8760 G_tilt"
    },
    m1: {
      climateKey: "guangzhou",
      evCount: 100,
      teacherRatio: 0.8,
      anxietyRatio: 0.2,
      batteryCapMean: 65,
      initSocMean: 0.4,
      targetSocMean: 0.95,
      holidayRatio: 0.1,
      pvEfficiency: 0.72,
      pvPrice: 1.5,
      pvRate: 15,
      storBasePrice: 1,
      storRate: 12,
      cost7kw: 0.3,
      cost30kw: 2.5,
      roofArea: 10000,
      evRatio: 3,
      renewableTarget: 0.5
    },
    m2: {
      transformerLimitKw: 500,
      teacherRatio: 0.8,
      anxietyRatio: 0.2
    },
    m3: {
      priceShiftThreshold: 0.55,
      opexRate: 0.015
    }
  },
  previousResults: {}
};

const m1Plan = runM1Plan(context);
assert.equal(m1Plan.contract, "M1Result");
assert.equal(m1Plan.baseConfigType, "s0_offgrid_baseline");
assert.equal(typeof m1Plan.offgridBaselineCheck.unservedKwh, "number");
assert.equal(typeof m1Plan.baselineMatch.serviceRate, "number");
assert.ok(m1Plan.hardwarePlan.pvKw >= 0);

const m2Context = {
  ...context,
  previousResults: {
    m1: m1Plan
  }
};
const m2ScenarioCompare = runM2ScenarioCompare(m2Context);
assert.equal(m2ScenarioCompare.contract, "M2AnnualScenarioCompareResult");
assert.deepEqual(
  Object.keys(m2ScenarioCompare.scenarios).sort(),
  ["grid_dispatch", "grid_rule", "offgrid_dispatch", "offgrid_rule"]
);
assert.equal(m2ScenarioCompare.scenarios.offgrid_rule.summary.gridImportKwh, 0);
assert.equal(m2ScenarioCompare.scenarios.grid_rule.summary.gridConnected, true);
assert.ok(m2ScenarioCompare.comparison);

// 第三轮验收
assert.equal(m2ScenarioCompare.demandProfiles.initial.key, "D0");
assert.equal(m2ScenarioCompare.demandProfiles.priceGuided.key, "D1_price_guided");
assert.equal(m2ScenarioCompare.demandProfiles.initial.loadCurve.length, 35040);
assert.equal(m2ScenarioCompare.demandProfiles.priceGuided.loadCurve.length, 35040);
assert.equal(m2ScenarioCompare.demandProfiles.initial.monthlyDemand.length, 12);
assert.equal(
  m2ScenarioCompare.demandProfiles.initial.annualEnergyKwh,
  m2ScenarioCompare.demandSnapshot.annualEnergyKwh
);
// 兼容字段 offgridDispatched / gridDispatched 指向 D1
assert.equal(m2ScenarioCompare.demandProfiles.offgridDispatched.key, "D1_price_guided");
assert.equal(m2ScenarioCompare.demandProfiles.gridDispatched.key, "D1_price_guided");
assert.equal(m2ScenarioCompare.demandProfiles.priceGuided.dispatch.enabled, true);
assert.ok(
  Math.abs(
    m2ScenarioCompare.demandProfiles.priceGuided.annualEnergyKwh -
    m2ScenarioCompare.demandProfiles.initial.annualEnergyKwh
  ) / m2ScenarioCompare.demandProfiles.initial.annualEnergyKwh < 0.1
);

// 第四轮验收：四情景分别绑定 D0/D1 需求画像
const s = m2ScenarioCompare.scenarios;
assert.equal(s.offgrid_rule.summary.demandProfileKey, "D0");
assert.equal(s.offgrid_dispatch.summary.demandProfileKey, "D1_price_guided");
assert.equal(s.grid_rule.summary.demandProfileKey, "D0");
assert.equal(s.grid_dispatch.summary.demandProfileKey, "D1_price_guided");
assert.equal(s.offgrid_rule.summary.scenarioLogicLabel, "离网 + D0 初始需求");
assert.equal(s.offgrid_dispatch.summary.scenarioLogicLabel, "离网 + D1 微网电价引导需求");
assert.equal(s.grid_rule.summary.scenarioLogicLabel, "入网 + D0 初始需求");
assert.equal(s.grid_dispatch.summary.scenarioLogicLabel, "入网 + D1 微网电价引导需求");
assert.equal(s.offgrid_rule.chartData.ev.length, 35040);
assert.equal(s.offgrid_dispatch.chartData.ev.length, 35040);
assert.equal(s.grid_rule.chartData.ev.length, 35040);
assert.equal(s.grid_dispatch.chartData.ev.length, 35040);

// 第五轮验收：统一微网电价引导 D1
const dp = m2ScenarioCompare.demandProfiles;
assert.equal(dp.priceGuided.key, "D1_price_guided");
assert.equal(dp.priceGuided.dispatch.enabled, true);
assert.equal(dp.priceGuided.loadCurve.length, 35040);
assert.ok(dp.priceGuided.dispatch.responsiveEventCount >= 0);
assert.ok(dp.priceGuided.dispatch.fixedEventCount >= 0);
assert.equal(
  dp.priceGuided.dispatch.fixedEventCount + dp.priceGuided.dispatch.responsiveEventCount,
  dp.initial.eventCount
);
// 调度后总能量偏离不超过 10%
const pctDiff = Math.abs(dp.priceGuided.annualEnergyKwh - dp.initial.annualEnergyKwh)
  / dp.initial.annualEnergyKwh;
assert.ok(pctDiff < 0.1, `D1 能量偏离 ${(pctDiff * 100).toFixed(1)}%`);
// D1 用于离网调度和并网调度
assert.equal(s.offgrid_dispatch.summary.demandDispatchEnabled, true);
assert.equal(s.grid_dispatch.summary.demandDispatchEnabled, true);
// D0 情景不应启用户侧调度
assert.equal(s.offgrid_rule.summary.demandDispatchEnabled, false);
assert.equal(s.grid_rule.summary.demandDispatchEnabled, false);
assert.equal(dp.priceGuided.dispatch.systemSignalBasis, "none_pv_only");
assert.ok(s.grid_rule.summary.gridImportKwh <= s.grid_rule.summary.internalDeficitKwh + 1);
assert.ok(s.grid_dispatch.summary.gridImportKwh <= s.grid_dispatch.summary.internalDeficitKwh + 1);

// 第六轮验收：月度指标、压力月分析、风险诊断
assert.equal(s.offgrid_rule.monthlyMetrics.length, 12);
assert.equal(s.offgrid_dispatch.monthlyMetrics.length, 12);
assert.equal(s.grid_rule.monthlyMetrics.length, 12);
assert.equal(s.grid_dispatch.monthlyMetrics.length, 12);

const m0 = s.offgrid_rule.monthlyMetrics[0];
assert.ok(typeof m0.demandKwh === "number");
assert.ok(typeof m0.internalDeficitKwh === "number");
assert.ok(typeof m0.unservedEnergyKwh === "number");
assert.ok(typeof m0.gridImportKwh === "number");
assert.ok(typeof m0.socMinPct === "number");
assert.ok(typeof m0.curtailmentKwh === "number");

assert.ok(m2ScenarioCompare.pressureMonthAnalysis);
assert.ok(m2ScenarioCompare.pressureMonthAnalysis.predictedPressureMonth);
assert.ok(m2ScenarioCompare.pressureMonthAnalysis.actualWorstMonthByUnserved);
assert.ok(m2ScenarioCompare.pressureMonthAnalysis.actualWorstMonthBySoc);
assert.ok(m2ScenarioCompare.pressureMonthAnalysis.consistency);

assert.ok(m2ScenarioCompare.riskDiagnosis);
assert.ok(Array.isArray(m2ScenarioCompare.riskDiagnosis.riskDrivers));
assert.ok(Array.isArray(m2ScenarioCompare.riskDiagnosis.optimizationFocus));
assert.ok(typeof m2ScenarioCompare.riskDiagnosis.scenarioPriorities === "object");

// monthlyMetrics gridImportKwh 合计应接近 summary.gridImportKwh
const gridRuleMonthlyTotal = s.grid_rule.monthlyMetrics.reduce(
  (sum, m) => sum + m.gridImportKwh, 0
);
assert.ok(
  Math.abs(gridRuleMonthlyTotal - s.grid_rule.summary.gridImportKwh) < 1,
  `grid_rule 月度购电合计 ${gridRuleMonthlyTotal} vs summary ${s.grid_rule.summary.gridImportKwh}`
);

// 第七轮验收：正式 handoffToM3 数据合同
const h = m2ScenarioCompare.handoffToM3;
assert.equal(h.contract, "M2ToM3Handoff");
assert.equal(h.version, "m2-annual-v1");
assert.ok(h.baseConfig);
assert.equal(typeof h.baseConfig.pvKw, "number");
assert.equal(h.demandDispatch.dispatchedProfileKey, "D1_price_guided");
assert.equal(h.demandDispatch.strategy, "pv_driven_demand_reshaping");
assert.ok(h.scenarioSummaries.offgridInitial);
assert.ok(h.scenarioSummaries.offgridPriceGuided);
assert.ok(h.scenarioSummaries.gridInitial);
assert.ok(h.scenarioSummaries.gridPriceGuided);
assert.ok(Array.isArray(h.sizingHints));
assert.ok(h.monthlyRiskPointers);
assert.ok(h.legacyCompat);
assert.equal(typeof h.recommendedNextStep, "string");

const m3Context = {
  ...context,
  previousResults: {
    m1: m1Plan,
    m2: m2ScenarioCompare
  }
};
const m3ScenarioOptimization = runM3ScenarioOptimization(m3Context);
assert.equal(m3ScenarioOptimization.contract, "M3ScenarioOptimizationResult");
assert.equal(m3ScenarioOptimization.candidateCount, 540);
assert.deepEqual(
  Object.keys(m3ScenarioOptimization.scenarioOptimums).sort(),
  ["grid_dispatch", "grid_rule", "offgrid_dispatch", "offgrid_rule"]
);
assert.ok(m3ScenarioOptimization.scenarioOptimums.offgrid_rule.recommendedConfig);
assert.ok(m3ScenarioOptimization.scenarioOptimums.grid_dispatch.recommendedConfig);
assert.ok(m3ScenarioOptimization.comparison.recommendedForEngineering);
assert.equal(Object.hasOwn(m3ScenarioOptimization, "route" + "Options"), false);

const params = normalizeProjectInput(context);
const demand = buildDemandProfile(params, { days: 7, seed: 20260512 });
const hardware = buildHardwarePlan({
  pvKw: 300,
  storageKwh: 600,
  pcsKw: 150,
  n7kw: 12,
  n30kw: 4,
  transformerLimitKw: 500
});
const irradiance = buildIrradianceSeries(params, demand.loadCurve.length, { monthIndex: 0, useGTilt: false });
const offgridRun = simulateEnergyScenario({
  hardware,
  loadCurve: demand.loadCurve,
  irradiance,
  params,
  scenarioKey: "offgrid_rule"
});
assert.equal(offgridRun.summary.gridConnected, false);
assert.equal(offgridRun.summary.gridImportKwh, 0);

const constrainedM2 = runM2ScenarioCompare({
  ...context,
  input: {
    ...context.input,
    m2: {
      ...context.input.m2,
      transformerLimitKw: 200
    }
  },
  previousResults: {
    m1: {
      hardwarePlan: {
        pvKw: 120,
        storageKwh: 120,
        pcsKw: 60,
        n7kw: 20,
        n30kw: 6
      }
    }
  }
});
assert.ok(
  constrainedM2.scenarios.offgrid_dispatch.summary.unservedEnergyKwh <=
    constrainedM2.scenarios.offgrid_rule.summary.unservedEnergyKwh + 1
);
assert.ok(
  constrainedM2.scenarios.grid_dispatch.summary.gridImportKwh <=
    constrainedM2.scenarios.grid_dispatch.summary.internalDeficitKwh + 1
);

globalThis.self = { addEventListener() {} };
await import("../src/worker/solver.worker.js");

console.log("smoke-test ok");
