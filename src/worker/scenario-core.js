import { CITY_CLIMATE_DATA } from "../config/climate-data.js";
import {
  buildWeatherScenarioFromGTilt,
  buildWeatherSummary,
  MONTH_DAYS,
  MONTH_NAMES
} from "./weather-utils.js";
import { SCENARIO_DEFINITIONS, SCENARIO_KEYS } from "./scenario-definitions.js";

const TICKS_PER_DAY = 96;
const TICK_HOURS = 0.25;
const DIRECT_EFFICIENCY = 0.92;
const DEFAULT_TOU = { valley: 0.30, flat: 0.70, peak: 1.10 };
const DEFAULT_HOURLY_PV = [
  0, 0, 0, 0, 0, 0, 0.05, 0.2, 0.5, 0.8, 1.0, 0.95,
  0.8, 0.5, 0.2, 0.05, 0, 0, 0, 0, 0, 0, 0, 0
];

export function round(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6D2B79F5;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(random, mean, stdDev) {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * stdDev + mean;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length - 1) * p)));
  return sorted[index];
}

export function getTouPrice(hour, touPrice = DEFAULT_TOU) {
  if (hour < 8) return touPrice.valley;
  if ((hour >= 10 && hour < 12) || (hour >= 14 && hour < 19)) return touPrice.peak;
  return touPrice.flat;
}

function buildBasePvShape96() {
  return Array.from({ length: TICKS_PER_DAY }, (_, tick) => {
    const hour = Math.floor(tick / 4);
    const sub = (tick % 4) / 4;
    const current = DEFAULT_HOURLY_PV[hour] || 0;
    const next = DEFAULT_HOURLY_PV[Math.min(23, hour + 1)] || current;
    return current + (next - current) * sub;
  });
}

function scaleShapeToDailyHps(shape, dailyHps) {
  const currentHps = shape.reduce((sum, value) => sum + value * TICK_HOURS, 0) || 1;
  const scale = Math.max(0, dailyHps) / currentHps;
  return shape.map((value) => value * scale);
}

export function normalizeProjectInput(context = {}) {
  const input = context.input || {};
  const m1 = input.m1 || {};
  const m2 = input.m2 || {};
  const m3 = input.m3 || {};
  const weatherInput = input.weather || {};
  const climate = CITY_CLIMATE_DATA[m1.climateKey] || CITY_CLIMATE_DATA.guangzhou;
  const gTiltData = Array.isArray(weatherInput.gTiltData)
    ? weatherInput.gTiltData
    : (Array.isArray(m2.gTiltData) ? m2.gTiltData : null);
  const fittedWeather = buildWeatherScenarioFromGTilt(gTiltData, climate) || null;
  const weather = fittedWeather || climate;

  return {
    climateKey: m1.climateKey || "guangzhou",
    climate,
    weather,
    fittedWeather,
    weatherSummary: buildWeatherSummary(fittedWeather || climate),
    evCount: safeNumber(m1.evCount, 100),
    teacherRatio: clamp(safeNumber(m1.teacherRatio, 0.8), 0, 1),
    anxietyRatio: clamp(safeNumber(m1.anxietyRatio, 0.2), 0, 1),
    batteryCapMean: safeNumber(m1.batteryCapMean, 65),
    initSocMean: clamp(safeNumber(m1.initSocMean, 0.4), 0.05, 0.95),
    targetSocMean: clamp(safeNumber(m1.targetSocMean, 0.95), 0.2, 1),
    holidayRatio: clamp(safeNumber(m1.holidayRatio, 0.1), 0, 1),
    evRatio: Math.max(1, safeNumber(m1.evRatio, 3)),
    slaFast: clamp(safeNumber(m1.slaFast, 0.95), 0, 1),
    slaSlow: clamp(safeNumber(m1.slaSlow, 0.85), 0, 1),
    renewableTarget: clamp(safeNumber(m1.renewableTarget, 0.5), 0, 1),
    roofArea: Math.max(0, safeNumber(m1.roofArea, 10000)),
    pvEfficiency: clamp(safeNumber(m1.pvEfficiency, 0.72), 0.1, 1),
    pvPrice: safeNumber(m1.pvPrice, 1.5),
    pvRate: safeNumber(m1.pvRate, 15),
    storBasePrice: safeNumber(m1.storBasePrice, 1),
    storRate: safeNumber(m1.storRate, 12),
    cost7kw: safeNumber(m1.cost7kw, 0.3),
    cost30kw: safeNumber(m1.cost30kw, 2.5),
    ems: safeNumber(m1.ems, 10),
    transformerLimitKw: safeNumber(m2.transformerLimitKw, 500),
    monthMode: m2.monthMode || "auto",
    monthIndex: clamp(Math.trunc(safeNumber(m2.monthIndex, 0)), 0, 11),
    gTiltData,
    priceShiftThreshold: clamp(safeNumber(m3.priceShiftThreshold, 0.55), 0, 1),
    opexRate: clamp(safeNumber(m3.opexRate, 0.015), 0, 0.2)
  };
}

