import '@testing-library/jest-dom/vitest';

export const feeds: TestEventSource[] = []

class TestEventSource extends EventTarget {
  constructor(readonly url: string | URL, readonly options?: EventSourceInit) {
    super()
    feeds.push(this)
  }

  close() {}
}

Object.defineProperty(globalThis, "EventSource", { configurable: true, value: TestEventSource, writable: true })
