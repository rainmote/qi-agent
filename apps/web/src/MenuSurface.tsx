// Adapted from DeepSeek Harness ui-primitives/MenuSurface.tsx (MIT).
// Web menus keep their material in a sibling paint layer below the content.
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { createPortal } from "react-dom";

export const MenuSurface = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function MenuSurface({ children, ...props }, ref) {
    const surface = <div {...props} ref={ref} data-menu-material="translucent">
      <div aria-hidden="true" className="composer-menu-material" />
      {children}
    </div>;
    return typeof document === "undefined" ? surface : createPortal(surface, document.body);
  },
);
