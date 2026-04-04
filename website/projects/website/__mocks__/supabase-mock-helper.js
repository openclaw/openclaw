/**
 * Supabase Mock Helper
 *
 * 用於建立可正確 chain 的 Supabase client mock
 */

export function createMockSupabaseClient() {
  const mockClient = {
    // 儲存 mock 狀態
    _mockState: {
      queryResult: null,
      insertResult: null,
      updateResult: null,
    },

    // from() 方法
    from: jest.fn(function(tableName) {
      return {
        // SELECT chain
        select: jest.fn(function(columns) {
          return {
            eq: jest.fn(function(column, value) {
              return {
                single: jest.fn(function() {
                  return Promise.resolve(mockClient._mockState.queryResult || { data: null, error: null });
                }),
              };
            }),
          };
        }),

        // INSERT chain
        insert: jest.fn(function(data) {
          return Promise.resolve(mockClient._mockState.insertResult || { data: null, error: null });
        }),

        // UPDATE chain
        update: jest.fn(function(data) {
          return {
            eq: jest.fn(function(column, value) {
              return Promise.resolve(mockClient._mockState.updateResult || { data: null, error: null });
            }),
          };
        }),
      };
    }),

    // Auth admin methods
    auth: {
      admin: {
        createUser: jest.fn(),
        deleteUser: jest.fn(),
        generateLink: jest.fn(),
      },
    },

    // Helper methods for setting mock responses
    _setQueryResult: function(result) {
      this._mockState.queryResult = result;
      return this;
    },

    _setInsertResult: function(result) {
      this._mockState.insertResult = result;
      return this;
    },

    _setUpdateResult: function(result) {
      this._mockState.updateResult = result;
      return this;
    },

    _reset: function() {
      this._mockState = {
        queryResult: null,
        insertResult: null,
        updateResult: null,
      };
      jest.clearAllMocks();
      return this;
    },
  };

  return mockClient;
}
