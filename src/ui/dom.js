export const dom = {
  stageTabs: [...document.querySelectorAll("[data-stage]")],
  stagePanels: [...document.querySelectorAll("[data-panel]")],
  stageTitle: document.getElementById("active-stage-title"),
  globalStatus: document.getElementById("global-status"),
  kpis: {
    status: document.getElementById("kpi-status"),
    stage: document.getElementById("kpi-stage"),
    unlock: document.getElementById("kpi-unlock"),
    worker: document.getElementById("kpi-worker"),
    capex: document.getElementById("kpi-capex"),
    unmet: document.getElementById("kpi-unmet"),
    serviceRate: document.getElementById("kpi-service-rate")
  },
  report: {
    headline: document.getElementById("report-headline"),
    subtitle: document.getElementById("report-subtitle"),
    action: document.getElementById("report-action"),
    actionNote: document.getElementById("report-action-note"),
    capex: document.getElementById("report-capex"),
    service: document.getElementById("report-service"),
    riskMonths: document.getElementById("report-risk-months")
  },
  buttons: {
    m1: document.getElementById("run-m1"),
    m2: document.getElementById("run-m2"),
    m3: document.getElementById("run-m3")
  },
  results: {
    m1: document.getElementById("result-m1"),
    m2: document.getElementById("result-m2"),
    m3: document.getElementById("result-m3")
  },
  m1Inputs: [...document.querySelectorAll("[data-m1-input]")],
  m2Inputs: [...document.querySelectorAll("[data-m2-input]")],
  m3Inputs: [...document.querySelectorAll("[data-m3-input]")],
  weatherCsvFile: document.getElementById("m1-csv-file"),
  weatherCsvStatus: document.getElementById("m1-csv-status"),
  m1Summary: {
    title: document.getElementById("m1-summary-title"),
    meta: document.getElementById("m1-summary-meta"),
    pv: document.getElementById("m1-pv"),
    storage: document.getElementById("m1-storage"),
    pcs: document.getElementById("m1-pcs"),
    piles: document.getElementById("m1-piles"),
    capex: document.getElementById("m1-capex"),
    dailyKwh: document.getElementById("m1-daily-kwh"),
    capexChart: document.getElementById("m1-capex-echart"),
    powerChart: document.getElementById("m1-power-echart"),
    occupancyChart: document.getElementById("m1-occupancy-chart"),
    checkTable: document.getElementById("m1-check-table"),
    weatherStatus: document.getElementById("m1-weather-status"),
    checkKpis: document.getElementById("m1-check-kpis"),
    chartNote: document.getElementById("m1-chart-note"),
    monthChart: document.getElementById("m1-month-echart"),
    monthTable: document.getElementById("m1-month-table"),
    demandTable: document.getElementById("m1-demand-table")
  },
  m2Summary: {
    title: document.getElementById("m2-summary-title"),
    meta: document.getElementById("m2-summary-meta"),
    s0Summary: document.getElementById("m2-s0-summary"),
    demandProfiles: document.getElementById("m2-demand-profiles"),
    scenarioMatrix: document.getElementById("m2-scenario-matrix"),
    comparisonTable: document.getElementById("m2-comparison-table"),
    annualCharts: {
      offgrid_rule: document.getElementById("m2-annual-chart-offgrid-rule"),
      offgrid_dispatch: document.getElementById("m2-annual-chart-offgrid-dispatch"),
      grid_rule: document.getElementById("m2-annual-chart-grid-rule"),
      grid_dispatch: document.getElementById("m2-annual-chart-grid-dispatch")
    },
    valueCards: document.getElementById("m2-value-cards"),
    pressureAnalysis: document.getElementById("m2-pressure-analysis"),
    riskDiagnosis: document.getElementById("m2-risk-diagnosis")
  },
  m3Summary: {
    title: document.getElementById("m3-summary-title"),
    meta: document.getElementById("m3-summary-meta"),
    riskSummary: document.getElementById("m3-risk-summary"),
    optimumCards: document.getElementById("m3-optimum-cards"),
    comparisonTable: document.getElementById("m3-comparison-table"),
    capexChart: document.getElementById("m3-capex-chart"),
    capacityChart: document.getElementById("m3-capacity-chart"),
    costChart: document.getElementById("m3-cost-chart"),
    recommendation: document.getElementById("m3-recommendation")
  }
};
