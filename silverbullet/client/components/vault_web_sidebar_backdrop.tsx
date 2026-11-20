/**
 * On a phone, the left sidebar overlays the editor rather than sharing width
 * with it (`main.scss`'s `.sb-nav-root-lhs`). This sits behind it, over the
 * editor strip the drawer leaves exposed, so tapping outside the sidebar
 * closes it the same way the hamburger button does. It carries no visible
 * content of its own, and the sidebar already has a "collapse" button for
 * keyboard and assistive-tech users, so it stays out of the accessibility
 * tree rather than exposing an unreachable control.
 */
export function SidebarBackdrop({ onClose }: { onClose: () => void }) {
  return (
    <div className="vw-sidebar-backdrop" aria-hidden="true" onClick={onClose} />
  );
}