export function getStorageUnitPrice(storageKwh, basePrice = 1) {
  if (storageKwh <= 500) return Math.max(0.5, (1.10 + (500 - storageKwh) * 0.0004) * basePrice);
  if (storageKwh <= 1500) return Math.max(0.5, (0.85 + (1500 - storageKwh) * 0.000125) * basePrice);
  if (storageKwh <= 3000) return Math.max(0.5, (0.70 + (3000 - storageKwh) * 0.000067) * basePrice);
  return Math.max(0.5, 0.65 * basePrice);
}

export function calcCapexWan(hardware, params) {
  const pvCapexWan = hardware.pvKw * 1000 * params.pvPrice * (1 + params.pvRate / 100) / 10000;
  const storageEnergyCapexWan =
    hardware.storageKwh * 1000 * getStorageUnitPrice(hardware.storageKwh, params.storBasePrice) *
    (1 + params.storRate / 100) / 10000;
  const storagePowerCapexWan = hardware.pcsKw * 450 * (1 + params.storRate / 100) / 10000;
  const chargerCapexWan = hardware.n7kw * params.cost7kw + hardware.n30kw * params.cost30kw;
  const emsCapexWan = params.ems;
  return {
    capexWan: round(pvCapexWan + storageEnergyCapexWan + storagePowerCapexWan + chargerCapexWan + emsCapexWan, 2),
    pvCapexWan: round(pvCapexWan, 2),
    storageEnergyCapexWan: round(storageEnergyCapexWan, 2),
    storagePowerCapexWan: round(storagePowerCapexWan, 2),
    chargerCapexWan: round(chargerCapexWan, 2),
    emsCapexWan: round(emsCapexWan, 2)
  };
}

