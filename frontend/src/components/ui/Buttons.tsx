import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

const buttonBase =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 aria-[busy=true]:pointer-events-none sm:min-h-10";

export const buttonVariants = {
  primary:
    "bg-primary text-primary-foreground shadow-sm ring-1 ring-inset ring-primary-foreground/15 hover:bg-primary-hover",
  secondary:
    "border border-border bg-surface text-foreground shadow-xs hover:bg-surface-muted active:bg-muted",
  outline:
    "border border-input bg-transparent text-foreground hover:bg-surface-muted active:bg-muted",
  ghost:
    "text-muted-foreground hover:bg-surface-muted hover:text-foreground active:bg-muted",
  destructive:
    "bg-destructive text-destructive-foreground shadow-sm ring-1 ring-inset ring-destructive-foreground/15 hover:bg-destructive/90",
  link: "min-h-0 rounded-md px-0 text-primary underline-offset-4 shadow-none hover:underline active:scale-100",
} as const;

export type ButtonVariant = keyof typeof buttonVariants;

type SharedProps = {
  children: ReactNode;
  className?: string;
  to?: string;
};

type ButtonProps = SharedProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

function renderButton(
  classes: string,
  { to, className, children, type = "button", ...props }: ButtonProps,
  ref: Ref<HTMLButtonElement | HTMLAnchorElement>,
) {
  const classNames = cn(classes, className);
  if (to) {
    return (
      <Link ref={ref as Ref<HTMLAnchorElement>} to={to} className={classNames}>
        {children}
      </Link>
    );
  }

  return (
    <button ref={ref as Ref<HTMLButtonElement>} type={type} className={classNames} {...props}>
      {children}
    </button>
  );
}

export const PrimaryButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function PrimaryButton(props, ref) {
    return renderButton(cn(buttonBase, buttonVariants.primary), props, ref);
  },
);

export const SecondaryButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function SecondaryButton(props, ref) {
    return renderButton(cn(buttonBase, buttonVariants.secondary), props, ref);
  },
);

export const OutlineButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function OutlineButton(props, ref) {
    return renderButton(cn(buttonBase, buttonVariants.outline), props, ref);
  },
);

export const GhostButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function GhostButton(props, ref) {
    return renderButton(cn(buttonBase, buttonVariants.ghost), props, ref);
  },
);

export const DestructiveButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function DestructiveButton(props, ref) {
    return renderButton(cn(buttonBase, buttonVariants.destructive), props, ref);
  },
);

export const LinkButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function LinkButton(props, ref) {
    return renderButton(cn(buttonBase, buttonVariants.link), props, ref);
  },
);
