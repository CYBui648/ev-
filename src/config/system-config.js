export const STAGES = {
  m1: {
    key: "m1",
    index: 1,
    title: "M1 基准配置生成",
    jobType: "M1_PLAN"
  },
  m2: {
    key: "m2",
    index: 2,
    title: "M2 四情景运行仿真",
    jobType: "M2_SCENARIO_COMPARE"
  },
  m3: {
    key: "m3",
    index: 3,
    title: "M3 四情景配置优化",
    jobType: "M3_SCENARIO_OPTIMIZATION"
  }
};

export const STAGE_ORDER = ["m1", "m2", "m3"];

export const DEFAULT_PROJECT_INPUT = {
  projectName: "公共机构停车场光储充评估",
  weather: {
    gTiltData: null,
    gTiltStatus: "尚未加载 TMY CSV",
    source: "TMY 8760 G_tilt"
  },
  m1: {
    climateKey: "guangzhou",
    evCount: 100,
    teacherRatio: 0.80,
    batteryCapMean: 65,
    initSocMean: 0.40,
    targetSocMean: 0.95,
    slaFast: 0.95,
    slaSlow: 0.85,
    renewableTarget: 0.50,
    backupDays: 0,
    holidayRatio: 0.10,
    pvEfficiency: 0.72,
    pvPrice: 1.50,
    pvRate: 15,
    storBasePrice: 1.00,
    storRate: 12,
    cost7kw: 0.30,
    cost30kw: 2.50,
    transformerUpgradeCostWanPerKw: 0.03,
    matrixPowerUpgradeCostWanPerKw: 0.02,
    ems: 10,
    roofArea: 10000,
    evRatio: 3,
    anxietyRatio: 0.20,
    mileage: 30,
    consumption: 15
  },
  m2: {
    monthMode: "auto",
    monthIndex: 0,
    transformerLimitKw: 500,
    teacherRatio: 0.80,
    anxietyRatio: 0.20
  },
  m3: {
    priceShiftThreshold: 0.55,
    opexRate: 0.015
  }
};