function buildEvents(params, days, seed) {
  const random = seededRandom(seed);
  const events = [];
  const fixedCount = Math.round(params.evCount * params.teacherRatio);
  const visitorBaseCount = Math.max(0, params.evCount - fixedCount);
  const fixedFleet = Array.from({ length: fixedCount }, (_, index) => {
    const capacity = clamp(normal(random, params.batteryCapMean, 10), 45, 110);
    const consumption = clamp(normal(random, 15, 3), 9, 24);
    const meanDailyKm = clamp(normal(random, 32, 12), 8, 75);
    const chargeThreshold = clamp(normal(random, 0.25, 0.08), 0.1, 0.45);
    const targetSocBase = clamp(normal(random, params.targetSocMean, 0.05), 0.72, 1);
    return {
      id: index,
      capacity,
      consumption,
      meanDailyKm,
      dailyEnergy: meanDailyKm * consumption / 100,
      chargeThreshold,
      targetSocBase,
      soc: clamp(normal(random, params.initSocMean, 0.12), 0.08, 0.95)
    };
  });

  const pushEvent = (event) => {
    if (event.energyNeed <= 0) return;
    events.push(event);
  };

  for (let day = 0; day < days; day++) {
    const isWeekend = day % 7 === 5 || day % 7 === 6;
    const dayFactor = isWeekend ? params.holidayRatio : 1;
    const dayStart = day * 24;

    fixedFleet.forEach((car) => {
      if (random() > dayFactor) return;
      car.soc = clamp(car.soc - car.dailyEnergy / car.capacity, 0.03, 1);
      if (car.soc > car.chargeThreshold) return;
      const targetSoc = clamp(normal(random, car.targetSocBase, 0.035), 0.75, 1);
      const energyNeed = Math.max(car.dailyEnergy, car.capacity * Math.max(0, targetSoc - car.soc));
      const arrive = clamp(normal(random, 8.4, 0.55), 7, 10);
      const dwell = clamp(normal(random, 8.5, 0.75), 6, 10);
      const anxious = random() < params.anxietyRatio;
      const mustFast = energyNeed / 7 > Math.max(0.5, dwell);
      const tag = mustFast || (anxious && random() < 0.35) ? "FAST" : "SLOW";
      pushEvent({
        id: `F${car.id}-D${day}`,
        tag,
        group: "fixed",
        arriveHour: dayStart + arrive,
        leaveHour: dayStart + arrive + dwell,
        energyNeed,
        powerKw: tag === "FAST" ? 30 : 7
      });
      car.soc = targetSoc;
    });

    const visitorCount = Math.round(visitorBaseCount * dayFactor);
    for (let index = 0; index < visitorCount; index++) {
      const capacity = clamp(normal(random, params.batteryCapMean, 12), 45, 110);
      const initSoc = clamp(normal(random, params.initSocMean, 0.16), 0.08, 0.9);
      const targetSoc = clamp(normal(random, Math.min(params.targetSocMean, 0.82), 0.08), 0.55, 0.95);
      const wantsCharge = initSoc < 0.45 || random() < 0.35;
      const energyNeed = wantsCharge ? Math.max(0, capacity * (targetSoc - initSoc)) : 0;
      const arrive = clamp(normal(random, random() < 0.55 ? 10.8 : 14.5, 1.15), 8.5, 17);
      const dwell = clamp(normal(random, 2.4, 0.9), 0.75, 5);
      const mustFast = dwell < energyNeed / 7;
      const tag = mustFast || random() < 0.55 ? "FAST" : "SLOW";
      pushEvent({
        id: `V${index}-D${day}`,
        tag,
        group: "visitor",
        arriveHour: dayStart + arrive,
        leaveHour: dayStart + arrive + dwell,
        energyNeed,
        powerKw: tag === "FAST" ? 30 : 7
      });
    }
  }

  return events;
}

function estimatePilePlan(events, totalTicks, params) {
  const fastOcc = Array(totalTicks).fill(0);
  const slowOcc = Array(totalTicks).fill(0);
  events.forEach((event) => {
    const start = clamp(Math.floor(event.arriveHour * 4), 0, totalTicks - 1);
    const leave = clamp(Math.ceil(event.leaveHour * 4), start + 1, totalTicks);
    const chargeTicks = Math.ceil(event.energyNeed / (event.powerKw * TICK_HOURS));
    const end = Math.min(leave, start + chargeTicks, totalTicks);
    for (let tick = start; tick < end; tick++) {
      if (event.tag === "FAST") fastOcc[tick] += 1;
      else slowOcc[tick] += 1;
    }
  });
  const maxPiles = params.evCount > 0 ? Math.max(1, Math.ceil(params.evCount / params.evRatio)) : 0;
  const n30kw = Math.min(maxPiles, Math.ceil(percentile(fastOcc, params.slaFast)));
  const n7kw = Math.max(0, Math.min(maxPiles - n30kw, Math.ceil(percentile(slowOcc, params.slaSlow))));
  return { n7kw, n30kw, rawFastOcc: fastOcc, rawSlowOcc: slowOcc };
}

