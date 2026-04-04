// Learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom'

// Polyfill Web APIs for Next.js
import { TextEncoder, TextDecoder } from 'util'
global.TextEncoder = TextEncoder
global.TextDecoder = TextDecoder

// Mock Request and Response for Next.js API Routes
class MockRequest {
  constructor(input, init = {}) {
    this.url = typeof input === 'string' ? input : input.url
    this.method = init.method || 'GET'
    this.headers = init.headers || {}
    this.body = init.body
    this._json = null
  }

  async json() {
    if (this._json) return this._json
    if (typeof this.body === 'string') {
      return JSON.parse(this.body)
    }
    return this.body || {}
  }
}

class MockResponse {
  constructor(body, init = {}) {
    this.body = body
    this.status = init.status || 200
    this.statusText = init.statusText || 'OK'
    this.headers = init.headers || {}
    this.ok = this.status >= 200 && this.status < 300
  }

  async json() {
    return typeof this.body === 'string' ? JSON.parse(this.body) : this.body
  }

  async text() {
    return typeof this.body === 'string' ? this.body : JSON.stringify(this.body)
  }
}

global.Request = MockRequest
global.Response = MockResponse

// Mock NextResponse for Next.js API Routes
const MockNextResponse = {
  json: (body, init = {}) => {
    const response = new MockResponse(JSON.stringify(body), init)
    response.json = async () => body
    return response
  }
}

// Mock Next.js modules
jest.mock('next/server', () => ({
  NextResponse: MockNextResponse
}))

// Mock environment variables
process.env.NEXT_PUBLIC_LIFF_ID = '2008315861-L29vEYpa'
process.env.NEXT_PUBLIC_DEV_MODE = 'false'
process.env.LINE_CHANNEL_ID = '2008401529'
process.env.LINE_CHANNEL_SECRET = 'c44ee214559f2098a2a4364993304a0c'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fpdcnbpeoasipxjibmuz.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test_key'

// Mock fetch globally
global.fetch = jest.fn()

// Mock navigator.sendBeacon for analytics tests
if (!global.navigator) {
  global.navigator = {}
}
global.navigator.sendBeacon = jest.fn(() => true)
