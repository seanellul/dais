import { Button as ButtonPrimitive } from "@base-ui/react/button";

import { cn } from "@/ui/cn";

export interface ActionButtonProps extends Omit<ButtonPrimitive.Props, "className"> {
  /** md = 44px (organiser), lg = 56px (judge and the landing page). */
  size?: "md" | "lg";
  className?: string;
}

/**
 * The one accent button per screen. It uses the --action colour (coral in the
 * ESU Cayman theme, primary elsewhere). Every other button on the page should
 * be a plain shadcn Button.
 *
 * It renders the same Base UI primitive as shadcn's Button, but its styles are
 * the `.action-button` component class in globals.css rather than Button's
 * utility variants. That keeps the accent colour out of the class-merge step,
 * where a custom `text-*` size once silently deleted it.
 */
export function ActionButton({ size = "md", className, ...props }: ActionButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-size={size}
      className={cn("action-button", className)}
      {...props}
    />
  );
}
