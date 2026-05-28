import { dom } from "./dom.js";

function parseInputValue(input) {
  if (input.tagName === "SELECT") {
    if (input.dataset.m2Input === "monthIndex") return Number(input.value);
    return input.value;
  }
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? parsed : input.value;
}

export function hydrateM2Inputs(state) {
  dom.m2Inputs.forEach((input) => {
    const key = input.dataset.m2Input;
    const value = state.input.m2[key];
    if (value !== undefined && value !== null) input.value = value;
  });
}

export function bindM2Inputs(state, onChange) {
  dom.m2Inputs.forEach((input) => {
    const sync = () => {
      const key = input.dataset.m2Input;
      state.input.m2[key] = parseInputValue(input);
      onChange(state);
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  });

}
