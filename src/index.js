const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod/v4');
const axios = require('axios');
const { spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');

// 创建MCP服务器
const server = new McpServer({
  name: 'csmar-server',
  version: '1.0.0',
  description: 'MCP server for CSMAR (China Stock Market & Accounting Research) database',
});

// CSMAR API配置
const CSMAR_API_BASE = process.env.CSMAR_API_BASE || 'https://api.gtarsc.com';
const CSMAR_API_KEY = process.env.CSMAR_API_KEY;

// CSMAR Python客户端配置
const CSMAR_USERNAME = process.env.CSMAR_USERNAME;
const CSMAR_PASSWORD = process.env.CSMAR_PASSWORD;
const CSMAR_LANG = process.env.CSMAR_LANG || '0'; // 0=中文, 1=英文
const PYTHON_CLIENT_PATH = path.join(__dirname, 'python_client.py');

// Python客户端调用函数
async function callPythonClient(action, params = {}) {
  return new Promise((resolve, reject) => {
    const command = {
      action,
      params
    };

    const pythonProcess = spawn('python', [PYTHON_CLIENT_PATH], {
      stdio: ['pipe', 'pipe', 'inherit']
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python进程退出代码 ${code}: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (error) {
        reject(new Error(`JSON解析失败: ${error.message}, 输出: ${stdout.substring(0, 200)}`));
      }
    });

    pythonProcess.on('error', (error) => {
      reject(new Error(`启动Python进程失败: ${error.message}`));
    });

    // 发送命令到标准输入
    pythonProcess.stdin.write(JSON.stringify(command));
    pythonProcess.stdin.end();
  });
}

// 检查Python客户端可用性
async function checkPythonClient() {
  try {
    const result = await callPythonClient('check_availability', {});
    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message,
      csmar_available: false
    };
  }
}

// 检查登录状态
async function checkLoginStatus() {
  try {
    const result = await callPythonClient('check_availability', {});
    return {
      success: result.success === true,
      csmar_available: result.csmar_available === true,
      logged_in: result.client_logged_in === true,
      username: result.username,
      message: result.message || '检查登录状态成功'
    };
  } catch (error) {
    return {
      success: false,
      error: `检查登录状态失败: ${error.message}`,
      csmar_available: false,
      logged_in: false
    };
  }
}

// 登录CSMAR（智能处理）
async function ensureLogin() {
  // 首先检查当前登录状态
  const status = await checkLoginStatus();

  // 如果CSMAR SDK不可用
  if (!status.csmar_available) {
    return {
      success: false,
      error: 'CSMAR SDK不可用，请检查安装和配置'
    };
  }

  // 如果已经登录
  if (status.logged_in) {
    return {
      success: true,
      message: '已登录（通过token.txt）',
      username: status.username
    };
  }

  // 未登录，检查是否有凭据
  if (!CSMAR_USERNAME || !CSMAR_PASSWORD) {
    return {
      success: false,
      error: '未登录且未配置CSMAR用户名和密码，请设置CSMAR_USERNAME和CSMAR_PASSWORD环境变量'
    };
  }

  // 尝试使用凭据登录
  try {
    const result = await callPythonClient('login', {
      account: CSMAR_USERNAME,
      pwd: CSMAR_PASSWORD,
      lang: CSMAR_LANG
    });
    return result;
  } catch (error) {
    return {
      success: false,
      error: `登录失败: ${error.message}`
    };
  }
}

// 注册财务数据获取工具
server.registerTool(
  'get_financial_data',
  {
    description: '获取CSMAR财务数据',
    inputSchema: {
      stock_code: z.string().describe('股票代码'),
      start_date: z.string().describe('开始日期 (YYYY-MM-DD)'),
      end_date: z.string().describe('结束日期 (YYYY-MM-DD)'),
      indicators: z.array(z.string()).optional().describe('财务指标列表'),
    },
  },
  async ({ stock_code, start_date, end_date, indicators = [] }) => {
    try {
      // 确保已登录
      const loginResult = await ensureLogin();
      if (!loginResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(loginResult, null, 2)
            }
          ],
          isError: true
        };
      }

      // 构建查询条件 - 尝试查询财务报表
      // 默认使用FS_Combas表（合并资产负债表）
      const tableName = "FS_Combas";
      const condition = `Stkcd='${stock_code}' AND Accper>='${start_date}' AND Accper<='${end_date}'`;

      // 如果指定了指标，使用它们作为列，否则使用常见财务指标
      const columns = indicators.length > 0 ? indicators : [
        'Stkcd', 'ShortName', 'Accper', 'Typrep', 'A001000000', 'A002000000'
      ];

      const result = await callPythonClient('query', {
        table_name: tableName,
        columns: columns,
        condition: condition,
        start_time: start_date,
        end_time: end_date,
        format: 'json'
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `获取财务数据错误: ${error.message}\n\n提示：您也可以直接使用 csmar_query 工具查询特定表`
          }
        ],
        isError: true
      };
    }
  }
);

