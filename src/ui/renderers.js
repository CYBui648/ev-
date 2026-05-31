import { STAGES, STAGE_ORDER } from "../config/system-config.js";
import { dom } from "./dom.js";

const SCENARIOS = [
  { key: "offgrid_rule", label: "离网-规则运行", short: "C1", row: "离网", col: "规则运行" },
  { key: "offgrid_dispatch", label: "离网-优化调度", short: "C2", row: "离网", col: "优化调度" },
  { key: "grid_rule", label: "并网-规则运行", short: "C3", row: "并网", col: "规则运行" },
  { key: "grid_dispatch", label: "并网-优化调度", short: "C4", row: "并网", col: "优化调度" }
];

const chartInstances = new WeakMap();
const chartResizeObservers = new WeakMap();
const liveCharts = new Set();

function n(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return number.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function pct(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${n(number * 100, digits)}%`;
}

function setText(el, value) {
  if (el) el.textContent = value;
}

function getScenario(result, key) {
  return result?.scenarios?.[key] || null;
}

function getScenarioSummary(result, key) {
  return getScenario(result, key)?.summary || {};
}

function getScenarioChart(result, key) {
  const scenario = getScenario(result, key);
  return scenario?.chartData || scenario?.simulation?.chartData || scenario?.stressMonth?.chartData || null;
}

function statusLabel(status) {
  return {
    locked: "未解锁",
    ready: "可运行",
    running: "运行中",
    done: "已完成",
    error: "出错"
  }[status] || status;
}

function stageButtonText(key, status) {
  if (status === "running") return `正在运行 ${key.toUpperCase()}...`;
  if (status === "done") {
    return {
      m1: "重新生成 S0",
      m2: "重新评价四情景",
      m3: "重新优化 C1-C4"
    }[key];
  }
  return {
    m1: "运行 M1 生成 S0",
    m2: "运行 M2 四情景评价",
    m3: "运行 M3 情景化优化"
  }[key];
}

function resetChart(container, message = "暂无数据") {
  if (!container) return;

  const oldObserver = chartResizeObservers.get(container);
  if (oldObserver) {
    oldObserver.disconnect();
    chartResizeObservers.delete(container);
  }

  const chart = chartInstances.get(container);
  if (chart) {
    liveCharts.delete(chart);
    chart.dispose();
  }

  chartInstances.delete(container);
  container.innerHTML = `<div class="insight-chart-empty">${message}</div>`;
}

function renderChart(container, option, emptyMessage) {
  if (!container) return;

  if (!window.echarts) {
    resetChart(container, "图表库未加载，数据表仍可查看。");
    return;
  }

  if (!option) {
    resetChart(container, emptyMessage);
    return;
  }

  const oldObserver = chartResizeObservers.get(container);
  if (oldObserver) {
    oldObserver.disconnect();
    chartResizeObservers.delete(container);
  }

  const oldChart = chartInstances.get(container);
  if (oldChart) {
    liveCharts.delete(oldChart);
    oldChart.dispose();
  }

  container.innerHTML = "";

  const chart = window.echarts.init(container);
  chart.setOption(option, true);

  chartInstances.set(container, chart);
  liveCharts.add(chart);

  if (window.ResizeObserver) {
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => chart.resize());
    });
    observer.observe(container);
    chartResizeObservers.set(container, observer);
  }

  window.requestAnimationFrame(() => chart.resize());
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function formatAnnualTickLabel(index, tickMinutes = 15) {
  const minutesOfYear = index * tickMinutes;
  const dayIndex = Math.floor(minutesOfYear / 1440);
  const minuteOfDay = minutesOfYear % 1440;
  let dayOfMonth = dayIndex + 1;
  let monthIndex = 0;
  while (monthIndex < MONTH_DAYS.length - 1 && dayOfMonth > MONTH_DAYS[monthIndex]) {
    dayOfMonth -= MONTH_DAYS[monthIndex];
    monthIndex += 1;
  }
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${monthIndex + 1}/${dayOfMonth} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function lineOption(series, unit = "", options = {}) {
  const tickMinutes = options.tickMinutes || 15;
  const xData = series[0]?.data?.map((_, i) =>
    options.annualTimeAxis ? formatAnnualTickLabel(i, tickMinutes) : i + 1
  ) || [];
  const hasRightAxis = series.some((item) => item.yAxisIndex === 1);
  return {
    animation: false,
    grid: { left: 54, right: hasRightAxis ? 54 : 28, top: 54, bottom: 72 },
    tooltip: { trigger: "axis" },
    legend: { top: 4, type: "scroll" },
    toolbox: {
      right: 10, top: 4,
      feature: { dataZoom: { yAxisIndex: "none" }, restore: {}, saveAsImage: {} }
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "slider", xAxisIndex: 0, height: 22, bottom: 24, filterMode: "none" }
    ],
    xAxis: { type: "category", boundaryGap: false, data: xData },
    yAxis: hasRightAxis
      ? [
        { type: "value", name: unit || "kW", scale: true },
        { type: "value", name: "%", min: 0, max: 100 }
      ]
      : { type: "value", name: unit, scale: true },
    series: series.map((item) => ({
      type: "line", showSymbol: false, smooth: false, ...item
    }))
  };
}

function barOption(labels, series, unit = "") {
  return {
    animation: false,
    grid: { left: 54, right: 28, top: 54, bottom: 72 },
    tooltip: { trigger: "axis" },
    legend: { top: 4, type: "scroll" },
    toolbox: {
      right: 10, top: 4,
      feature: { dataZoom: { yAxisIndex: "none" }, restore: {}, saveAsImage: {} }
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "slider", xAxisIndex: 0, height: 22, bottom: 24, filterMode: "none" }
    ],
    xAxis: { type: "category", data: labels },
    yAxis: { type: "value", name: unit, scale: true },
    series: series.map((item) => ({
      type: item.type || "bar",
      barMaxWidth: 32,
      smooth: item.type === "line",
      showSymbol: item.type === "line" ? false : undefined,
      ...item
    }))
  };
}

function metricCardHtml(label, value, note = "", status = "参考") {
  return `<div class="metric-card"><span>${label}</span><strong>${value}</strong><small>${note}</small><em>${status}</em></div>`;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function tableHtml(headers, rows) {
  return `
    <table class="data-table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>
  `;
}

function renderJsonResults(state) {
  STAGE_ORDER.forEach((key) => {
    const target = dom.results[key];
    const stage = state.stages[key];
    if (!target || !stage) return;
    if (stage.error) {
      target.textContent = `${key.toUpperCase()} 出错：${stage.error}`;
      return;
    }
    if (!stage.result) {
      target.textContent = stage.status === "locked" ? `${key.toUpperCase()} 尚未解锁。` : `${key.toUpperCase()} 尚未运行。`;
      return;
    }
    const slim = {
      contract: stage.result.contract,
      summary: stage.result.summary,
      hardwarePlan: stage.result.hardwarePlan,
      economics: stage.result.economics,
      offgridBaselineCheck: stage.result.offgridBaselineCheck,
      scenarios: stage.result.scenarios ? Object.fromEntries(
        Object.entries(stage.result.scenarios).map(([scenarioKey, value]) => [scenarioKey, { summary: value.summary }])
      ) : undefined,
      scenarioOptimums: stage.result.scenarioOptimums ? Object.fromEntries(
        Object.entries(stage.result.scenarioOptimums).map(([scenarioKey, value]) => [
          scenarioKey,
          {
            scenarioLabel: value.scenarioLabel,
            optimizationLabel: value.optimizationLabel,
            feasibleCount: value.feasibleCount,
            demandProfile: value.demandProfile,
            recommendedConfig: value.recommendedConfig ? {
              hardwarePlan: value.recommendedConfig.hardwarePlan,
              deltas: value.recommendedConfig.deltas,
              feasibility: value.recommendedConfig.feasibility,
              validationMetrics: value.recommendedConfig.validationMetrics,
              riskMetrics: value.recommendedConfig.riskMetrics,
              gridMetrics: value.recommendedConfig.gridMetrics,
              energyMetrics: value.recommendedConfig.energyMetrics,
              costMetrics: value.recommendedConfig.costMetrics,
              searchMeta: value.recommendedConfig.searchMeta
            } : null
          }
        ])
      ) : undefined,
      comparison: stage.result.comparison,
      uiPayload: stage.result.uiPayload ? {
        scenarioCards: stage.result.uiPayload.scenarioCards,
        comparisonRows: stage.result.uiPayload.comparisonRows,
        recommendationCards: stage.result.uiPayload.recommendationCards
      } : undefined
    };
    target.textContent = JSON.stringify(slim, null, 2);
  });
}

function renderNavigation(state) {
  dom.stageTabs.forEach((tab) => {
    const key = tab.dataset.stage;
    const stage = state.stages[key];
    tab.classList.toggle("active", state.activeStage === key);
    tab.classList.toggle("locked", stage?.status === "locked");
    tab.disabled = stage?.status === "locked";
  });

  dom.stagePanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === state.activeStage);
  });

  Object.entries(dom.buttons).forEach(([key, button]) => {
    const stage = state.stages[key];
    if (!button || !stage) return;
    button.disabled = stage.status === "locked" || stage.status === "running";
    button.textContent = stageButtonText(key, stage.status);
  });

  const activeMeta = STAGES[state.activeStage] || STAGES.m1;
  setText(dom.stageTitle, activeMeta.title);
  setText(dom.globalStatus, `${activeMeta.title} · ${statusLabel(state.stages[state.activeStage]?.status)}`);
}

function renderTopSummary(state) {
  const doneStages = STAGE_ORDER.filter((key) => state.stages[key]?.status === "done");
  const m1 = state.stages.m1.result;
  const m2 = state.stages.m2.result;
  const m3 = state.stages.m3.result;
  const offgridRule = getScenarioSummary(m2, "offgrid_rule");
  const bestKey =
    m3?.comparison?.recommendedByCondition?.lowestAnnualCost?.scenarioKey ||
    m3?.comparison?.recommendedForEngineering ||
    m3?.comparison?.lowestAnnualCostScenario ||
    m3?.comparison?.lowestTotalCostScenario;

  setText(dom.kpis.status, state.stages[state.activeStage]?.status === "running" ? "运行中" : "就绪");
  setText(dom.kpis.stage, state.activeStage.toUpperCase());
  setText(dom.kpis.unlock, doneStages.length ? `已完成 ${doneStages.join(" / ").toUpperCase()}` : "仅 M1");
  setText(dom.kpis.worker, state.workerStatus || "idle");
  setText(dom.kpis.capex, m1?.economics?.capexWan != null ? `${n(m1.economics.capexWan, 1)} 万` : "--");
  setText(dom.kpis.unmet, offgridRule.unservedEnergyKwh != null ? `${n(offgridRule.unservedEnergyKwh, 1)} kWh` : "--");
  setText(dom.kpis.serviceRate, offgridRule.serviceRate != null ? pct(offgridRule.serviceRate, 1) : "--");

  if (m3) {
    const label = SCENARIOS.find((item) => item.key === bestKey)?.label || "四情景优化已完成";
    setText(dom.report.headline, `推荐关注：${label}`);
    setText(dom.report.subtitle, "M3 已给出 C1-C4 四套情景最优配置，可用于论文结果页的横向比较。");
    setText(dom.report.action, "查看 M3");
    setText(dom.report.actionNote, "比较四套方案");
    setText(dom.report.riskMonths, label);
  } else if (m2) {
    setText(dom.report.headline, "S0 四情景运行评价已完成");
    setText(dom.report.subtitle, "M2 已完成 S0 在四情景下的全年运行评价，下一步进入 M3 做情景化配置优化。");
    setText(dom.report.action, "运行 M3");
    setText(dom.report.actionNote, "生成 C1-C4");
    setText(dom.report.riskMonths, offgridRule.unservedEnergyKwh > 0 ? "离网缺口" : "待比较");
  } else if (m1) {
    setText(dom.report.headline, "S0 离网基准配置已生成");
    setText(dom.report.subtitle, "M1 已完成标准周设计需求与 S0 基准硬件配置，下一步进入 M2 做全年四情景评价。");
    setText(dom.report.action, "运行 M2");
    setText(dom.report.actionNote, "评价 S0");
    setText(dom.report.riskMonths, "待 M2 识别");
  } else {
    setText(dom.report.headline, "等待 M1 生成 S0 基准配置");
    setText(dom.report.subtitle, "完成三阶段计算后，这里会汇总 S0 基准配置、四情景运行表现与最终情景化推荐。");
    setText(dom.report.action, "运行 M1");
    setText(dom.report.actionNote, "生成 S0");
    setText(dom.report.riskMonths, "--");
  }
  setText(dom.report.capex, m1?.economics?.capexWan != null ? n(m1.economics.capexWan, 1) : "--");
  setText(dom.report.service, offgridRule.serviceRate != null ? pct(offgridRule.serviceRate, 1) : "--");
}

function renderM1(state) {
  const result = state.stages.m1.result;
  const el = dom.m1Summary;
  const weather = result?.weatherSummary || null;

  if (el.weatherStatus) {
    const status = state.input.weather?.gTiltStatus || "尚未加载 TMY CSV";
    el.weatherStatus.innerHTML = `
      <div><span>数据状态</span><strong>${status}</strong></div>
      <div><span>M1 气象口径</span><strong>${weather?.sourceLabel || "城市默认气候参数"}</strong></div>
      <div><span>最弱光照月</span><strong>${weather?.worstMonthByDailyHPSName || "--"}</strong></div>
      <div><span>年均日 HPS</span><strong>${weather?.avgSolar != null ? `${n(weather.avgSolar, 2)} h/day` : "--"}</strong></div>
    `;
  }

  if (!result) {
    setText(el.title, "尚未生成 S0");
    setText(el.meta, "M1 输出是基准配置，不代表最终推荐方案。");
    ["pv", "storage", "pcs", "piles", "capex", "dailyKwh"].forEach((key) => setText(el[key], "--"));
    resetChart(el.powerChart, "运行 M1 后展示基准气象下标准周 EV 负荷、PV 与 SOC。");
    resetChart(el.occupancyChart, "运行 M1 后展示快慢充占用需求。");
    resetChart(el.capexChart, "运行 M1 后展示投资构成。");
    resetChart(el.monthChart, "运行 M1 后展示 S0 的 12 个月气象适应性校验。");
    if (el.chartNote) setText(el.chartNote, "运行 M1 后展示基准加权气象下的标准周运行曲线。");
    if (el.checkKpis) el.checkKpis.innerHTML = '<div class="empty-note">运行 M1 后展示 S0 离网基准核心指标。</div>';
    if (el.checkTable) el.checkTable.innerHTML = '<div class="empty-note">运行 M1 后展示 S0 基准自洽性校验。</div>';
    if (el.demandTable) el.demandTable.innerHTML = '<div class="empty-note">运行 M1 后展示标准周需求与桩服务结果。</div>';
    if (el.monthTable) el.monthTable.innerHTML = '<div class="empty-note">运行 M1 后展示 12 个月校验明细。</div>';
    return;
  }

  const plan = result.hardwarePlan || {};
  const economics = result.economics || {};
  const demand = result.demandProfile || {};
  const check = result.offgridBaselineCheck || {};
  const monthlyCheck = result.monthlyAdaptationCheck || {};
  const monthly = safeArray(monthlyCheck.monthlyChecks);
  const chart = result.chartData || {};
  const lcoe = economics.lcoeYuanPerKwh ?? check.lcoeYuanPerKwh ?? result.baselineMatch?.lcoeYuanPerKwh;

  setText(el.title, result.summary?.title || "S0 离网基准配置已生成");
  setText(el.meta, `${result.summary?.city || "--"} · 标准周日均需求 ${n(demand.totalDailyKwh, 1)} kWh/day · 基准气象 ${check.baselineWeatherType || "weighted average"} · LCOE ${n(lcoe, 3)} 元/kWh · S0 将传递给 M2`);
  setText(el.pv, n(plan.pvKw, 0));
  setText(el.storage, n(plan.storageKwh, 0));
  setText(el.pcs, n(plan.pcsKw, 0));
  setText(el.piles, `${plan.n7kw || 0} / ${plan.n30kw || 0}`);
  setText(el.capex, n(economics.capexWan, 1));
  setText(el.dailyKwh, n(demand.totalDailyKwh, 1));

  if (el.checkKpis) {
    el.checkKpis.innerHTML = [
      metricCardHtml("年等效未满足电量", `${n(check.annualEquivalentUnservedKwh, 1)} kWh`, `基准缺口率 ${pct(check.unservedRate || 0, 2)}`, (check.unservedRate || 0) <= 0.01 ? "通过" : "关注"),
      metricCardHtml("供能满足率", pct(check.serviceRate, 2), "标准周 × 基准气象", check.serviceRate >= 0.99 ? "通过" : "风险"),
      metricCardHtml("最低 SOC", `${n(check.socMinPct, 1)}%`, "离网运行储能安全边界", check.socMinPct >= 8 ? "通过" : "风险"),
      metricCardHtml("LCOE", `${n(lcoe, 3)} 元/kWh`, "年化投资 + 运维 / 年等效需求", "经济性"),
      metricCardHtml("可再生供能占比", pct(check.renewableSupplyRate ?? check.renewableShare, 1), "PV 直接供能 + 储能供能 / 负荷", "参考"),
      metricCardHtml("PV 自用率", pct(check.pvSelfUseRate, 1), "已利用 PV / PV 总发电", "参考"),
      metricCardHtml("弃光率", `${n(check.curtailmentRatePct, 1)}%`, `弃光 ${n(check.curtailmentKwh, 1)} kWh`, "参考"),
      metricCardHtml("年等效 PV 发电", `${n(check.pvGenerationAnnualKwh, 1)} kWh`, "基准气象标准周年化", "参考"),
      metricCardHtml("月度风险提示", monthlyCheck.worstMonthName || "--", `最差月缺口 ${n(monthlyCheck.worstMonthUnservedKwh, 1)} kWh`, "提示")
    ].join("");
  }

  if (el.chartNote) {
    setText(el.chartNote, '当前曲线展示 S0 在“标准周需求 × 加权平均基准气象”下的离网运行状态；最差月风险请看下方月度适应性校验。');
  }

  renderChart(el.powerChart, chart.ev?.length ? lineOption([
    { name: "EV 负荷", data: chart.ev || [] },
    { name: "PV 出力", data: chart.pv || [] },
    { name: "SOC", data: chart.soc || [] }
  ], "kW / %") : null, "运行 M1 后展示基准气象下标准周 EV 负荷、PV 与 SOC。");

  renderChart(el.occupancyChart, (chart.fastOcc?.length || chart.slowOcc?.length) ? lineOption([
    { name: "快充占用", data: chart.fastOcc || [] },
    { name: "慢充占用", data: chart.slowOcc || [] },
    { name: "原始快充需求", data: chart.rawFastOcc || [] },
    { name: "原始慢充需求", data: chart.rawSlowOcc || [] }
  ], "端口数") : null, "运行 M1 后展示快慢充占用需求。");

  renderChart(el.capexChart, {
    tooltip: { trigger: "item" },
    legend: { bottom: 0 },
    series: [{
      type: "pie",
      radius: ["42%", "70%"],
      data: [
        { name: "PV", value: economics.pvCapexWan || 0 },
        { name: "储能", value: (economics.storageEnergyCapexWan || 0) + (economics.storagePowerCapexWan || 0) },
        { name: "充电桩", value: economics.chargerCapexWan || 0 },
        { name: "EMS", value: economics.emsCapexWan || 0 }
      ]
    }]
  }, "运行 M1 后展示投资构成。");

  if (el.checkTable) {
    el.checkTable.innerHTML = tableHtml(
      ["指标", "结果", "说明"],
      [
        ["基准气象口径", check.baselineWeatherType || "--", "12 个月月度典型气象加权平均，不是最差月"],
        ["年等效未满足电量", `${n(check.annualEquivalentUnservedKwh, 1)} kWh`, "基准气象标准周结果折算为年等效"],
        ["基准缺口率", pct(check.unservedRate || 0, 2), "未满足电量 / 基准需求"],
        ["供能满足率", pct(check.serviceRate, 2), check.serviceRate >= 0.99 ? "满足 S0 基准要求" : "存在供能风险"],
        ["最低 SOC", `${n(check.socMinPct, 1)}%`, check.socMinPct >= 8 ? "储能安全边界可接受" : "储能存在触底风险"],
        ["LCOE", `${n(lcoe, 3)} 元/kWh`, "满足可靠性后的经济性排序指标"],
        ["可再生供能占比", pct(check.renewableSupplyRate ?? check.renewableShare, 1), "PV 直接供能 + 储能供能 / 负荷"],
        ["PV 自用率", pct(check.pvSelfUseRate, 1), "已利用 PV / PV 总发电"],
        ["弃光率", `${n(check.curtailmentRatePct, 1)}%`, "用于判断 PV 是否明显过配"],
        ["电网购电", "0 kWh", "M1 是离网基准配置，不允许电网兜底"]
      ]
    );
  }

  if (el.demandTable) {
    el.demandTable.innerHTML = tableHtml(
      ["项目", "结果", "说明"],
      [
        ["标准周总需求", `${n(demand.totalWeekKwh, 1)} kWh`, "M1 标准周设计负荷"],
        ["日均需求", `${n(demand.totalDailyKwh, 1)} kWh/day`, "用于估算 S0 能源侧规模"],
        ["峰值负荷", `${n(demand.peakLoadKw, 1)} kW`, "桩服务后峰值负荷"],
        ["原始峰值负荷", `${n(demand.rawPeakLoadKw, 1)} kW`, "未经过桩服务削峰前的需求峰值"],
        ["平均单次需求", `${n(demand.averageSessionNeedKwh, 1)} kWh`, "车辆充电事件平均能量需求"],
        ["桩侧未满足电量", `${n(demand.unmetByPileKwh, 1)} kWh`, "由桩服务能力不足导致"],
        ["排队未满足电量", `${n(demand.queueUnmetKwh, 1)} kWh`, "排队或等待导致"],
        ["放弃车辆数", `${demand.abandonedCount || 0}`, "未能完成服务的车辆事件数"],
        ["快充事件数", `${demand.fastCount || 0}`, "FAST 事件"],
        ["慢充事件数", `${demand.slowCount || 0}`, "SLOW 事件"]
      ]
    );
  }

  renderChart(el.monthChart, monthly.length ? barOption(
    monthly.map((m) => m.monthName),
    [
      { name: "周缺口", data: monthly.map((m) => m.unservedKwhWeek || 0) },
      { name: "最低 SOC", type: "line", data: monthly.map((m) => m.socMinPct || 0) },
      { name: "弃光率", type: "line", data: monthly.map((m) => m.curtailmentRatePct || 0) }
    ],
    "kWh / %"
  ) : null, "运行 M1 后展示 S0 的 12 个月气象适应性校验。");

  if (el.monthTable) {
    el.monthTable.innerHTML = monthly.length
      ? tableHtml(
          ["月份", "权重", "周需求", "周缺口", "缺口率", "服务率", "最低 SOC", "弃光率"],
          monthly.map((m) => [
            m.monthName, n(m.weight, 3), `${n(m.demandKwhWeek, 1)} kWh`, `${n(m.unservedKwhWeek, 1)} kWh`,
            pct(m.unservedRate || 0, 2), pct(m.serviceRate, 2), `${n(m.socMinPct, 1)}%`, `${n(m.curtailmentRatePct, 1)}%`
          ])
        )
      : '<div class="empty-note">暂无月度适应性校验数据。</div>';
  }
}

function scenarioCard(result, scenario) {
  const summary = getScenarioSummary(result, scenario.key);
  const isGrid = scenario.key.startsWith("grid_");
  const metrics = isGrid
    ? [
      ["购电量", `${n(summary.gridImportKwh, 1)} kWh`],
      ["峰值功率", `${n(summary.peakLoadKw, 1)} kW`],
      ["购电成本", `${n(summary.gridCostYuan, 1)} 元`],
      ["电网依赖", pct(summary.gridDependencyRate, 1)]
    ]
    : [
      ["未满足电量", `${n(summary.unservedEnergyKwh, 1)} kWh`],
      ["服务满足率", pct(summary.serviceRate, 1)],
      ["最低 SOC", `${n(summary.socMinPct, 1)}%`],
      ["缺口时长", `${n(summary.deficitHours || summary.blackoutHours || 0, 1)} h`]
    ];
  return `
    <article class="scenario-card ${scenario.key}">
      <div class="scenario-head"><span>${scenario.row}</span><strong>${scenario.label}</strong><small>${scenario.col}</small></div>
      <div class="scenario-metrics">${metrics.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>
    </article>
  `;
}

function resetM2AnnualCharts(el) {
  Object.entries(el.annualCharts || {}).forEach(([scenarioKey, container]) => {
    const scenario = SCENARIOS.find((item) => item.key === scenarioKey);
    resetChart(container, `运行 M2 后展示 ${scenario?.label || scenarioKey} 全年运行曲线。`);
  });
}

function renderM2AnnualScenarioChart(result, scenarioKey, container) {
  const chart = getScenarioChart(result, scenarioKey);
  if (!chart?.ev?.length) {
    resetChart(container, "暂无该情景的全年运行曲线数据。");
    return;
  }
  const isGrid = scenarioKey.startsWith("grid_");
  const originalDemand = result?.demandProfiles?.initial?.loadCurve || [];
  const showOriginalDemand = scenarioKey.endsWith("_dispatch") && originalDemand.length;
  const usesNativeGtilt = result?.weatherSummary?.simulationWeatherMode === "annual_native_gtilt";
  const pvName = usesNativeGtilt ? "PV 出力（8760 G_tilt）" : "PV 出力";
  renderChart(container, lineOption([
    { name: "EV 负荷", data: chart.ev || [], step: "end" },
    ...(showOriginalDemand ? [{ name: "原始需求", data: originalDemand, step: "end", lineStyle: { type: "dashed" } }] : []),
    { name: pvName, data: chart.pv || [] },
    { name: "SOC", data: chart.soc || [], yAxisIndex: 1 },
    { name: "内部缺口", data: chart.internalDeficit || [], step: "end" },
    { name: isGrid ? "购电功率" : "最终未满足", data: isGrid ? (chart.grid || []) : (chart.unserved || []), step: "end" },
    { name: "弃光", data: chart.curtailed || [], step: "end" }
  ], "kW", {
    annualTimeAxis: true,
    tickMinutes: result?.horizon?.tickMinutes || 15
  }), "运行 M2 后展示全年情景运行曲线。");
}

function renderM2AnnualCharts(result, el) {
  const charts = el.annualCharts || {};
  SCENARIOS.forEach((scenario) => {
    renderM2AnnualScenarioChart(result, scenario.key, charts[scenario.key]);
  });
}

function renderM2(state) {
  const result = state.stages.m2.result;
  const m1 = state.stages.m1.result;
  const el = dom.m2Summary;
  if (m1) {
    const plan = m1.hardwarePlan || {};
    const economics = m1.economics || {};
    el.s0Summary.innerHTML = `
      <div><span>PV</span><strong>${n(plan.pvKw, 1)} kW</strong></div>
      <div><span>储能</span><strong>${n(plan.storageKwh, 1)} kWh</strong></div>
      <div><span>PCS</span><strong>${n(plan.pcsKw, 1)} kW</strong></div>
      <div><span>慢 / 快充</span><strong>${plan.n7kw || 0} / ${plan.n30kw || 0}</strong></div>
      <div><span>S0 投资</span><strong>${n(economics.capexWan, 1)} 万元</strong></div>
    `;
  } else {
    el.s0Summary.innerHTML = '<div class="empty-note">请先运行 M1 生成 S0。</div>';
  }
  if (!result) {
    setText(el.title, "等待 M2 运行");
    setText(el.meta, "M2 将用 S0 评价离网/入网与 D0/D1 四个全年情景。");
    el.scenarioMatrix.innerHTML = SCENARIOS.map((scenario) => scenarioCard(null, scenario)).join("");
    el.comparisonTable.innerHTML = '<div class="empty-note">运行 M2 后展示核心指标对比。</div>';
    el.valueCards.innerHTML = '<div class="empty-note">运行 M2 后展示调度价值与电网接入价值。</div>';
    resetM2AnnualCharts(el);
    return;
  }
  const horizon = result.horizon || {};
  const summary = result.summary || {};
  setText(el.title, "S0 全年四情景运行评价已完成");
  setText(el.meta, `${horizon.days || summary.annualDays || 365} 天 / ${horizon.ticks || summary.ticks || 35040} 步 / 固定 S0 硬件`);
  el.scenarioMatrix.innerHTML = SCENARIOS.map((scenario) => scenarioCard(result, scenario)).join("");
  const rows = [
    ["服务满足率", ...SCENARIOS.map((s) => pct(getScenarioSummary(result, s.key).serviceRate, 1))],
    ["内部缺口", ...SCENARIOS.map((s) => `${n(getScenarioSummary(result, s.key).internalDeficitKwh, 1)} kWh`)],
    ["最终未满足", ...SCENARIOS.map((s) => `${n(getScenarioSummary(result, s.key).unservedEnergyKwh, 1)} kWh`)],
    ["购电量", ...SCENARIOS.map((s) => `${n(getScenarioSummary(result, s.key).gridImportKwh, 1)} kWh`)],
    ["购电成本", ...SCENARIOS.map((s) => `${n(getScenarioSummary(result, s.key).gridCostYuan, 1)} 元`)],
    ["最低 SOC", ...SCENARIOS.map((s) => `${n(getScenarioSummary(result, s.key).socMinPct, 1)}%`)]
  ];
  el.comparisonTable.innerHTML = tableHtml(["指标", ...SCENARIOS.map((s) => s.label)], rows);
  renderM2AnnualCharts(result, el);
  const comparison = result.comparison || {};
  el.valueCards.innerHTML = `
    <div class="value-card"><span>离网调度价值</span><strong>${n(comparison.dispatchGainOffgrid?.unservedReductionKwh, 1)} kWh</strong><small>未满足电量降低</small></div>
    <div class="value-card"><span>入网调度价值</span><strong>${n(comparison.dispatchGainGrid?.gridImportReductionKwh, 1)} kWh</strong><small>购电量降低</small></div>
    <div class="value-card"><span>电网接入价值</span><strong>${n(comparison.gridAccessGain?.unservedReductionKwh, 1)} kWh</strong><small>未满足电量降低</small></div>
  `;
}

function getOptimum(result, key) {
  return result?.scenarioOptimums?.[key]?.recommendedConfig || null;
}

function getM3ScenarioCards(result) {
  const cards = result?.uiPayload?.scenarioCards;
  if (Array.isArray(cards) && cards.length) return cards;

  return SCENARIOS.map((scenario) => {
    const optimum = result?.scenarioOptimums?.[scenario.key] || {};
    const recommended = optimum.recommendedConfig || {};
    const cost = recommended.costMetrics || {};
    const validation = recommended.validationMetrics || recommended.riskMetrics || {};
    const grid = recommended.gridMetrics || {};
    const energy = recommended.energyMetrics || {};

    return {
      scenarioKey: scenario.key,
      title: scenario.label,
      optimizationLabel: optimum.optimizationLabel || "情景最优配置",
      feasible: Boolean(recommended.feasibility?.feasible),
      feasibleCount: optimum.feasibleCount || 0,
      candidateCount: optimum.evaluatedCandidates?.length || 0,
      demandProfile: optimum.demandProfile || null,
      hardwarePlan: recommended.hardwarePlan || {},
      deltas: recommended.deltas || {},
      savingVsBaseline: result?.comparison?.scenarioSavingsVsBaseline?.[scenario.key] || null,
      keyMetrics: {
        annualTotalCostWan: cost.annualTotalCostWan ?? cost.totalCostProxyWan,
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
        curtailmentRatePct: energy.curtailmentRatePct
      },
      feasibility: recommended.feasibility || null,
      searchMeta: recommended.searchMeta || null,
      note: recommended.feasibility?.feasible
        ? "该方案为当前候选集中满足约束后的年综合成本最低配置。"
        : "该方案未完全满足约束，仅作为当前候选集中的最优兜底结果。"
    };
  });
}

function getM3Card(result, scenarioKey) {
  return getM3ScenarioCards(result).find((card) => card.scenarioKey === scenarioKey) || null;
}

function getM3ComparisonRows(result) {
  const rows = result?.uiPayload?.comparisonRows;
  if (Array.isArray(rows) && rows.length) return rows;

  return getM3ScenarioCards(result).map((card) => {
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
      pvKw: card.hardwarePlan?.pvKw,
      storageKwh: card.hardwarePlan?.storageKwh,
      pcsKw: card.hardwarePlan?.pcsKw,
      n7kw: card.hardwarePlan?.n7kw,
      n30kw: card.hardwarePlan?.n30kw,
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

function getM3RecommendationCards(result) {
  const cards = result?.uiPayload?.recommendationCards;
  if (Array.isArray(cards) && cards.length) return cards;

  const recommended = result?.comparison?.recommendedByCondition || {};
  return [
    recommended.noGrid_noDispatch,
    recommended.noGrid_withDispatch,
    recommended.grid_noDispatch,
    recommended.grid_withDispatch,
    recommended.lowestAnnualCost
  ].filter(Boolean);
}

function scenarioShort(key) {
  return SCENARIOS.find((item) => item.key === key)?.short || "--";
}

function scenarioLabelByKey(key) {
  return SCENARIOS.find((item) => item.key === key)?.label || key || "--";
}

function optimumCard(result, scenario) {
  const card = getM3Card(result, scenario.key);
  const plan = card?.hardwarePlan || {};
  const metrics = card?.keyMetrics || {};
  const saving = card?.savingVsBaseline || {};
  const feasible = Boolean(card?.feasible);

  return `
    <article class="scenario-card optimum ${scenario.key} ${feasible ? "feasible" : "infeasible"}">
      <div class="scenario-head">
        <span>${scenario.short}</span>
        <strong>${scenario.label}</strong>
        <small>${feasible ? "最小可行配置" : "兜底候选配置"}</small>
      </div>
      <div class="scenario-metrics">
        <div><span>PV</span><strong>${n(plan.pvKw, 1)} kW</strong></div>
        <div><span>储能</span><strong>${n(plan.storageKwh, 1)} kWh</strong></div>
        <div><span>PCS</span><strong>${n(plan.pcsKw, 1)} kW</strong></div>
        <div><span>慢 / 快充</span><strong>${plan.n7kw ?? "--"} / ${plan.n30kw ?? "--"}</strong></div>
        <div><span>年综合成本</span><strong>${n(metrics.annualTotalCostWan, 1)} 万元</strong></div>
        <div><span>相对 S0 节省</span><strong>${n(saving.capexSavingWan, 1)} 万元</strong></div>
        <div><span>服务满足率</span><strong>${pct(metrics.serviceRate, 1)}</strong></div>
        <div><span>最低 SOC</span><strong>${n(metrics.socMinPct, 1)}%</strong></div>
      </div>
      <p class="scenario-note">${card?.note || ""}</p>
    </article>
  `;
}

function renderM3(state) {
  const result = state.stages.m3.result;
  const m2 = state.stages.m2.result;
  const el = dom.m3Summary;
  if (m2) {
    el.riskSummary.innerHTML = SCENARIOS.map((scenario) => {
      const summary = getScenarioSummary(m2, scenario.key);
      const main = scenario.key.startsWith("grid_")
        ? `服务率 ${pct(summary.serviceRate, 1)}，购电 ${n(summary.gridImportKwh, 1)} kWh，成本 ${n(summary.gridCostYuan, 1)} 元`
        : `服务率 ${pct(summary.serviceRate, 1)}，未满足 ${n(summary.unservedEnergyKwh, 1)} kWh，最低 SOC ${n(summary.socMinPct, 1)}%`;
      return `<div><span>${scenario.label}</span><strong>${main}</strong></div>`;
    }).join("");
  } else {
    el.riskSummary.innerHTML = `<div class="empty-note">请先运行 M2 形成四情景全年运行摘要。</div>`;
  }

  if (!result) {
    setText(el.title, "等待 M3 运行");
    setText(el.meta, "完成后输出 C1-C4 四套最小可行配置、相对 S0 削减量与按工程条件推荐。");
    el.optimumCards.innerHTML = SCENARIOS.map((scenario) => optimumCard(null, scenario)).join("");
    el.comparisonTable.innerHTML = `<div class="empty-note">运行 M3 后展示 C1-C4 配置、成本、削减量与可行性横向比较。</div>`;
    el.recommendation.innerHTML = `<div class="empty-note">运行 M3 后按"是否接电网 / 是否接受调度 / 最低年综合成本"生成推荐。</div>`;
    resetChart(el.capexChart, "运行 M3 后展示投资成本对比。");
    resetChart(el.capacityChart, "运行 M3 后展示设备容量对比。");
    resetChart(el.costChart, "运行 M3 后展示综合成本对比。");
    return;
  }

  setText(el.title, "C1-C4 四情景配置优化已完成");
  setText(
    el.meta,
    `候选配置 ${result.candidateCount || result.summary?.candidateCount || 0} 组 · 先满足全年约束，再按年综合成本筛选 C1-C4`
  );
  el.optimumCards.innerHTML = SCENARIOS.map((scenario) => optimumCard(result, scenario)).join("");

  const comparisonRows = getM3ComparisonRows(result);
  const rowByKey = Object.fromEntries(comparisonRows.map((row) => [row.scenarioKey, row]));

  const rows = [
    ["可行性", ...SCENARIOS.map((s) => rowByKey[s.key]?.feasible ? "可行" : "兜底")],
    ["PV 容量", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.pvKw, 1)} kW`)],
    ["储能容量", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.storageKwh, 1)} kWh`)],
    ["PCS 功率", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.pcsKw, 1)} kW`)],
    ["慢 / 快充", ...SCENARIOS.map((s) => `${rowByKey[s.key]?.n7kw ?? "--"} / ${rowByKey[s.key]?.n30kw ?? "--"}`)],
    ["相对 S0 投资节省", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.capexSavingWan, 1)} 万元`)],
    ["年综合成本", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.annualTotalCostWan, 1)} 万元`)],
    ["削减 PV", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.pvReductionKw, 1)} kW`)],
    ["削减储能", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.storageReductionKwh, 1)} kWh`)],
    ["削减 PCS", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.pcsReductionKw, 1)} kW`)],
    ["削减慢 / 快充", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.n7Reduction, 0)} / ${n(rowByKey[s.key]?.n30Reduction, 0)}`)],
    ["服务满足率", ...SCENARIOS.map((s) => pct(rowByKey[s.key]?.serviceRate, 1))],
    ["未满足电量", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.unservedEnergyKwh, 1)} kWh`)],
    ["最低 SOC", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.socMinPct, 1)}%`)],
    ["购电量", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.gridImportKwh, 1)} kWh`)],
    ["购电成本", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.gridCostYuan, 1)} 元`)],
    ["弃光率", ...SCENARIOS.map((s) => `${n(rowByKey[s.key]?.curtailmentRatePct, 1)}%`)]
  ];

  el.comparisonTable.innerHTML = tableHtml(
    ["指标", ...SCENARIOS.map((s) => `${s.short} ${s.label}`)],
    rows
  );

  const labels = SCENARIOS.map((scenario) => scenario.short);

  renderChart(el.capexChart, barOption(labels, [
    {
      name: "相对 S0 投资节省",
      data: SCENARIOS.map((scenario) => rowByKey[scenario.key]?.capexSavingWan || 0)
    },
    {
      name: "一次投资",
      data: SCENARIOS.map((scenario) => rowByKey[scenario.key]?.capexWan || 0)
    }
  ], "万元"), "运行 M3 后展示投资节省与一次投资对比。");

  renderChart(el.capacityChart, barOption(labels, [
    { name: "PV", data: SCENARIOS.map((scenario) => rowByKey[scenario.key]?.pvKw || 0) },
    { name: "储能", data: SCENARIOS.map((scenario) => rowByKey[scenario.key]?.storageKwh || 0) },
    { name: "PCS", data: SCENARIOS.map((scenario) => rowByKey[scenario.key]?.pcsKw || 0) }
  ], "kW / kWh"), "运行 M3 后展示设备容量对比。");

  renderChart(el.costChart, barOption(labels, [
    {
      name: "年综合成本",
      data: SCENARIOS.map((scenario) => rowByKey[scenario.key]?.annualTotalCostWan || 0)
    },
    {
      name: "购电成本",
      data: SCENARIOS.map((scenario) => {
        const row = rowByKey[scenario.key];
        return row?.gridCostYuan != null ? row.gridCostYuan / 10000 : 0;
      })
    }
  ], "万元/年"), "运行 M3 后展示年综合成本对比。");

  const recommendationCards = getM3RecommendationCards(result);

  el.recommendation.innerHTML = recommendationCards.length
    ? recommendationCards.map((item, index) => `
        <div class="recommendation-row ${index === recommendationCards.length - 1 ? "primary" : ""}">
          <span>${item.label || "推荐方案"}</span>
          <strong>${scenarioShort(item.scenarioKey)} ${scenarioLabelByKey(item.scenarioKey)}</strong>
          <small>
            ${item.feasible ? "可行" : "兜底"} ·
            年综合成本 ${n(item.annualTotalCostWan, 1)} 万元 ·
            服务率 ${pct(item.serviceRate, 1)} ·
            最低 SOC ${n(item.socMinPct, 1)}%
          </small>
        </div>
      `).join("")
    : `<div class="empty-note">暂无推荐结果。</div>`;
}

export function renderApp(state) {
  renderNavigation(state);
  renderTopSummary(state);
  renderM1(state);
  renderM2(state);
  renderM3(state);
  renderJsonResults(state);
}

window.addEventListener("resize", () => {
  liveCharts.forEach((chart) => chart.resize());
});
