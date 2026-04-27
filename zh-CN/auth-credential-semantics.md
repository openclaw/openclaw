# 认证凭证语义

本文档定义了跨以下模块使用的规范化凭证资格和解析语义：

- `resolveAuthProfileOrder`
- `resolveApiKeyForProfile`
- `models status --probe`
- `doctor-auth`

目标是保持选择时行为和运行时行为一致。

## 稳定的 Reason Codes

- `ok`
- `missing_credential`
- `invalid_expires`
- `expired`
- `unresolved_ref`

## Token 凭证

Token 凭证（`type: "token"`）支持内联 `token` 和/或 `tokenRef`。

### 资格规则

1. 当 `token` 和 `tokenRef` 都不存在时，token 配置檔不符合资格。
2. `expires` 是可选的。
3. 如果存在 `expires`，它必须是大于 0 的有限数字。
4. 如果 `expires` 无效（`NaN`、0、负数、非有限值或类型错误），则该配置檔因 `invalid_expires` 不符合资格。
5. 如果 `expires` 已过期，则该配置檔因 `expired` 不符合资格。
6. `tokenRef` 不会绕过 `expires` 验证。

### 解析规则

1. 解析器的 `expires` 语义与资格语义匹配。
2. 对于符合条件的配置檔，token 内容可以从内联值或 `tokenRef` 解析。
3. 无法解析的引用会在 `models status --probe` 输出中产生 `unresolved_ref`。

## 兼容旧版的消息

为保持脚本兼容性，探测错误的第一行保持不变：

`Auth profile credentials are missing or expired.`

后续行可以添加人类可读的详细信息和稳定的 reason codes。