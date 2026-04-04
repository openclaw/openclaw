import { POST } from '../route';

// Mock fetch
global.fetch = jest.fn();

describe('POST /api/line/verify-token', () => {
  let mockRequest;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRequest = {
      json: jest.fn(),
    };

    // Set environment variable
    process.env.LINE_CHANNEL_ID = '2008401529';
  });

  describe('輸入驗證', () => {
    test('應該拒絕缺少 accessToken 的請求', async () => {
      mockRequest.json.mockResolvedValue({});

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Access token is required');
    });

    test('應該拒絕空字串 accessToken', async () => {
      mockRequest.json.mockResolvedValue({ accessToken: '' });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Access token is required');
    });
  });

  describe('LINE API 驗證', () => {
    test('應該呼叫 LINE verify API', async () => {
      mockRequest.json.mockResolvedValue({
        accessToken: 'test_access_token_123',
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          client_id: '2008401529',
          expires_in: 2592000,
        }),
      });

      await POST(mockRequest);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.line.me/oauth2/v2.1/verify?access_token=test_access_token_123'
      );
    });

    test('應該接受有效的 access token', async () => {
      mockRequest.json.mockResolvedValue({
        accessToken: 'valid_token',
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          client_id: '2008401529',
          expires_in: 2592000,
        }),
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.channelId).toBe('2008401529');
      expect(data.expiresIn).toBe(2592000);
    });

    test('應該拒絕無效的 access token', async () => {
      mockRequest.json.mockResolvedValue({
        accessToken: 'invalid_token',
      });

      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toContain('Invalid access token');
      expect(data.valid).toBe(false);
    });

    test('應該拒絕屬於其他 Channel 的 token', async () => {
      mockRequest.json.mockResolvedValue({
        accessToken: 'other_channel_token',
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          client_id: '9999999999', // 不同的 channel ID
          expires_in: 2592000,
        }),
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toContain('Token does not belong to this channel');
      expect(data.valid).toBe(false);
    });
  });

  describe('錯誤處理', () => {
    test('應該處理網路錯誤', async () => {
      mockRequest.json.mockResolvedValue({
        accessToken: 'test_token',
      });

      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Internal server error');
      expect(data.details).toContain('Network error');
    });

    test('應該處理 LINE API 回應錯誤', async () => {
      mockRequest.json.mockResolvedValue({
        accessToken: 'test_token',
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Internal server error');
    });
  });

  describe('邊界情況', () => {
    test('應該處理過期的 token', async () => {
      mockRequest.json.mockResolvedValue({
        accessToken: 'expired_token',
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          client_id: '2008401529',
          expires_in: 0, // 已過期
        }),
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.expiresIn).toBe(0);
      // Note: 實際應用可能需要額外檢查 expires_in
    });

    test('應該處理超長的 access token', async () => {
      const longToken = 'a'.repeat(10000);

      mockRequest.json.mockResolvedValue({
        accessToken: longToken,
      });

      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      const response = await POST(mockRequest);

      expect(response.status).toBe(401);
    });
  });
});
