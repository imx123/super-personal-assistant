/**
 * The console's icons.
 *
 * They are the prototype's own drawings, kept as plain SVG paths so the console loads no icon font and asks no other
 * origin for anything.
 */
import type { ReactElement } from 'react'

/** One icon, drawn in a 24×24 box with the current colour. */
const ICONS: Record<string, () => ReactElement> = {
  router: () => <><path d="M3 7h7l4 5h7M3 17h7l4-5M5 7v10" /><circle cx="20" cy="12" r="1.5" /></>,
  home: () => <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M10 9v11" /></>,
  project: () => <path d="M4 7h6l2 2h8v10H4z" />,
  chat: () => <><path d="M5 5h14v11h-8l-4 3v-3H5z" /><path d="M9 9h6m-6 3h4" /></>,
  clock: () => <><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" /></>,
  node: () => <><rect x="4" y="5" width="16" height="6" rx="2" /><rect x="4" y="13" width="16" height="6" rx="2" /><path d="M8 8h1m-1 8h1" /></>,
  settings: () => <><path d="M5 7h14M5 12h14M5 17h14" /><circle cx="9" cy="7" r="1.5" fill="white" /><circle cx="15" cy="12" r="1.5" fill="white" /><circle cx="11" cy="17" r="1.5" fill="white" /></>,
  arrowUp: () => <path d="M12 19V6m-6 6 6-6 6 6" />,
  plus: () => <path d="M12 5v14M5 12h14" />,
  file: () => <><path d="M6 3h8l4 4v14H6zM14 3v5h4" /><path d="M9 12h6m-6 4h6" /></>,
  assign: () => <path d="M4 7h5l3 5h7m-4-4 4 4-4 4M4 17h5l3-5" />,
  ok: () => <path d="m5 12 4 4L19 7" />,
  fail: () => <path d="M8 8l8 8m0-8-8 8" />,
  menu: () => <path d="M4 7h16M4 12h16M4 17h16" />,
  sidebarClose: () => <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M9 5v14m7-10-3 3 3 3" /></>,
  sidebarOpen: () => <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M9 5v14m5-10 3 3-3 3" /></>,
}

/** One icon of the console. */
export function Icon(props: { name: string }): ReactElement {
  const drawing = ICONS[props.name]
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round">
      {drawing ? drawing() : null}
    </svg>
  )
}
