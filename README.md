# CSMAR MCP 服务器

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-blue)](https://spec.modelcontextprotocol.io)

国泰安（CSMAR）金融数据库的 Model Context Protocol (MCP) 服务器，支持在 Claude Code 中直接访问 CSMAR 金融数据。

## ✨ 功能特性

- **完整的 CSMAR 数据访问**：支持 240+ 个数据库，包括财务报表、股票交易、公司信息等
- **智能登录管理**：支持环境变量自动登录和令牌缓存
- **10 个 MCP 工具**：涵盖数据库探索、数据查询、预览等全功能
- **Python 中间层**：基于 CSMAR-PYTHON SDK 的稳定封装
- **配置简单**：一键式配置，支持 Claude Code 原生集成

## 📋 前提条件

1. **CSMAR 账号**：有效的 CSMAR（国泰安）机构账号（个人或机构账号均可）
2. **Python 3.8+**：需要安装 CSMAR-PYTHON SDK 及其依赖
   - 安装 Python 依赖：`pip install urllib3 websocket websocket_client pandas prettytable`
   - 下载并安装 CSMAR-PYTHON SDK（从官网或联系 CSMAR 获取）
3. **Node.js 18+**：运行 MCP 服务器
4. **Claude Code**：最新版本的 Claude Code 编辑器

## 🚀 快速开始

### 1. 克隆项目
```bash
git clone https://github.com/yourusername/csmar-mcp-server.git
cd csmar-mcp-server
```

### 2. 安装依赖
```bash
# 安装Node.js依赖
npm install

# 安装Python依赖（CSMAR SDK所需）
pip install urllib3 websocket websocket_client pandas prettytable

# 安装CSMAR-PYTHON SDK
# 从CSMAR官网下载SDK压缩包，解压到Python的site-packages目录
# 或者按照官方文档安装：https://www.gtadata.com/products/csmar-api
```

### 3. 配置环境变量
复制配置文件模板：
```bash
cp config/.env.example .env
```

编辑 `.env` 文件，填入你的 CSMAR 账号信息：
```env
CSMAR_API_BASE=https://api.gtarsc.com
CSMAR_API_KEY=你的API密钥（如有）
CSMAR_USERNAME=你的CSMAR用户名
CSMAR_PASSWORD=你的CSMAR密码
CSMAR_LANG=0  # 0=中文, 1=英文
```

### 4. 配置 Claude Code
在 Claude Code 的配置文件中添加 MCP 服务器配置：

**Windows** (`%APPDATA%/Claude/claude_desktop_config.json`):
**macOS/Linux** (`~/.config/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "csmar": {
      "command": "node",
      "args": ["/path/to/csmar-mcp-server/src/index.js"],
      "env": {
        "CSMAR_API_BASE": "https://api.gtarsc.com",
        "CSMAR_USERNAME": "你的CSMAR用户名",
        "CSMAR_PASSWORD": "你的CSMAR密码",
        "CSMAR_LANG": "0"
      }
    }
  }
}
```

### 5. 重启 Claude Code
重启 Claude Code 以加载 MCP 服务器。

## 🔧 使用方法

### 验证安装
在 Claude Code 中运行：
```python
mcp__csmar__csmar_list_databases()
```

如果看到数据库列表，说明安装成功！

### 基本数据探索
```python
# 列出所有可用数据库（约240个）
mcp__csmar__csmar_list_databases()

# 查看"财务报表"数据库中的表
mcp__csmar__csmar_list_tables(database_name="财务报表")

# 查看"FS_Combas"表的字段
mcp__csmar__csmar_list_fields(table_name="FS_Combas")

# 预览表数据（前几行）
mcp__csmar__csmar_preview(table_name="FS_Combas")
```

### 数据查询示例
```python
# 查询财务报表数据
mcp__csmar__csmar_query(
    table_name="FS_Combas",
    columns=["Stkcd", "ShortName", "Accper", "Typrep", "A001000000"],
    condition="Stkcd like '3%' and Typrep='A'",
    start_time="2020-01-01",
    end_time="2021-12-31",
    limit=5
)

# 查询记录数量
mcp__csmar__csmar_query_count(
    table_name="FS_Combas",
    condition="Stkcd like '3%'",
    start_time="2020-01-01",
    end_time="2021-12-31"
)
```

## 🛠️ 可用工具

| 工具名称 | 描述 | 参数 |
|---------|------|------|
| `csmar_login` | 登录 CSMAR 账户 | `account`, `pwd`, `lang` |
| `csmar_list_databases` | 列出可访问的数据库 | 无 |
| `csmar_list_tables` | 列出数据库中的表 | `database_name` |
| `csmar_list_fields` | 列出表中的字段 | `table_name` |
| `csmar_query` | 通用数据查询 | `table_name`, `columns`, `condition`, `start_time`, `end_time`, `limit`, `format` |
| `csmar_preview` | 预览表数据 | `table_name` |
| `csmar_query_count` | 查询记录数量 | `table_name`, `columns`, `condition`, `start_time`, `end_time` |
| `get_stock_data` | 获取股票交易数据 | `stock_code`, `start_date`, `end_date`, `frequency` |
| `get_financial_data` | 获取财务数据 | `stock_code`, `start_date`, `end_date`, `indicators` |
| `get_company_info` | 获取公司基本信息 | `stock_code` |

## 📁 项目结构

```
csmar-mcp-server/
├── src/
│   ├── index.js              # MCP 服务器主文件
│   └── python_client.py      # Python 客户端
├── config/
│   ├── .env.example          # 环境变量示例
│   └── .mcp.json             # MCP 配置示例
├── docs/
│   ├── CSMAR_MCP_配置完成报告.md
│   ├── 快速开始指南.md
│   └── CSMAR机构账号配置指南.md
├── examples/
│   └── test_input.json       # 测试输入示例
├── package.json              # Node.js 依赖
├── README.md                 # 本文件
└── .gitignore               # Git 忽略文件
```

## 🔍 数据库推荐

### 常用数据库
- **财务报表**：`财务报表`, `FS_Combas`, `FS_Comins`, `FS_Comscfd`
- **股票交易**：`股票市场交易数据`, `股票日行情`
- **公司信息**：`公司基本信息`, `上市公司基本信息`
- **宏观经济**：`宏观经济数据库`

### 数据时间范围
- **财务报表**：2018-2022 年
- **AI 相关数据**：2024-2025 年
- **股票交易**：实时更新

## ⚠️ 注意事项

### 查询限制
- **每次最多 20 万条记录**：大数据集需要分页查询
- **相同条件 30 分钟限流**：避免频繁查询相同条件
- **时间格式**：必须使用 "YYYY-MM-DD" 格式

### 分页查询示例
```python
# 第1页
条件 = "Stkcd like '3%' limit 0,200000"
# 第2页
条件 = "Stkcd like '3%' limit 200000,200000"

mcp__csmar__csmar_query(
    table_name="FS_Combas",
    columns=["Stkcd", "ShortName", "Accper", "Typrep"],
    condition=条件
)
```

## 🐛 故障排除

### 常见问题

#### 1. "MCP 服务器未响应"
- 确认 Claude Code 已重启
- 检查 `.mcp.json` 文件路径
- 手动测试 Python 客户端：
  ```bash
  echo '{"action":"list_databases","params":{}}' | python src/python_client.py
  ```

#### 2. "数据库不存在"
- 使用 `csmar_list_databases()` 获取准确名称
- 检查数据库名称是否包含空格
- 确认账号有该数据库访问权限

#### 3. 查询结果为空
- 检查时间范围是否正确
- 验证查询条件语法
- 使用 `preview()` 先查看数据格式

#### 4. CSMAR SDK 导入失败
- 确认 CSMAR-PYTHON SDK 已正确安装
- 检查 Python 路径配置
- 查看 `src/python_client.py` 中的路径设置

### 日志文件
- **CSMAR 日志**：`csmar-log.log`
- **Python 客户端日志**：通过 stderr 输出
- **MCP 服务器日志**：通过 stderr 输出

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🙏 致谢

- **CSMAR（国泰安）**：提供金融数据服务
- **Anthropic**：开发 Model Context Protocol
- **Claude Code**：优秀的 AI 编程环境

## 📞 支持

- **CSMAR 官方支持**：service@gtadata.com，400-888-3636
- **项目 Issues**：[GitHub Issues](https://github.com/yourusername/csmar-mcp-server/issues)
- **文档**：查看 `docs/` 目录下的详细指南

---

**💡 提示**：开始使用前，请确保已正确配置 CSMAR 账号和环境变量！