function simulatePileService(events, totalTicks, pilePlan) {
  const loadCurve = Array(totalTicks).fill(0);
  const fastOccupancy = Array(totalTicks).fill(0);
  const slowOccupancy = Array(totalTicks).fill(0);
  const queueFast = [];
  const queueSlow = [];
  const activeFast = [];
  const activeSlow = [];
  const arrivals = new Map();
  let deliveredEnergy = 0;
  let unmetByPile = 0;
  let queueUnmet = 0;
  let abandonedCount = 0;

  events.forEach((event) => {
    const startTick = clamp(Math.floor(event.arriveHour * 4), 0, totalTicks - 1);
    const leaveTick = clamp(Math.ceil(event.leaveHour * 4), startTick + 1, totalTicks);
    const item = { ...event, startTick, leaveTick, remaining: event.energyNeed };
    if (!arrivals.has(startTick)) arrivals.set(startTick, []);
    arrivals.get(startTick).push(item);
  });

  const expireQueue = (queue, tick) => {
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].leaveTick <= tick) {
        queueUnmet += queue[index].remaining;
        unmetByPile += queue[index].remaining;
        abandonedCount++;
        queue.splice(index, 1);
      }
    }
  };

  const fillSlots = (queue, active, capacity, tick) => {
    while (active.length < capacity && queue.length) {
      const event = queue.shift();
      if (event.leaveTick <= tick) {
        queueUnmet += event.remaining;
        unmetByPile += event.remaining;
        abandonedCount++;
      } else {
        active.push(event);
      }
    }
  };

  const charge = (active, tick, occCurve) => {
    for (let index = active.length - 1; index >= 0; index--) {
      const event = active[index];
      if (event.leaveTick <= tick || event.remaining <= 1e-6) {
        if (event.remaining > 1e-6) unmetByPile += event.remaining;
        active.splice(index, 1);
      }
    }
    active.forEach((event) => {
      const delivered = Math.min(event.remaining, event.powerKw * TICK_HOURS);
      event.remaining -= delivered;
      deliveredEnergy += delivered;
      loadCurve[tick] += delivered / TICK_HOURS;
      occCurve[tick] += 1;
    });
  };

  for (let tick = 0; tick < totalTicks; tick++) {
    (arrivals.get(tick) || []).forEach((event) => {
      if (event.tag === "FAST") queueFast.push(event);
      else queueSlow.push(event);
    });
    expireQueue(queueFast, tick);
    expireQueue(queueSlow, tick);
    fillSlots(queueFast, activeFast, pilePlan.n30kw || 0, tick);
    fillSlots(queueSlow, activeSlow, pilePlan.n7kw || 0, tick);
    charge(activeFast, tick, fastOccupancy);
    charge(activeSlow, tick, slowOccupancy);
  }

  [...queueFast, ...queueSlow, ...activeFast, ...activeSlow].forEach((event) => {
    if (event.remaining > 1e-6) {
      unmetByPile += event.remaining;
      abandonedCount++;
    }
  });

  return { loadCurve, fastOccupancy, slowOccupancy, deliveredEnergy, unmetByPile, queueUnmet, abandonedCount };
}

function rawDemandCurve(events, totalTicks) {
  const loadCurve = Array(totalTicks).fill(0);
  events.forEach((event) => {
    const start = clamp(Math.floor(event.arriveHour * 4), 0, totalTicks - 1);
    const leave = clamp(Math.ceil(event.leaveHour * 4), start + 1, totalTicks);
    const chargeTicks = Math.ceil(event.energyNeed / (event.powerKw * TICK_HOURS));
    const end = Math.min(leave, start + chargeTicks, totalTicks);
    for (let tick = start; tick < end; tick++) loadCurve[tick] += event.powerKw;
  });
  return loadCurve;
}

export function buildDemandProfile(params, { days = 7, seed = 20260512, pilePlan = null } = {}) {
  const totalTicks = days * TICKS_PER_DAY;
  const events = buildEvents(params, days, seed);
  const estimatedPilePlan = pilePlan || estimatePilePlan(events, totalTicks, params);
  const service = simulatePileService(events, totalTicks, estimatedPilePlan);
  const rawLoadCurve = rawDemandCurve(events, totalTicks);
  const rawWeekKwh = events.reduce((sum, event) => sum + event.energyNeed, 0);
  return {
    horizonDays: days,
    events,
    pilePlan: {
      n7kw: estimatedPilePlan.n7kw || 0,
      n30kw: estimatedPilePlan.n30kw || 0
    },
    loadCurve: service.loadCurve,
    rawLoadCurve,
    fastOccupancy: service.fastOccupancy,
    slowOccupancy: service.slowOccupancy,
    rawFastOccupancy: estimatedPilePlan.rawFastOcc || [],
    rawSlowOccupancy: estimatedPilePlan.rawSlowOcc || [],
    totalEnergyKwh: service.deliveredEnergy,
    totalDailyKwh: days > 0 ? service.deliveredEnergy / days : 0,
    rawEnergyKwh: rawWeekKwh,
    peakLoadKw: Math.max(0, ...service.loadCurve),
    rawPeakLoadKw: Math.max(0, ...rawLoadCurve),
    unmetByPileKwh: service.unmetByPile,
    queueUnmetKwh: service.queueUnmet,
    abandonedCount: service.abandonedCount,
    averageSessionNeedKwh: events.length ? rawWeekKwh / events.length : 0
  };
}