// 注册股票数据获取工具
server.registerTool(
  'get_stock_data',
  {
    description: '获取CSMAR股票交易数据',
    inputSchema: {
      stock_code: z.string().describe('股票代码'),
      start_date: z.string().describe('开始日期 (YYYY-MM-DD)'),
      end_date: z.string().describe('结束日期 (YYYY-MM-DD)'),
      frequency: z.enum(['daily', 'weekly', 'monthly']).optional().describe('数据频率'),
    },
  },
  async ({ stock_code, start_date, end_date, frequency = 'daily' }) => {
    try {
      // 确保已登录
      const loginResult = await ensureLogin();
      if (!loginResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(loginResult, null, 2)
            }
          ],
          isError: true
        };
      }

      // 根据频率选择表名
      let tableName;
      switch (frequency) {
        case 'daily':
          tableName = "Trd_Dalyr"; // 股票日行情表
          break;
        case 'weekly':
          tableName = "Trd_Week"; // 股票周行情表（假设）
          break;
        case 'monthly':
          tableName = "Trd_Month"; // 股票月行情表（假设）
          break;
        default:
          tableName = "Trd_Dalyr";
      }

      const condition = `Stkcd='${stock_code}' AND Trddt>='${start_date}' AND Trddt<='${end_date}'`;

      // 常用股票交易字段
      const columns = [
        'Stkcd', 'ShortName', 'Trddt', 'Opnprc', 'Hiprc', 'Loprc', 'Clsprc',
        'Dnshrtrd', 'Dnvaltrd', 'Adjprcwd', 'Adjprcnd'
      ];

      const result = await callPythonClient('query', {
        table_name: tableName,
        columns: columns,
        condition: condition,
        start_time: start_date,
        end_time: end_date,
        format: 'json'
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `获取股票数据错误: ${error.message}\n\n提示：您也可以直接使用 csmar_query 工具查询特定表`
          }
        ],
        isError: true
      };
    }
  }
);

// 注册公司信息工具
server.registerTool(
  'get_company_info',
  {
    description: '获取公司基本信息',
    inputSchema: {
      stock_code: z.string().describe('股票代码'),
    },
  },
  async ({ stock_code }) => {
    try {
      // 确保已登录
      const loginResult = await ensureLogin();
      if (!loginResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(loginResult, null, 2)
            }
          ],
          isError: true
        };
      }

      // 查询公司基本信息表
      const tableName = "上市公司基本信息"; // 或 Company_Info
      const condition = `Stkcd='${stock_code}'`;

      // 常用公司信息字段
      const columns = [
        'Stkcd', 'ShortName', 'FullName', 'EngName', 'Listdt',
        'Industry', 'Province', 'City', 'Address', 'Postcode',
        'Phone', 'Fax', 'Email', 'Website', 'LegalRepresentative',
        'RegisteredCapital', 'PaidinCapital'
      ];

      const result = await callPythonClient('query', {
        table_name: tableName,
        columns: columns,
        condition: condition,
        format: 'json'
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `获取公司信息错误: ${error.message}\n\n提示：您也可以直接使用 csmar_query 工具查询特定表`
          }
        ],
        isError: true
      };
    }
  }
);

// 注册资源：数据库列表
server.registerResource(
  'csmar://databases',
  'csmar-databases',
  { description: 'CSMAR可用数据库列表' },
  async (uri) => {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({
            databases: [
              { id: 'stock', name: '股票数据', description: '股票交易数据' },
              { id: 'financial', name: '财务数据', description: '财务报表数据' },
              { id: 'company', name: '公司信息', description: '公司基本信息' },
            ],
            message: '需要配置CSMAR API获取真实数据'
          }, null, 2)
        }
      ]
    };
  }
);

// ==================== 通用CSMAR工具 ====================

