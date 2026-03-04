# Polymarket 集成配置

## 状态
- **配置时间**：2026-03-01 10:18 UTC
- **状态**：✅ 密钥已安全保存
- **存储位置**：`.secrets/polymarket.env`

## 安全措施
- [x] 文件权限设置为 600
- [x] 已添加到 .gitignore
- [x] 使用环境变量，不硬编码
- [ ] 需要定期检查密钥安全性

## 使用规范
1. **永远不要**在前端代码中使用私钥
2. **永远不要**提交 .secrets 目录到 Git
3. 使用时先 `source .secrets/polymarket.env`
4. 怀疑泄露时立即转移资产并重新生成密钥

## 相关资源
- Polymarket API 文档：https://docs.polymarket.com/
- 钱包地址：0x3a022c81d06c9c907d6fcc7ddd846083bfc3bd33

---

*最后更新：2026-03-01*
