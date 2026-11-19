/**
 * A host icon with a small status dot in its corner, as an SVG image. VS Code can neither badge a
 * built-in icon nor animate one, so the icon is drawn here: the host's own icon and color, a notch cut
 * out of its lower right corner, and the dot in it. Free of the vscode API.
 */
import type { HealthStatus } from './health';
import { ICON_SHAPES } from './iconShapes';

export type Theme = 'dark' | 'light';
/** a host is up, down or unknown; a folder can also be mixed: some hosts up, some down */
export type DotStatus = HealthStatus | 'mixed';

/** The dot of a folder from its hosts: all up, all down, or mixed. Hosts that are not checked do not count. */
export function folderStatus(statuses: (HealthStatus | undefined)[]): DotStatus | undefined {
  const up = statuses.includes('up');
  const down = statuses.includes('down');
  return up && down ? 'mixed' : up ? 'up' : down ? 'down' : undefined;
}

/** VS Code's default icon and chart colors, which an image file cannot ask the theme for. */
const ICON_COLORS: Record<Theme, Record<string, string>> = {
  dark: { '': '#c5c5c5', red: '#f14c4c', orange: '#d18616', yellow: '#cca700', green: '#89d185', blue: '#3794ff', purple: '#b180d7' },
  light: { '': '#424242', red: '#e51400', orange: '#d18616', yellow: '#bf8803', green: '#388a34', blue: '#1a85ff', purple: '#652d90' },
};

const DOT_COLORS: Record<Theme, Record<DotStatus, string>> = {
  dark: { up: '#3fb950', down: '#f85149', mixed: '#e3b341', unknown: '#8b949e' },
  light: { up: '#1a7f37', down: '#cf222e', mixed: '#bf8700', unknown: '#8c959f' },
};

const known = (icon: string) => (ICON_SHAPES[icon] ? icon : 'server');

/** Name of one variant; everything that changes the picture is in it. */
export function statusIconName(icon: string, color: string | undefined, status: DotStatus | undefined, animate: boolean, theme: Theme): string {
  const c = color && ICON_COLORS.dark[color] ? color : 'plain';
  return `${known(icon)}-${c}-${status ?? 'none'}${animate && status ? '-a' : ''}-${theme}.svg`;
}

/** True when the icon can be drawn here (the others stay built-in icons, without a dot). */
export const canDraw = (icon: string) => !!ICON_SHAPES[icon];

/** Without a status the icon is drawn alone, in its color: for lists where VS Code does not color icons. */
export function statusIconSvg(icon: string, color: string | undefined, status: DotStatus | undefined, animate: boolean, theme: Theme): string {
  const fill = ICON_COLORS[theme][color && ICON_COLORS[theme][color] ? color : ''];
  const shape = ICON_SHAPES[known(icon)];
  const body = shape.box === 16 ? shape.body : `<g transform="scale(${16 / shape.box})">${shape.body}</g>`;
  if (!status) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="${fill}">${body}</g></svg>`;
  }
  const dot = DOT_COLORS[theme][status];
  const X = 12.25, Y = 12.25, R = 2.5;
  // up (and mixed, in yellow): a soft ring that spreads and fades, like a heartbeat. down: a slow blink. People who asked
  // their system for less motion get a still dot.
  const css =
    !animate || status === 'unknown'
      ? ''
      : status !== 'down'
        ? `<style>@keyframes r{0%{transform:scale(1);opacity:.75}75%,100%{transform:scale(1.5);opacity:0}}.r{transform-box:fill-box;transform-origin:center;animation:r 2.4s ease-out infinite}@media (prefers-reduced-motion:reduce){.r{animation:none;opacity:0}}</style>`
        : `<style>@keyframes b{0%,55%{opacity:1}100%{opacity:.25}}.d{animation:b 1.1s ease-in-out infinite alternate}@media (prefers-reduced-motion:reduce){.d{animation:none}}</style>`;
  const ring = animate && (status === 'up' || status === 'mixed') ? `<circle class="r" cx="${X}" cy="${Y}" r="${R}" fill="${dot}"/>` : '';
  const mark =
    status === 'unknown'
      ? `<circle cx="${X}" cy="${Y}" r="${R - 0.6}" fill="none" stroke="${dot}" stroke-width="1.2"/>`
      : `<circle class="d" cx="${X}" cy="${Y}" r="${R}" fill="${dot}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${css}` +
    `<mask id="m"><rect width="16" height="16" fill="#fff"/><circle cx="${X}" cy="${Y}" r="${R + 1.5}" fill="#000"/></mask>` +
    `<g mask="url(#m)" fill="${fill}">${body}</g>${ring}${mark}</svg>`
  );
}
