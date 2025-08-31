import React from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean; error?: any };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, info: any) {
    // Log to console; helps in Electron devtools
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="container">
          <div className="card grid" style={{ color: 'var(--text)' }}>
            <h2 style={{ margin: 0 }}>Something went wrong</h2>
            <div className="sub">
              Check the console for details. You can continue by navigating back or reloading.
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
