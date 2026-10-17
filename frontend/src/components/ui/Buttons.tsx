import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

const buttonBase =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition duration-brand ease-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60";

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
    return renderButton(
      cn(buttonBase, "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover"),
      props,
      ref,
    );
  },
);

export const SecondaryButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function SecondaryButton(props, ref) {
    return renderButton(
      cn(
        buttonBase,
        "border border-border bg-surface text-foreground shadow-sm hover:bg-surface-muted",
      ),
      props,
      ref,
    );
  },
);
