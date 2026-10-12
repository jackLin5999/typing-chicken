import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches render errors anywhere in the child tree and displays a fallback UI
 * instead of crashing to a blank white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
          <div className="text-4xl">⚠️</div>
          <h2 className="text-xl font-semibold text-ink">
            出了点问题
          </h2>
          <p className="text-sm text-muted max-w-md">
            {this.state.error?.message || "未知错误"}
          </p>
          <button
            onClick={this.handleReset}
            className="px-4 py-2 rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
