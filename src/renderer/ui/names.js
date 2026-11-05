// Plain colour names for finished vessels, picked from the palette hue.
// Names describe the glass only; none of them rank the breathing.

const NAMES = [
  [20, 'Ember'], [36, 'Amber'], [52, 'Honey'], [70, 'Straw'], [95, 'Peridot'],
  [130, 'Olive glass'], [150, 'Jade'], [172, 'Sea glass'], [190, 'Lagoon'], [215, 'Deep teal'], [360, 'Ember'],
];

export function vesselName(palette) {
  const hue = Number(palette?.hue);
  if (!Number.isFinite(hue)) return 'Clear';
  const h = ((hue % 360) + 360) % 360;
  for (const [limit, name] of NAMES) if (h <= limit) return name;
  return 'Clear';
}

export function paceText(breathRate) {
  const r = Number(breathRate);
  if (!Number.isFinite(r) || r <= 0) return 'pace not measured';
  return `about ${Math.round(r)} breaths a minute`;
}
