import { Bell, CaretDown, CaretRight, CircleNotch, Gear, Info, PaperPlaneRight, Terminal, Tray, Warning } from '@phosphor-icons/react';

/** Phosphor, per the visual design doc §5. Its weight range carries state by
 *  weight and fill rather than hue alone, which matters because colour is
 *  already carrying per-agent identity.
 *
 *  `chevron-down` is Phosphor's CaretDown -- the split Launch button's
 *  second half (session-names design). Named for what it means here rather
 *  than for Phosphor's own component, the same way `spinner` is. */
const ICONS = {
  bell: Bell, 'chevron-down': CaretDown, gear: Gear, spinner: CircleNotch,
  terminal: Terminal, warning: Warning,
  // Fleet Mail's card badges: letters sent, and a reviewer's inbox.
  'paper-plane': PaperPlaneRight, tray: Tray,
  // Settings' Help row and the Help modal's header.
  info: Info, 'caret-right': CaretRight,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14, weight = 'regular' }:
  { name: IconName; size?: number; weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' }) {
  const C = ICONS[name];
  return <C size={size} weight={weight} aria-hidden="true" />;
}
