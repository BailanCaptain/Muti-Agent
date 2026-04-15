"use client"
import { Component, type ReactNode, type ErrorInfo } from "react"

interface Props { children: ReactNode; fallback?: ReactNode }
interface State { hasError: boolean; error?: Error }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex items-center justify-center h-screen">
          <div className="text-center p-8">
            <h2 className="text-lg font-semibold mb-2">页面出了点问题</h2>
            <p className="text-sm text-gray-500 mb-4">{this.state.error?.message}</p>
            <button type="button" onClick={() => this.setState({ hasError: false })}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
              重试
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
