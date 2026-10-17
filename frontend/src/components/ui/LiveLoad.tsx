export function LiveLoad({ label = "Loading" }: { label?: string }) {
  return (
    <div className="live-load" role="status" aria-live="polite">
      <div className="live-load-glow live-load-glow-a" aria-hidden="true" />
      <div className="live-load-glow live-load-glow-b" aria-hidden="true" />
      <div className="live-load-grid" aria-hidden="true" />
      <div className="live-load-panel">
        <div className="live-load-stage" aria-hidden="true">
          <div className="live-load-disc">
            <span className="live-load-ring live-load-ring-outer" />
            <span className="live-load-ring live-load-ring-mid" />
            <span className="live-load-ring live-load-ring-inner" />
            <span className="live-load-sweep" />
            <span className="live-load-orbit live-load-orbit-a">
              <i />
            </span>
            <span className="live-load-orbit live-load-orbit-b">
              <i />
            </span>
            <span className="live-load-orbit live-load-orbit-c">
              <i />
            </span>
            <span className="live-load-core" />
          </div>
        </div>
        <div className="live-load-shadow" aria-hidden="true" />
        <p className="live-load-label">
          {label}
          <span className="live-load-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </p>
        <div className="live-load-trace" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
}
