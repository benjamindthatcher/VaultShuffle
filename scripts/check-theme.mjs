import { readdir, readFile } from 'node:fs/promises';
import { VAULT_THEME } from '../lib/theme.ts';

// Experiments are deliberately scoped and unavailable in production. Filled
// semantic action gradients have their own user-approved control standard.
// The user explicitly restored the pre-rollout landing page. Its two CSS
// modules are a scoped, documented exception; shared/app styles stay checked.
const exceptions = new Set([
  'app/theme.css', 'app/controls.css',
  'components/site/landing-experience.module.css',
  'components/site/landing-vault-draw.module.css',
]);
const experiment = /^app\/(theme-workshop|button-lab)\//;
const errors = [];
const palette = await readFile(new URL('../app/theme.css', import.meta.url), 'utf8');
const roles = { ground: 'ink', chrome: 'chrome', surface: 'surface', feature: 'feature-surface', well: 'well-surface', border: 'border', accent: 'accent', blue: 'accent-blue', text: 'text', muted: 'text-muted' };
for (const [role, token] of Object.entries(roles)) {
  if (!palette.includes(`--vault-${token}: ${VAULT_THEME[role]};`)) errors.push(`app/theme.css: ${role} differs from lib/theme.ts`);
}
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '');
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (!experiment.test(`${path}/`)) await walk(path); continue; }
    if (!/\.(css|tsx)$/.test(path) || exceptions.has(path)) continue;
    const source = strip(await readFile(path, 'utf8'));
    // CSS: reject literal colours while allowing rgba(var(--role), opacity).
    // JSX: only examine literal paint properties, so fragment IDs remain valid.
    const literal = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[\d.]/gi;
    const paints = path.endsWith('.css') ? source : (source.match(/(?:color|background(?:Color)?|borderColor|fill|stroke|stopColor)\s*[:=]\s*(?:\{\s*)?["'`][^"'`]*["'`]/g) || []).join('\n');
    if (literal.test(paints)) errors.push(`${path}: use app/theme.css roles instead of literal colours`);
    if (path.endsWith('.css') && /(?:color|background|fill|stroke)\s*:\s*(?:white|black|purple|navy|blue|red|green)\b/i.test(paints)) errors.push(`${path}: use named theme roles instead of CSS colour names`);
    for (const token of Object.values(roles)) {
      if (new RegExp(`--vault-${token}\\s*:`).test(source)) errors.push(`${path}: foundation token --vault-${token} may only be defined in app/theme.css`);
    }
  }
}
await walk('app');
await walk('components');
function luminance(hex) {
  const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
for (const foreground of ['text', 'muted', 'accent', 'blue']) {
  for (const background of ['ground', 'chrome', 'surface', 'feature', 'well']) {
    const ratio = (luminance(VAULT_THEME[foreground]) + .05) / (luminance(VAULT_THEME[background]) + .05);
    if (ratio < 4.5) errors.push(`${foreground} on ${background}: contrast ${ratio.toFixed(2)} is below 4.5:1`);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('VaultShuffle Purple: palette parity, shared UI colours and foundation text contrast passed.');