export function selectPressureMonth(params) {
  const dailyHps = params.fittedWeather?.monthlyDailyHPS || params.weather?.monthlyHPS || [];
  const occupancy = params.weather?.monthlyOccupancy || [0.5, 0.05, 1, 1, 1, 0.5, 0.05, 0.05, 1, 1, 1, 0.5];
  if (params.monthMode === "manual") return params.monthIndex;
  const maxHps = Math.max(...dailyHps, 1);
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let index = 0; index < 12; index++) {
    const weakSolar = 1 - safeNumber(dailyHps[index], maxHps) / maxHps;
    const score = weakSolar * 0.65 + safeNumber(occupancy[index], 1) * 0.35;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function buildIrradianceSeries(
  params,
  ticks,
  {
    monthIndex = 0,
    useGTilt = false,
    annualMode = false
  } = {}
) {
  /**
   * M2 年度模式：
   * 使用原生 8760 小时 G_tilt，从全年第 0 小时开始展开。
   * 每个小时值复制为 4 个 15 分钟点，保证小时能量守恒。
   */
  if (annualMode && useGTilt && params.gTiltData?.length >= 8760) {
    return Array.from({ length: ticks }, (_, tick) => {
      const hourIndex = Math.min(
        params.gTiltData.length - 1,
        Math.floor(tick / 4)
      );

      const current = safeNumber(params.gTiltData[hourIndex], 0);

      // gTiltData 单位通常是 W/m²，这里转成 kW/m²
      return Math.max(0, current) / 1000;
    });
  }

  /**
   * 非年度模式：
   * 保留旧逻辑，用于 M1/M3 或其他典型月/压力月兼容场景。
   */
  if (useGTilt && params.gTiltData?.length >= 8760) {
    let startHour = 0;
    for (let month = 0; month < monthIndex; month++) {
      startHour += MONTH_DAYS[month] * 24;
    }

    return Array.from({ length: ticks }, (_, tick) => {
      const hourIndex = Math.min(
        params.gTiltData.length - 1,
        startHour + Math.floor(tick / 4)
      );

      const current = safeNumber(params.gTiltData[hourIndex], 0);

      // 典型月/压力月模式也改为分段常值，保证小时能量守恒
      return Math.max(0, current) / 1000;
    });
  }

  /**
   * 没有原生 G_tilt 时：
   * fallback 到月度典型 96 点曲线。
   */
  const monthShape =
    params.weather?.monthlyPvShape96?.[monthIndex] ||
    scaleShapeToDailyHps(
      buildBasePvShape96(),
      params.weather?.monthlyHPS?.[monthIndex] ||
        params.climate?.monthlyHPS?.[monthIndex] ||
        3.5
    );

  return Array.from(
    { length: ticks },
    (_, tick) => monthShape[tick % TICKS_PER_DAY] || 0
  );
}

export function simulateEnergyScenario({ hardware, loadCurve, irradiance, params, scenarioKey }) {
  const scenario = SCENARIO_DEFINITIONS[scenarioKey] || SCENARIO_DEFINITIONS.offgrid_rule;
  const touPrice = params.climate?.gridTouPrice || DEFAULT_TOU;
  let soc = hardware.storageKwh * 0.35;
  let pvToLoad = 0;
  let batteryToLoad = 0;
  let gridImport = 0;
  let gridCost = 0;
  let unserved = 0;
  let curtailed = 0;
  let internalDeficit = 0;
  let totalPv = 0;
  let totalDemand = 0;
  let delivered = 0;
  let deficitTicks = 0;
  let socMinPct = hardware.storageKwh > 0 ? 35 : 0;
  let peakLoadKw = 0;
  let peakGridKw = 0;
  let gridValleyKwh = 0;
  let gridFlatKwh = 0;
  let gridPeakKwh = 0;
  const pvSeries = [];
  const evSeries = [];
  const socSeries = [];
  const gridSeries = [];
  const gridCostSeries = [];
  const internalDeficitSeries = [];
  const unservedSeries = [];
  const curtailedSeries = [];

  for (let tick = 0; tick < loadCurve.length; tick++) {
    const hour = Math.floor((tick % TICKS_PER_DAY) / 4);
    const price = getTouPrice(hour, touPrice);
    const pvPower = hardware.pvKw * safeNumber(irradiance[tick], 0) * params.pvEfficiency * DIRECT_EFFICIENCY;
    const loadPower = safeNumber(loadCurve[tick], 0);
    const loadEnergy = loadPower * TICK_HOURS;
    const pvEnergy = pvPower * TICK_HOURS;
    totalPv += pvEnergy;
    totalDemand += loadEnergy;
    peakLoadKw = Math.max(peakLoadKw, loadPower);

    let availablePv = pvEnergy;
    let remainingLoad = loadEnergy;

    let gridImportThisTick = 0;
    let gridCostThisTick = 0;
    let internalDeficitThisTick = 0;

    const direct = Math.min(availablePv, remainingLoad);
    availablePv -= direct;
    remainingLoad -= direct;
    pvToLoad += direct;

    const reservePct = scenario.dispatchEnabled && !scenario.gridConnected
      ? (hour < 10 || hour >= 17 ? 0.18 : 0.08)
      : 0.05;
    const reserve = hardware.storageKwh * reservePct;
    const canDischarge = Math.max(0, soc - reserve);
    const dischargeLimit = hardware.pcsKw * TICK_HOURS;
    const dischargeAllowed =
      !scenario.gridConnected || !scenario.dispatchEnabled || price >= touPrice.flat;

    if (remainingLoad > 0 && dischargeAllowed) {
      const discharge = Math.min(remainingLoad, dischargeLimit, canDischarge);
      soc -= discharge;
      remainingLoad -= discharge;
      batteryToLoad += discharge;
    }

    internalDeficitThisTick = Math.max(0, remainingLoad);
    internalDeficit += internalDeficitThisTick;

    if (remainingLoad > 0 && scenario.gridConnected) {
      const gridCapacity = Math.max(0, params.transformerLimitKw) * TICK_HOURS;
      const buy = Math.min(remainingLoad, gridCapacity);

      remainingLoad -= buy;

      gridImport += buy;
      gridCost += buy * price;

      gridImportThisTick += buy;
      gridCostThisTick += buy * price;

      peakGridKw = Math.max(peakGridKw, buy / TICK_HOURS);

      if (price === touPrice.valley) gridValleyKwh += buy;
      else if (price === touPrice.peak) gridPeakKwh += buy;
      else gridFlatKwh += buy;
    }

    if (remainingLoad > 0) {
      unserved += remainingLoad;
      deficitTicks += 1;
    }

    if (scenario.dispatchEnabled && scenario.gridConnected && price === touPrice.valley && hardware.storageKwh > 0) {
      const targetSoc = hardware.storageKwh * 0.65;
      const gridCapacity = Math.max(0, params.transformerLimitKw) * TICK_HOURS;
      const chargeFromGrid = Math.min(
        Math.max(0, targetSoc - soc),
        hardware.pcsKw * TICK_HOURS,
        gridCapacity
      );
      soc += chargeFromGrid;

      gridImport += chargeFromGrid;
      gridCost += chargeFromGrid * price;

      gridImportThisTick += chargeFromGrid;
      gridCostThisTick += chargeFromGrid * price;

      gridValleyKwh += chargeFromGrid;
      peakGridKw = Math.max(peakGridKw, chargeFromGrid / TICK_HOURS);
    }

    if (availablePv > 0 && hardware.storageKwh > 0) {
      const charge = Math.min(availablePv, hardware.pcsKw * TICK_HOURS, hardware.storageKwh - soc);
      soc += charge;
      availablePv -= charge;
    }
    curtailed += Math.max(0, availablePv);

    const socPct = hardware.storageKwh > 0 ? soc / hardware.storageKwh * 100 : 0;
    socMinPct = Math.min(socMinPct, socPct);
    pvSeries.push(pvPower);
    evSeries.push(loadPower);
    socSeries.push(socPct);

    gridSeries.push(gridImportThisTick / TICK_HOURS);

    gridCostSeries.push(gridCostThisTick);

    internalDeficitSeries.push(internalDeficitThisTick / TICK_HOURS);

    unservedSeries.push(Math.max(0, remainingLoad) / TICK_HOURS);
    curtailedSeries.push(Math.max(0, availablePv) / TICK_HOURS);
  }

  delivered = Math.max(0, totalDemand - unserved);
  const capex = calcCapexWan(hardware, params);
  const annualizedCapexWan = capex.capexWan * 0.085;
  const gridCostWan = gridCost / 10000;
  const unmetPenaltyWan = unserved * (scenario.gridConnected ? 2 : 5) / 10000;
  const totalCostWan = annualizedCapexWan + gridCostWan + unmetPenaltyWan;

  return {
    scenario,
    summary: {
      scenarioKey,
      scenarioLabel: scenario.label,
      gridConnected: scenario.gridConnected,
      dispatchEnabled: scenario.dispatchEnabled,
      demandKwh: round(totalDemand, 1),
      deliveredKwh: round(delivered, 1),
      serviceRate: totalDemand > 0 ? round(delivered / totalDemand, 5) : 1,
      internalDeficitKwh: round(internalDeficit, 1),
      unservedEnergyKwh: round(unserved, 1),
      deficitHours: round(deficitTicks * TICK_HOURS, 1),
      gridImportKwh: round(gridImport, 1),
      gridValleyKwh: round(gridValleyKwh, 1),
      gridFlatKwh: round(gridFlatKwh, 1),
      gridPeakKwh: round(gridPeakKwh, 1),
      gridCostYuan: round(gridCost, 1),
      gridDependencyRate: totalDemand > 0 ? round(gridImport / totalDemand, 5) : 0,
      peakLoadKw: round(peakLoadKw, 1),
      peakGridKw: round(peakGridKw, 1),
      socMinPct: round(socMinPct, 1),
      pvGenerationKwh: round(totalPv, 1),
      pvToLoadKwh: round(pvToLoad, 1),
      batteryToLoadKwh: round(batteryToLoad, 1),
      curtailmentKwh: round(curtailed, 1),
      curtailmentRatePct: totalPv > 0 ? round(curtailed / totalPv * 100, 2) : 0,
      pvSelfUseRate: totalPv > 0 ? round((pvToLoad + batteryToLoad) / totalPv, 5) : 0,
      annualizedCapexWan: round(annualizedCapexWan, 2),
      totalCostWan: round(totalCostWan, 2)
    },
    chartData: {
      pv: pvSeries,
      ev: evSeries,
      soc: socSeries,
      grid: gridSeries,
      gridCost: gridCostSeries,
      internalDeficit: internalDeficitSeries,
      unserved: unservedSeries,
      curtailed: curtailedSeries
    }
  };
}

export function runScenarioSet({
  hardware,
  demand,
  params,
  monthIndex = 0,
  useGTilt = false,
  annualMode = false
}) {
  const irradiance = buildIrradianceSeries(params, demand.loadCurve.length, {
    monthIndex,
    useGTilt,
    annualMode
  });

  return Object.fromEntries(
    SCENARIO_KEYS.map((key) => [
      key,
      simulateEnergyScenario({
        hardware,
        loadCurve: demand.loadCurve,
        irradiance,
        params,
        scenarioKey: key
      })
    ])
  );
}

export function buildHardwarePlan({ pvKw, storageKwh, pcsKw, n7kw, n30kw, transformerLimitKw }) {
  return {
    pvKw: round(Math.max(0, pvKw), 1),
    storageKwh: round(Math.max(0, storageKwh), 1),
    pcsKw: round(Math.max(0, pcsKw), 1),
    n7kw: Math.max(0, Math.round(n7kw || 0)),
    n30kw: Math.max(0, Math.round(n30kw || 0)),
    transformerLimitKw: round(Math.max(0, transformerLimitKw || 0), 1)
  };
}

export { MONTH_DAYS, MONTH_NAMES, SCENARIO_KEYS, SCENARIO_DEFINITIONS };
