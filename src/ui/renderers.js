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
            recommendedConfig: value.recommendedConfig ? {
              hardwarePlan: value.recommendedConfig.hardwarePlan,
              riskMetrics: value.recommendedConfig.riskMetrics,
              gridMetrics: value.recommendedConfig.gridMetrics,
              costMetrics: value.recommendedConfig.costMetrics
            } : null
          }
        ])
      ) : undefined,
      comparison: stage.result.comparison
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
  const bestKey = m3?.comparison?.recommendedForEngineering || m3?.comparison?.lowestTotalCostScenario;

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
    setText(dom.report.subtitle, "M2 已暴露离网缺口、并网购电与调度价值，下一步进入 M3 分情景优化。");
    setText(dom.report.action, "运行 M3");
    setText(dom.report.actionNote, "生成 C1-C4");
    setText(dom.report.riskMonths, offgridRule.unservedEnergyKwh > 0 ? "离网缺口" : "待比较");
  } else if (m1) {
    setText(dom.report.headline, "S0 离网基准配置已生成");
    setText(dom.report.subtitle, "M1 已完成标准周设计需求与基础硬件配置，下一步用压力月事件流进行四情景评价。");
    setText(dom.report.action, "运行 M2");
    setText(dom.report.actionNote, "评价 S0");
    setText(dom.report.riskMonths, "待 M2 识别");
  } else {
    setText(dom.report.headline, "等待 M1 生成 S0 基准配置");
    setText(dom.report.subtitle, "完成三阶段计算后，这里会汇总基准配置、四情景风险与最终情景化推荐。");
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

function optimumCard(result, scenario) {
  const item = getOptimum(result, scenario.key);
  const plan = item?.hardwarePlan || {};
  const risk = item?.riskMetrics || {};
  const grid = item?.gridMetrics || {};
  const cost = item?.costMetrics || {};
  return `
    <article class="scenario-card optimum ${scenario.key}">
      <div class="scenario-head"><span>${scenario.short}</span><strong>${scenario.label}</strong><small>情景最优配置</small></div>
      <div class="scenario-metrics">
        <div><span>PV</span><strong>${n(plan.pvKw, 1)} kW</strong></div>
        <div><span>储能</span><strong>${n(plan.storageKwh, 1)} kWh</strong></div>
        <div><span>PCS</span><strong>${n(plan.pcsKw, 1)} kW</strong></div>
        <div><span>追加投资</span><strong>${n(cost.extraCapexWan, 1)} 万元</strong></div>
        <div><span>未满足电量</span><strong>${n(risk.unservedEnergyKwh, 1)} kWh</strong></div>
        <div><span>电网依赖</span><strong>${scenario.key.startsWith("grid_") ? pct(grid.gridDependencyRate, 1) : "--"}</strong></div>
      </div>
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
        ? `购电 ${n(summary.gridImportKwh, 1)} kWh，成本 ${n(summary.gridCostYuan, 1)} 元`
        : `缺口 ${n(summary.unservedEnergyKwh, 1)} kWh，最低 SOC ${n(summary.socMinPct, 1)}%`;
      return `<div><span>${scenario.label}</span><strong>${main}</strong></div>`;
    }).join("");
  } else {
    el.riskSummary.innerHTML = `<div class="empty-note">请先运行 M2 形成四情景风险摘要。</div>`;
  }

  if (!result) {
    setText(el.title, "等待 M3 运行");
    setText(el.meta, "完成后输出四套情景最优配置与工程推荐。");
    el.optimumCards.innerHTML = SCENARIOS.map((scenario) => optimumCard(null, scenario)).join("");
    el.comparisonTable.innerHTML = `<div class="empty-note">运行 M3 后展示 C1-C4 横向比较。</div>`;
    el.recommendation.innerHTML = `<div class="empty-note">运行 M3 后生成离网、并网与综合工程推荐。</div>`;
    resetChart(el.capexChart, "运行 M3 后展示投资成本对比。");
    resetChart(el.capacityChart, "运行 M3 后展示设备容量对比。");
    resetChart(el.costChart, "运行 M3 后展示综合成本对比。");
    return;
  }

  setText(el.title, "C1-C4 四情景配置优化已完成");
  setText(el.meta, `候选配置 ${result.candidateCount || result.summary?.candidateCount || 0} 组 · 四情景分别筛选最优`);
  el.optimumCards.innerHTML = SCENARIOS.map((scenario) => optimumCard(result, scenario)).join("");

  const rows = [
    ["PV 容量", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.hardwarePlan?.pvKw, 1)} kW`)],
    ["储能容量", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.hardwarePlan?.storageKwh, 1)} kWh`)],
    ["PCS 功率", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.hardwarePlan?.pcsKw, 1)} kW`)],
    ["追加投资", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.costMetrics?.extraCapexWan, 1)} 万元`)],
    ["综合成本", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.costMetrics?.totalCostProxyWan, 1)} 万元`)],
    ["未满足电量", ...SCENARIOS.map((s) => `${n(getOptimum(result, s.key)?.riskMetrics?.unservedEnergyKwh, 1)} kWh`)],
    ["服务满足率", ...SCENARIOS.map((s) => pct(getOptimum(result, s.key)?.riskMetrics?.serviceRate, 1))],
    ["电网依赖率", ...SCENARIOS.map((s) => s.key.startsWith("grid_") ? pct(getOptimum(result, s.key)?.gridMetrics?.gridDependencyRate, 1) : "--")]
  ];
  el.comparisonTable.innerHTML = tableHtml(["指标", ...SCENARIOS.map((s) => `${s.short} ${s.label}`)], rows);

  const labels = SCENARIOS.map((scenario) => scenario.short);
  renderChart(el.capexChart, barOption(labels, [{
    name: "追加投资",
    data: SCENARIOS.map((scenario) => getOptimum(result, scenario.key)?.costMetrics?.extraCapexWan || 0)
  }], "万元"), "运行 M3 后展示投资成本对比。");

  renderChart(el.capacityChart, barOption(labels, [
    { name: "PV", data: SCENARIOS.map((scenario) => getOptimum(result, scenario.key)?.hardwarePlan?.pvKw || 0) },
    { name: "储能", data: SCENARIOS.map((scenario) => getOptimum(result, scenario.key)?.hardwarePlan?.storageKwh || 0) },
    { name: "PCS", data: SCENARIOS.map((scenario) => getOptimum(result, scenario.key)?.hardwarePlan?.pcsKw || 0) }
  ], "kW / kWh"), "运行 M3 后展示设备容量对比。");

  renderChart(el.costChart, barOption(labels, [{
    name: "综合成本",
    data: SCENARIOS.map((scenario) => getOptimum(result, scenario.key)?.costMetrics?.totalCostProxyWan || 0)
  }], "万元"), "运行 M3 后展示综合成本对比。");

  const comparison = result.comparison || {};
  const engineeringKey = comparison.recommendedForEngineering || comparison.lowestTotalCostScenario || "grid_dispatch";
  const engineering = SCENARIOS.find((scenario) => scenario.key === engineeringKey);
  el.recommendation.innerHTML = `
    <div class="recommendation-row"><span>离网优先</span><strong>C2 离网-优化调度</strong><small>相比 C1，关注硬件冗余节省与缺口控制。</small></div>
    <div class="recommendation-row"><span>并网优先</span><strong>C4 并网-优化调度</strong><small>相比 C3，关注购电成本与峰值功率下降。</small></div>
    <div class="recommendation-row primary"><span>综合工程</span><strong>${engineering?.short || "--"} ${engineering?.label || "--"}</strong><small>由综合成本、可靠性和电网依赖共同排序得到。</small></div>
    <div class="recommendation-row"><span>调度价值</span><strong>离网节省 ${n(comparison.dispatchValueOffgrid?.capexSavingWan, 1)} 万元</strong><small>并网综合成本节省 ${n(comparison.dispatchValueGrid?.totalCostSavingWan, 1)} 万元。</small></div>
  `;
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
