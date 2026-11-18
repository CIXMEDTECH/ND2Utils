import { Component, type ReactNode } from "react";

/** Last line of defence: show what happened instead of an empty page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Lucida crashed", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex min-h-[100dvh] items-center justify-center bg-[var(--bg)] px-5 text-[var(--text)]">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold tracking-[-0.02em]">页面加载失败 · Page failed to load</h1>
          <p className="mt-3 text-base leading-6 text-[var(--text-dim)]">
            可能是网站刚刚更新，请刷新页面；若仍无法打开，请清除本站缓存后重试。
            <br />
            The site may have just been updated. Reload the page, or clear this site's cached data if it keeps happening.
          </p>
          <p className="mt-3 break-words font-mono text-xs text-[var(--text-dim)]">{this.state.error.message}</p>
          <button type="button" onClick={() => window.location.reload()} className="primary-action mt-6">
            刷新 · Reload
          </button>
        </div>
      </div>
    );
  }
}
