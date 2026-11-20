/**
 * The iPhones the installed app shows its opening screen on while it starts, in points, with how tall the status bar
 * is over it. iOS shows a picture only when it is exactly the screen's size, so each gets its own; without one it shows
 * white. Drawn by `pnpm startup-images` (e2e/startup-images.ts) into public/startup.
 */
export const STARTUP_SCREENS = [
  { width: 375, height: 667, scale: 2, top: 20 },
  { width: 375, height: 812, scale: 3, top: 50 },
  { width: 414, height: 896, scale: 2, top: 48 },
  { width: 414, height: 896, scale: 3, top: 44 },
  { width: 390, height: 844, scale: 3, top: 47 },
  { width: 428, height: 926, scale: 3, top: 47 },
  { width: 393, height: 852, scale: 3, top: 59 },
  { width: 430, height: 932, scale: 3, top: 59 },
  { width: 402, height: 874, scale: 3, top: 62 },
  { width: 420, height: 912, scale: 3, top: 62 },
  { width: 440, height: 956, scale: 3, top: 62 },
] as const;

type Screen = (typeof STARTUP_SCREENS)[number];

export const startupImage = (s: Screen) => `/startup/${s.width}x${s.height}@${s.scale}x.png`;

export const startupMedia = (s: Screen) =>
  `(device-width: ${s.width}px) and (device-height: ${s.height}px) and (-webkit-device-pixel-ratio: ${s.scale}) and (orientation: portrait)`;
