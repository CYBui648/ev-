import { dom } from "./dom.js";

function parseCsvLine(line) {
  const cols = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cols.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cols.push(current.trim());
  return cols;
}

function parseInputValue(input) {
  if (input.tagName === "SELECT") return input.value;
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? parsed : input.value;
}

export function hydrateM1Inputs(state) {
  dom.m1Inputs.forEach((input) => {
    const key = input.dataset.m1Input;
    const value = state.input.m1[key];
    if (value !== undefined && value !== null) {
      input.value = value;
    }
  });
  if (dom.weatherCsvStatus) {
    dom.weatherCsvStatus.textContent = state.input.weather?.gTiltStatus || "尚未加载 TMY CSV。";
  }
}

export function bindM1Inputs(state, onChange) {
  dom.m1Inputs.forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.m1Input;
      state.input.m1[key] = parseInputValue(input);
      onChange(state);
    });
    input.addEventListener("change", () => {
      const key = input.dataset.m1Input;
      state.input.m1[key] = parseInputValue(input);
      onChange(state);
    });
  });

  dom.weatherCsvFile?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    state.input.weather ||= {};
    state.input.weather.gTiltStatus = "正在解析气象数据...";
    dom.weatherCsvStatus.textContent = state.input.weather.gTiltStatus;
    onChange(state);

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const text = String(loadEvent.target?.result || "");
      const lines = text.split(/\r?\n/);
      const data = [];
      let headerFound = false;
      let gTiltIndex = -1;

      for (const line of lines) {
        if (!line.trim()) continue;
        const cols = parseCsvLine(line);
        if (!headerFound) {
          gTiltIndex = cols.findIndex((col) =>
            col.replace(/^﻿/, "").trim().toLowerCase().includes("g_tilt")
          );
          if (gTiltIndex !== -1) headerFound = true;
          continue;
        }

        if (cols.length > gTiltIndex) {
          const value = Number.parseFloat(cols[gTiltIndex]);
          data.push(Number.isFinite(value) ? value : 0);
        }
      }

      if (data.length >= 8760) {
        state.input.weather.gTiltData = data.slice(0, 8760);
        state.input.weather.gTiltStatus = `已接管 TMY 数据（${data.length} 行，使用前 8760 行）`;
      } else {
        state.input.weather.gTiltData = null;
        state.input.weather.gTiltStatus = "数据不足 8760 行，无法拟合典型气象。";
      }
      dom.weatherCsvStatus.textContent = state.input.weather.gTiltStatus;
      onChange(state);
    };
    reader.readAsText(file);
  });
}