// 1. 登录工具（如果未通过环境变量自动登录）
server.registerTool(
  'csmar_login',
  {
    description: '登录CSMAR账户',
    inputSchema: {
      account: z.string().describe('用户名/已验证电话/已验证邮箱'),
      pwd: z.string().describe('密码'),
      lang: z.enum(['0', '1']).optional().describe('语言: 0=中文, 1=英文'),
    },
  },
  async ({ account, pwd, lang = '0' }) => {
    try {
      const result = await callPythonClient('login', { account, pwd, lang });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `登录错误: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// 2. 列出数据库
server.registerTool(
  'csmar_list_databases',
  {
    description: '列出用户有权访问的CSMAR数据库',
    inputSchema: {},
  },
  async () => {
    try {
      // 确保已登录
      const loginResult = await ensureLogin();
      if (!loginResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(loginResult, null, 2)
            }
          ],
          isError: true
        };
      }

      const result = await callPythonClient('list_databases', {});

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `获取数据库列表错误: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// 3. 列出数据库中的表
server.registerTool(
  'csmar_list_tables',
  {
    description: '列出指定数据库中的所有表',
    inputSchema: {
      database_name: z.string().describe('数据库名称'),
    },
  },
  async ({ database_name }) => {
    try {
      // 确保已登录
      const loginResult = await ensureLogin();
      if (!loginResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(loginResult, null, 2)
            }
          ],
          isError: true
        };
      }

      const result = await callPythonClient('list_tables', { database_name });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `获取表列表错误: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// 4. 列出表中的字段
server.registerTool(
  'csmar_list_fields',
  {
    description: '列出指定表中的所有字段',
    inputSchema: {
      table_name: z.string().describe('表名称'),
    },
  },
  async ({ table_name }) => {
    try {
      // 确保已登录
      const loginResult = await ensureLogin();
      if (!loginResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(loginResult, null, 2)
            }
          ],
          isError: true
        };
      }

      const result = await callPythonClient('list_fields', { table_name });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `获取字段列表错误: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// 5. 通用查询工具
server.registerTool(
  'csmar_query',
  {
    description: '通用CSMAR数据查询',
    inputSchema: {
      table_name: z.string().describe('表名称'),
      columns: z.array(z.string()).optional().describe('要查询的字段列表（默认所有字段）'),
      condition: z.string().optional().describe('查询条件（类似SQL WHERE子句）'),
      start_time: z.string().optional().describe('开始时间 (YYYY-MM-DD)'),
      end_time: z.string().optional().describe('结束时间 (YYYY-MM-DD)'),
      limit: z.number().optional().describe('返回记录数限制'),
      format: z.enum(['json', 'dataframe']).optional().describe('返回格式'),
    },
  },
  async ({ table_name, columns = [], condition = '', start_time, end_time, limit, format = 'json' }) => {
    try {
      // 确保已登录
      const loginResult = await ensureLogin();
      if (!loginResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(loginResult, null, 2)
            }
          ],
          isError: true
        };
      }

      const result = await callPythonClient('query', {
        table_name,
        columns,
        condition,
        start_time,
        end_time,
        limit,
        format
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `查询错误: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// 6. 预览表数据
server.registerTool(
  'csmar_preview',
  {
    description: '预览表数据（前几行）',
    inputSchema: {
      table_name: z.string().describe('表名称'),
    },
  },
  async ({ table_name }) => {
    try {
      // 确保已登录
      const loginResult = await ensureLogin();
      if (!loginResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(loginResult, null, 2)
            }
          ],
          isError: true
        };
      }

      const result = await callPythonClient('preview', { table_name });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `预览错误: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// 7. 查询记录数
server.registerTool(
  'csmar_query_count',
  {
    description: '查询满足条件的记录数量',
    inputSchema: {
      table_name: z.string().describe('表名称'),
      columns: z.array(z.string()).optional().describe('字段列表'),
      condition: z.string().optional().describe('查询条件'),
      start_time: z.string().optional().describe('开始时间 (YYYY-MM-DD)'),
      end_time: z.string().optional().describe('结束时间 (YYYY-MM-DD)'),
    },
  },
  async ({ table_name, columns = [], condition = '', start_time, end_time }) => {
    try {
      // 确保已登录
      const loginResult = await ensureLogin();
      if (!loginResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(loginResult, null, 2)
            }
          ],
          isError: true
        };
      }

      const result = await callPythonClient('query_count', {
        table_name,
        columns,
        condition,
        start_time,
        end_time
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `查询数量错误: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// ==================== 现有工具增强 ====================
// 注意：现有工具保持原样，但可以修改为使用通用查询

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('CSMAR MCP server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});